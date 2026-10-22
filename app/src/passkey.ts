// Passkeys in the browser (§20, §22), through SimpleWebAuthn. The Worker
// checks every step; this only asks the device and passes its answer on.

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

export const passkeysSupported = () => browserSupportsWebAuthn();

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorOf(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Atlas answered ${r.status}.`;
}

/** What the device or the browser said, in plain words. */
function deviceError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again.";
  if (name === "InvalidStateError") return "This device already has a passkey for Atlas.";
  return err instanceof Error ? err.message : String(err);
}

/**
 * Adds a passkey on this device. Pass the setup code when not signed in yet
 * (it signs you in too); once signed in, no code is needed.
 */
export async function addPasskey(name: string, setupCode?: string): Promise<string | null> {
  const opts = await post("/api/passkey/register/options", setupCode ? { secret: setupCode } : {});
  if (!opts.ok) return errorOf(opts);
  let response;
  try {
    response = await startRegistration({ optionsJSON: await opts.json() });
  } catch (err) {
    return deviceError(err);
  }
  const done = await post("/api/passkey/register/verify", { response, name });
  return done.ok ? null : errorOf(done);
}

export async function signInWithPasskey(): Promise<string | null> {
  const opts = await post("/api/passkey/login/options", {});
  if (!opts.ok) return errorOf(opts);
  let response;
  try {
    response = await startAuthentication({ optionsJSON: await opts.json() });
  } catch (err) {
    return deviceError(err);
  }
  const done = await post("/api/passkey/login/verify", { response });
  return done.ok ? null : errorOf(done);
}

export async function signInWithCode(code: string): Promise<string | null> {
  const r = await post("/api/login", { secret: code });
  return r.ok ? null : r.status === 401 ? "That isn't the setup code." : errorOf(r);
}

/** A name for this device's passkey, from what the browser says it is. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}
