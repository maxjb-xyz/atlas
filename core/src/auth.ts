// Sign-in (§20, §22). The owner signs in with a passkey. The owner secret,
// set at deploy, is the setup code: it adds the first passkey, gets the
// owner back in if every passkey is lost, and works as a bearer token for
// scripts. Either way the browser gets a session: a random id, signed, that
// the owner's agent keeps a record of. Signing out ends it, and removing a
// passkey ends every session it opened, so a lost device can be cut off.

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { loginOptions, registrationOptions, type StoredPasskey, verifyLogin, verifyRegistration } from "./passkeys";

const COOKIE = "atlas_session";
/** Set by the Worker on a socket it lets through: the session that opened it. */
export const SESSION_HEADER = "x-atlas-session";
export const SESSION_DAYS = 30;
/** Adding a passkey when one already exists takes a sign-in this recent, or the setup code. */
export const RECENT_SIGN_IN_MS = 10 * 60_000;
/** Setup codes shorter than this are refused: a short code can be guessed. */
export const MIN_CODE = 16;
const enc = new TextEncoder();

export interface Session {
  kind: "passkey" | "code";
  passkey_id?: string;
  at: number;
  expires: number;
}

/** What sign-in needs from the owner's agent, which keeps passkeys, challenges and sessions. */
export interface AuthStore {
  passkeys(): Promise<StoredPasskey[]>;
  /** Adds one passkey (never writes the whole list, so two changes can't undo each other). */
  addPasskey(p: StoredPasskey): Promise<void>;
  /** Records a sign-in with a passkey. Null if it was removed meanwhile. */
  usePasskey(id: string, counter: number): Promise<StoredPasskey | null>;
  putChallenge(value: string, kind: "register" | "login"): Promise<void>;
  /** Takes one challenge by its value, so a stranger's request can't use up the owner's. */
  takeChallenge(value: string): Promise<{ kind: "register" | "login"; expires: number } | null>;
  openSession(s: { kind: Session["kind"]; passkey_id?: string }): Promise<string>;
  session(id: string): Promise<Session | null>;
  closeSession(id: string): Promise<void>;
  /** How long until the setup code may be tried again, in ms; 0 means now. */
  codeWait(): Promise<number>;
  codeTried(ok: boolean): Promise<void>;
  ownerName(): Promise<string>;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(`atlas-session:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
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

/** A new session id, random. */
export function newSessionId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(18)));
}

/** The cookie value: the session id, signed with the setup code, so a forged id is turned away before the agent is asked. */
export async function signSession(secret: string, id: string): Promise<string> {
  return `${id}.${b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(id)))}`;
}

/** The session id in a cookie value, if its signature holds. */
export async function readSession(secret: string, value: string): Promise<string | null> {
  const [id, sig] = value.split(".");
  if (!id || !sig) return null;
  try {
    return (await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(id))) ? id : null;
  } catch {
    return null;
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

export type Who = { via: "bearer" } | { via: "session"; id: string; session: Session };

/** Why the setup code can't be used as it is, if it can't. */
export function codeProblem(env: Env): string | null {
  const secret = env.ATLAS_OWNER_SECRET;
  if (!secret) return "This deployment has no setup code yet. Set ATLAS_OWNER_SECRET on your Worker.";
  if (secret.length < MIN_CODE) {
    return `The setup code (ATLAS_OWNER_SECRET) is ${secret.length} characters; it needs at least ${MIN_CODE}. Set a longer one and reload.`;
  }
  return null;
}

/** Checks the setup code, with a wait after wrong guesses. */
async function checkCode(
  env: Env,
  store: AuthStore,
  given: unknown,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const problem = codeProblem(env);
  if (problem) return { ok: false, status: 503, message: problem };
  const wait = await store.codeWait();
  if (wait > 0) return { ok: false, status: 429, message: `Too many wrong setup codes. Try again in ${Math.ceil(wait / 1000)} seconds.` };
  const ok = typeof given === "string" && (await sameSecret(given, env.ATLAS_OWNER_SECRET!));
  await store.codeTried(ok);
  return ok ? { ok: true } : { ok: false, status: 401, message: "That isn't the setup code." };
}

/** Who's asking: the owner by a live session, a script with the setup code as a bearer token, or nobody. */
export async function owner(request: Request, env: Env, store: () => Promise<AuthStore>): Promise<Who | null> {
  if (codeProblem(env)) return null;
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return (await checkCode(env, await store(), auth.slice(7))).ok ? { via: "bearer" } : null;
  const value = cookieValue(request);
  const id = value ? await readSession(env.ATLAS_OWNER_SECRET!, value) : null;
  if (!id) return null;
  const session = await (await store()).session(id);
  return session ? { via: "session", id, session } : null;
}

/** Blocks cross-site requests: a browser must be on this same origin. */
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

async function cookieFor(env: Env, request: Request, id: string): Promise<string> {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${await signSession(env.ATLAS_OWNER_SECRET!, id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}${secure}`;
}

