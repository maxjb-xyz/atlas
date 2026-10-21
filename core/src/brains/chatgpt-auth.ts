// "Sign in with ChatGPT" with ChatGPT plan usage (§18), the official way for
// open-source tools to run on a person's ChatGPT plan:
// https://developers.openai.com/siwc/token-sharing-open-source
//
// It's an OAuth flow with PKCE. OpenAI only redirects to a loopback address,
// and Atlas runs on Cloudflare, not on the owner's computer, so the last step
// is the owner pasting the address their browser landed on. OpenAI's guide
// for tools on remote machines does the same: sign in where the browser is,
// then hand the result to the host.

export const ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const RESOURCE = "https://api.openai.com/v1";
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
/** The scope that lets Atlas use the ChatGPT plan, not just know who signed in. */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** Used only for the first sign-in; OpenAI then issues Atlas its own client id for this owner. */
export const FIRST_CLIENT = "dynamic_agent_client";
export const APP_NAME = "Atlas";

/** Kept across sign-outs: the client id OpenAI issued, and this deployment's host id. */
export interface ChatGPTClient {
  client_id: string | null;
  /** A stable, opaque id for this Atlas deployment (`ext_agent_host_id`). */
  host_id: string;
  email: string | null;
  id_token: string | null;
  models: string[];
}

export interface ChatGPTLogin {
  state: string;
  nonce: string;
  verifier: string;
  client_id: string;
  url: string;
  expires_at: number;
}

export interface ChatGPTTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  client_id: string;
  email: string | null;
  scopes: string[];
  /** ms since epoch. */
  expires_at: number;
}

type Fetch = typeof fetch;

/** A failure the owner fixes by signing in again, with a plain reason. */
export class ChatGPTAuthError extends Error {}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export function newClient(): ChatGPTClient {
  return { client_id: null, host_id: `urn:uuid:${crypto.randomUUID()}`, email: null, id_token: null, models: [] };
}

/** Step 1: the address the owner opens to sign in and allow plan usage. */
export async function startLogin(client: ChatGPTClient): Promise<ChatGPTLogin> {
  const verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  const state = random(24);
  const nonce = random(24);
  const clientId = client.client_id ?? FIRST_CLIENT;
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
    ext_agent_host_id: client.host_id,
  });
  if (!client.client_id) params.set("agent_name_hint", APP_NAME);
  if (client.id_token) params.set("id_token_hint", client.id_token);
  if (client.email) params.set("login_hint", client.email);
  return { state, nonce, verifier, client_id: clientId, url: `${AUTHORIZE_URL}?${params}`, expires_at: Date.now() + 15 * 60_000 };
}

/** Reads the address the owner pasted: the full URL, or just its query. */
export function readCallback(pasted: string): URLSearchParams {
  const text = pasted.trim();
  const q = text.indexOf("?");
  return new URLSearchParams(q >= 0 ? text.slice(q + 1).split("#")[0] : text);
}

interface RawTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  scopes?: string[];
  error?: string;
  error_description?: string;
}

/** Step 2: trade the pasted callback for tokens, and check them. */
export async function finishLogin(pasted: string, login: ChatGPTLogin, f: Fetch = fetch): Promise<ChatGPTTokens> {
  if (Date.now() > login.expires_at) throw new ChatGPTAuthError("That sign-in took too long. Start again.");
  const p = readCallback(pasted);
  if (p.get("state") !== login.state) {
    throw new ChatGPTAuthError("That address isn't from this sign-in. Copy the address of the page you landed on after approving Atlas.");
  }
  if (p.get("error")) {
    throw new ChatGPTAuthError(
      p.get("error") === "access_denied"
        ? "Sign-in was cancelled in ChatGPT."
        : `ChatGPT said: ${p.get("error_description") ?? p.get("error")}`,
    );
  }
  const code = p.get("code");
  if (!code) throw new ChatGPTAuthError("That address has no sign-in code in it.");
  const clientId = p.get("client_id") ?? login.client_id;
  if (clientId === FIRST_CLIENT) throw new ChatGPTAuthError("ChatGPT didn't issue Atlas a client id. Start again.");

  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: login.verifier,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE,
    }).toString(),
  });
  const raw = (await res.json().catch(() => ({}))) as RawTokens;
  if (!res.ok) {
    if (raw.error === "invalid_grant") throw new ChatGPTAuthError("That sign-in code was already used or expired. Start again.");
    throw new ChatGPTAuthError(`ChatGPT sign-in couldn't finish (HTTP ${res.status}${raw.error ? `: ${raw.error}` : ""}).`);
  }
  const claims = await verifyIdToken(raw.id_token ?? "", { audience: clientId, nonce: login.nonce }, f);
  const tokens = toTokens(raw, clientId, typeof claims.email === "string" ? claims.email : null);
  if (!tokens.scopes.includes(PLAN_SCOPE)) {
    throw new ChatGPTAuthError("You signed in, but Atlas wasn't allowed to use your ChatGPT plan. Sign in again and allow it.");
  }
  return tokens;
}

