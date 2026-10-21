// "Sign in with ChatGPT" (§18): the device-code flow the Codex CLI uses, so a
// ChatGPT plan powers Atlas. The owner opens a link, types a short code, and
// Atlas polls until OpenAI hands back tokens. Atlas refreshes them itself.
//
// Endpoints and the client id follow openai/codex (codex-rs/login). The
// refresh request is the standard OAuth one; confirm it on the first real
// sign-in (docs/M0.md, "Things to check on your account").

export const ISSUER = "https://auth.openai.com";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  account_id: string | null;
  email: string | null;
  plan: string | null;
  /** ms since epoch. */
  expires_at: number;
}

export interface CodexLogin {
  device_auth_id: string;
  user_code: string;
  verification_url: string;
  /** Seconds between polls. */
  interval: number;
  expires_at: number;
}

type Fetch = typeof fetch;

export class CodexAuthError extends Error {}

/** Step 1: ask OpenAI for a code the owner types at the verification link. */
export async function startDeviceLogin(f: Fetch = fetch): Promise<CodexLogin> {
  const res = await f(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!res.ok) throw new CodexAuthError(`ChatGPT sign-in couldn't start (HTTP ${res.status}). Try again in a minute.`);
  const body = (await res.json()) as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string | number };
  const code = body.user_code ?? body.usercode;
  if (!body.device_auth_id || !code) throw new CodexAuthError("ChatGPT sign-in sent back something unexpected.");
  return {
    device_auth_id: body.device_auth_id,
    user_code: code,
    verification_url: `${ISSUER}/codex/device`,
    interval: Math.max(2, Number(body.interval ?? 5) || 5),
    expires_at: Date.now() + 15 * 60_000,
  };
}

/** Step 2: poll once. "pending" until the owner has entered the code. */
export async function pollDeviceLogin(login: CodexLogin, f: Fetch = fetch): Promise<"pending" | CodexTokens> {
  if (Date.now() > login.expires_at) throw new CodexAuthError("The sign-in code expired. Start again.");
  const res = await f(`${ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_auth_id: login.device_auth_id, user_code: login.user_code }),
  });
  if (res.status === 403 || res.status === 404) return "pending";
  if (!res.ok) throw new CodexAuthError(`ChatGPT sign-in failed (HTTP ${res.status}).`);
  const code = (await res.json()) as { authorization_code: string; code_verifier: string };

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: code.authorization_code,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: code.code_verifier,
  });
  const tok = await f(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!tok.ok) throw new CodexAuthError(`ChatGPT sign-in couldn't finish (HTTP ${tok.status}).`);
  return toTokens((await tok.json()) as RawTokens);
}

interface RawTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** Refreshes the access token. Throws CodexAuthError when the owner has to sign in again. */
export async function refreshTokens(tokens: CodexTokens, f: Fetch = fetch): Promise<CodexTokens> {
  const res = await f(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      scope: "openid profile email",
    }),
  });
  if (res.status === 400 || res.status === 401) {
    throw new CodexAuthError("ChatGPT sign-in has expired. Sign in again in Settings → Brains.");
  }
  if (!res.ok) throw new Error(`ChatGPT token refresh failed (HTTP ${res.status}).`);
  const raw = (await res.json()) as RawTokens;
  return toTokens({
    ...raw,
    refresh_token: raw.refresh_token ?? tokens.refresh_token,
    id_token: raw.id_token ?? tokens.id_token,
  });
}

export function toTokens(raw: RawTokens): CodexTokens {
  if (!raw.access_token || !raw.refresh_token) throw new CodexAuthError("ChatGPT sign-in returned no tokens.");
  const id = jwtClaims(raw.id_token ?? "");
  const access = jwtClaims(raw.access_token);
  const auth = (id["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const exp = typeof access.exp === "number" ? access.exp * 1000 : Date.now() + (raw.expires_in ?? 3600) * 1000;
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    id_token: raw.id_token ?? "",
    account_id: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null,
    plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null,
    email: typeof id.email === "string" ? id.email : null,
    expires_at: exp,
  };
}

/** Reads a JWT's claims without checking the signature (the token came straight from OpenAI over TLS). */
export function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const b64 = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return {};
  }
}