/** A passkey answer has the fields WebAuthn always sends; anything else is refused before a challenge is touched. */
function looksLikeCredential(v: unknown): boolean {
  const r = v as { id?: unknown; rawId?: unknown; type?: unknown; response?: { clientDataJSON?: unknown } } | null;
  return Boolean(
    r &&
    typeof r.id === "string" &&
    typeof r.rawId === "string" &&
    r.type === "public-key" &&
    typeof r.response?.clientDataJSON === "string",
  );
}

export async function handleAuth(request: Request, env: Env, path: string, store: () => Promise<AuthStore>): Promise<Response | null> {
  if (request.method === "POST" && !sameOrigin(request)) return json({ error: "Wrong origin." }, { status: 403 });

  if (path === "/api/session" && request.method === "GET") {
    const problem = codeProblem(env);
    return json({
      configured: !problem,
      ...(problem ? { problem } : {}),
      signed_in: Boolean(await owner(request, env, store)),
      has_passkeys: problem ? false : (await (await store()).passkeys()).length > 0,
    });
  }

  if (path === "/api/login" && request.method === "POST") {
    const s = await store();
    const body = (await request.json().catch(() => ({}))) as { secret?: unknown };
    const code = await checkCode(env, s, body.secret);
    if (!code.ok) return json({ error: code.message }, { status: code.status });
    const id = await s.openSession({ kind: "code" });
    return new Response(null, { status: 204, headers: { "set-cookie": await cookieFor(env, request, id) } });
  }

  if (path === "/api/logout" && request.method === "POST") {
    const who = await owner(request, env, store);
    if (who?.via === "session") await (await store()).closeSession(who.id);
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` },
    });
  }

  if (!path.startsWith("/api/passkey/")) return null;
  const problem = codeProblem(env);
  if (problem) return json({ error: problem }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { secret?: unknown; response?: unknown; name?: unknown };
  const s = await store();

  if (path === "/api/passkey/register/options" && request.method === "POST") {
    // Adding a passkey takes the setup code (which also signs you in), or a recent sign-in.
    let cookie: string | null = null;
    if (body.secret !== undefined) {
      const code = await checkCode(env, s, body.secret);
      if (!code.ok) return json({ error: code.message }, { status: code.status });
      cookie = await cookieFor(env, request, await s.openSession({ kind: "code" }));
    } else {
      const who = await owner(request, env, store);
      if (!who) return json({ error: "Sign in first." }, { status: 401 });
      const existing = (await s.passkeys()).length;
      if (existing && who.via === "session" && Date.now() - who.session.at > RECENT_SIGN_IN_MS) {
        return json({ error: "To add another passkey, enter your setup code, or sign in again first." }, { status: 403 });
      }
    }
    const options = await registrationOptions(s, request);
    return json(options, cookie ? { headers: { "set-cookie": cookie } } : {});
  }

  if (path === "/api/passkey/register/verify" && request.method === "POST") {
    if (!(await owner(request, env, store))) return json({ error: "Sign in first." }, { status: 401 });
    if (!looksLikeCredential(body.response)) return json({ error: "That isn't a passkey answer." }, { status: 400 });
    const out = await verifyRegistration(
      s,
      request,
      body.response as RegistrationResponseJSON,
      typeof body.name === "string" ? body.name : "",
    );
    return out.ok ? json({ name: out.passkey.name }) : json({ error: out.message }, { status: out.status });
  }

  if (path === "/api/passkey/login/options" && request.method === "POST") {
    if (!(await s.passkeys()).length) return json({ error: "There's no passkey yet. Use your setup code." }, { status: 404 });
    return json(await loginOptions(s, request));
  }

  if (path === "/api/passkey/login/verify" && request.method === "POST") {
    if (!looksLikeCredential(body.response)) return json({ error: "That isn't a passkey answer." }, { status: 400 });
    const out = await verifyLogin(s, request, body.response as AuthenticationResponseJSON);
    if (!out.ok) return json({ error: out.message }, { status: out.status });
    const id = await s.openSession({ kind: "passkey", passkey_id: out.passkey.id });
    return new Response(null, { status: 204, headers: { "set-cookie": await cookieFor(env, request, id) } });
  }

  return json({ error: "Not found." }, { status: 404 });
}