const REFRESH_TERMINAL = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

/** Renews the hour-long access token. Throws ChatGPTAuthError when the owner has to sign in again. */
export async function refreshTokens(tokens: ChatGPTTokens, f: Fetch = fetch): Promise<ChatGPTTokens> {
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: tokens.client_id,
      refresh_token: tokens.refresh_token,
      resource: RESOURCE,
    }).toString(),
  });
  const raw = (await res.json().catch(() => ({}))) as RawTokens;
  if (!res.ok) {
    if ((raw.error && REFRESH_TERMINAL.has(raw.error)) || res.status === 401) {
      throw new ChatGPTAuthError("ChatGPT sign-in has expired. Sign in again in Settings → Brains.");
    }
    throw new Error(`ChatGPT token refresh failed (HTTP ${res.status}${raw.error ? `: ${raw.error}` : ""}).`);
  }
  return toTokens(
    { ...raw, refresh_token: raw.refresh_token ?? tokens.refresh_token, id_token: raw.id_token ?? tokens.id_token },
    tokens.client_id,
    tokens.email,
    tokens.scopes,
  );
}

function toTokens(raw: RawTokens, clientId: string, email: string | null, previousScopes: string[] = []): ChatGPTTokens {
  if (!raw.access_token || !raw.refresh_token) throw new ChatGPTAuthError("ChatGPT sign-in returned no tokens.");
  const fromAccess = jwtClaims(raw.access_token).scope;
  const scopes = raw.scopes ?? raw.scope?.split(" ") ?? (typeof fromAccess === "string" ? fromAccess.split(" ") : previousScopes);
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    id_token: raw.id_token ?? "",
    client_id: clientId,
    email,
    scopes,
    expires_at: Date.now() + (raw.expires_in ?? 3600) * 1000,
  };
}

/** The models this account can use through its plan. */
export async function listModels(accessToken: string, f: Fetch = fetch): Promise<string[]> {
  const res = await f(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { models?: unknown[]; data?: unknown[] };
  const out: string[] = [];
  for (const m of body.models ?? body.data ?? []) {
    const model = m as { slug?: string; id?: string; visibility?: string };
    if (model.visibility && model.visibility !== "list") continue;
    const id = model.slug ?? model.id;
    if (id) out.push(id);
  }
  return out;
}

// --- ID token checks ------------------------------------------------------------

/** Reads a JWT's claims without checking it. Only for tokens that came straight from OpenAI. */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(part))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

let jwksCache: { at: number; keys: JsonWebKey[] } | null = null;

/** OpenAI's published signing keys, cached for an hour, and fetched again when a token names a key not seen yet (a rotation). */
async function signingKeys(f: Fetch, kid?: string): Promise<JsonWebKey[]> {
  const fresh = jwksCache && Date.now() - jwksCache.at < 3_600_000;
  const known = !kid || jwksCache?.keys.some((k) => (k as { kid?: string }).kid === kid);
  if (fresh && known) return jwksCache!.keys;
  const config = (await (await f(`${ISSUER}/.well-known/openid-configuration`)).json()) as { jwks_uri?: string };
  const jwks = (await (await f(config.jwks_uri ?? `${ISSUER}/.well-known/jwks.json`)).json()) as { keys?: JsonWebKey[] };
  jwksCache = { at: Date.now(), keys: jwks.keys ?? [] };
  return jwksCache.keys;
}

/** Checks the ID token's signature against OpenAI's published keys, and its issuer, audience, expiry and nonce. */
export async function verifyIdToken(
  token: string,
  want: { audience: string; nonce: string },
  f: Fetch = fetch,
): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new ChatGPTAuthError("ChatGPT sign-in returned no ID token.");
  const header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as { kid?: string; alg?: string };
  if (header.alg !== "RS256") throw new ChatGPTAuthError(`ChatGPT's ID token uses ${header.alg}, which Atlas doesn't check yet.`);
  const jwk = (await signingKeys(f, header.kid)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new ChatGPTAuthError("ChatGPT's ID token is signed with a key Atlas can't find.");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), enc.encode(`${h}.${p}`));
  if (!ok) throw new ChatGPTAuthError("ChatGPT's ID token signature didn't check out.");

  const claims = jwtClaims(token);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Date.now() / 1000;
  if (claims.iss !== ISSUER) throw new ChatGPTAuthError("ChatGPT's ID token came from an unexpected issuer.");
  if (!aud.includes(want.audience)) throw new ChatGPTAuthError("ChatGPT's ID token was issued for another app.");
  if (typeof claims.exp === "number" && claims.exp < now - 60) throw new ChatGPTAuthError("ChatGPT's ID token has expired. Start again.");
  if (claims.nonce !== want.nonce) throw new ChatGPTAuthError("ChatGPT's ID token doesn't match this sign-in. Start again.");
  return claims;
}
