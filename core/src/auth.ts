// M0 sign-in: one owner secret, set at deploy time with
// `wrangler secret put ATLAS_OWNER_SECRET`. The app trades it once for a
// signed session cookie. Passkeys replace this in M1 setup (§22).

const COOKIE = "atlas_session";
const SESSION_DAYS = 30;
const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(`atlas-session:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function fromB64url(s: string): Uint8Array {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Compares in constant time, so the secret can't be guessed a character at a time. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function makeSession(secret: string, now = Date.now()): Promise<string> {
  const exp = String(now + SESSION_DAYS * 86_400_000);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(exp));
  return `${exp}.${b64url(sig)}`;
}

export async function checkSession(secret: string, value: string, now = Date.now()): Promise<boolean> {
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(exp));
  } catch {
    return false;
  }
}

function cookieValue(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === COOKIE) return part.slice(eq + 1);
  }
  return null;
}

/** True for the owner: a valid session cookie, or the secret itself as a bearer token (for the benchmark and scripts). */
export async function isOwner(request: Request, env: Env): Promise<boolean> {
  const secret = env.ATLAS_OWNER_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return sameSecret(auth.slice(7), secret);
  const cookie = cookieValue(request);
  return cookie ? checkSession(secret, cookie) : false;
}

/** Blocks cross-site WebSocket hijacking: a browser socket must come from this same origin. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Not a browser (the benchmark, scripts).
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response | null> {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  if (path === "/api/session" && request.method === "GET") {
    return json({ configured: Boolean(env.ATLAS_OWNER_SECRET), signed_in: await isOwner(request, env) });
  }
  if (path === "/api/login" && request.method === "POST") {
    const secret = env.ATLAS_OWNER_SECRET;
    if (!secret) return json({ error: "ATLAS_OWNER_SECRET isn't set on this deployment." }, { status: 503 });
    if (!sameOrigin(request)) return json({ error: "Wrong origin." }, { status: 403 });
    const body = (await request.json().catch(() => ({}))) as { secret?: unknown };
    if (typeof body.secret !== "string" || !(await sameSecret(body.secret, secret))) {
      return json({ error: "That isn't the owner secret." }, { status: 401 });
    }
    const value = await makeSession(secret);
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}${secure}`,
      },
    });
  }
  if (path === "/api/logout" && request.method === "POST") {
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` },
    });
  }
  return null;
}
