// Passkeys (VISION §20, §22): how the owner signs in. The owner secret set
// at deploy is the setup code: it's needed once, to add the first passkey,
// and stays as a way back in if every passkey is lost, and as a token for
// scripts. WebAuthn is checked by SimpleWebAuthn, a library that follows the
// standard (rule 8), over WebCrypto.

import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthStore } from "./auth";

export interface StoredPasskey {
  /** The credential id, base64url. */
  id: string;
  /** The COSE public key, base64url. */
  public_key: string;
  counter: number;
  transports: string[];
  /** What the owner called it: "MacBook", "iPhone". */
  name: string;
  created_at: number;
  last_used: number | null;
  /** A member's passkey (§7.1): it signs in to their own Atlas. Absent for the owner's. */
  member?: string;
}

/** How long a challenge stays good. */
export const CHALLENGE_MS = 5 * 60_000;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
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

/** The relying party is this deployment's host: a passkey made here only works here. */
export function relyingParty(request: Request): { rpID: string; origin: string } {
  const url = new URL(request.url);
  return { rpID: url.hostname, origin: url.origin };
}

/** The challenge a browser answered, read from its signed client data. */
function answeredChallenge(clientDataJSON: string): string | null {
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(clientDataJSON))) as { challenge?: unknown };
    return typeof c.challenge === "string" ? c.challenge : null;
  } catch {
    return null;
  }
}

/** Takes the challenge this answer is for, if it was handed out for this step and hasn't expired. */
async function challengeFor(store: AuthStore, clientDataJSON: string, kind: "register" | "login"): Promise<string | null> {
  const value = answeredChallenge(clientDataJSON);
  if (!value) return null;
  const c = await store.takeChallenge(value);
  return c && c.kind === kind && c.expires >= Date.now() ? value : null;
}

/** Options for a new passkey: the owner's, or a member's (`who`), each its own user on this Atlas. */
export async function registrationOptions(store: AuthStore, request: Request, who?: { id: string; name: string }) {
  const { rpID } = relyingParty(request);
  const existing = (await store.passkeys()).filter((p) => (p.member ?? null) === (who?.id ?? null));
  const owner = who?.name || (await store.ownerName()) || "Owner";
  const options = await generateRegistrationOptions({
    rpName: "Atlas",
    rpID,
    userName: owner,
    userDisplayName: owner,
    ...(who ? { userID: new Uint8Array(new TextEncoder().encode(`member:${who.id}`)) as Uint8Array<ArrayBuffer> } : {}),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as never })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  await store.putChallenge(options.challenge, "register");
  return options;
}

export type PasskeyResult = { ok: true; passkey: StoredPasskey } | { ok: false; status: number; message: string };

export async function verifyRegistration(
  store: AuthStore,
  request: Request,
  response: RegistrationResponseJSON,
  name: string,
  member?: string,
): Promise<PasskeyResult> {
  const challenge = await challengeFor(store, response.response.clientDataJSON, "register");
  if (!challenge) return { ok: false, status: 400, message: "That took too long or was already used. Start adding the passkey again." };
  const { rpID, origin } = relyingParty(request);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    return { ok: false, status: 400, message: `The passkey couldn't be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!verified.verified || !verified.registrationInfo) return { ok: false, status: 400, message: "The passkey didn't verify." };
  const cred = verified.registrationInfo.credential;
  const passkey: StoredPasskey = {
    id: cred.id,
    public_key: b64url(cred.publicKey),
    counter: cred.counter,
    transports: response.response.transports ?? [],
    name: name.trim().slice(0, 60) || "Passkey",
    created_at: Date.now(),
    last_used: Date.now(),
    ...(member ? { member } : {}),
  };
  await store.addPasskey(passkey);
  return { ok: true, passkey };
}

export async function loginOptions(store: AuthStore, request: Request) {
  const { rpID } = relyingParty(request);
  // Passkeys here are discoverable, so the browser finds its own; strangers learn no credential ids.
  const options = await generateAuthenticationOptions({ rpID, allowCredentials: [], userVerification: "preferred" });
  await store.putChallenge(options.challenge, "login");
  return options;
}

export async function verifyLogin(store: AuthStore, request: Request, response: AuthenticationResponseJSON): Promise<PasskeyResult> {
  const challenge = await challengeFor(store, response.response.clientDataJSON, "login");
  if (!challenge) return { ok: false, status: 400, message: "That took too long or was already used. Try signing in again." };
  const known = (await store.passkeys()).find((p) => p.id === response.id);
  if (!known) {
    return {
      ok: false,
      status: 401,
      message: "This passkey isn't one this Atlas knows. Sign in with your setup code, then add it in Atlas settings → Account.",
    };
  }
  const { rpID, origin } = relyingParty(request);
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: known.id, publicKey: fromB64url(known.public_key), counter: known.counter, transports: known.transports as never },
      requireUserVerification: false,
    });
  } catch (err) {
    return { ok: false, status: 401, message: `The passkey couldn't be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!verified.verified) return { ok: false, status: 401, message: "The passkey didn't verify." };
  const used = await store.usePasskey(known.id, verified.authenticationInfo.newCounter);
  if (!used) return { ok: false, status: 401, message: "This passkey was just removed from Atlas." };
  return { ok: true, passkey: used };
}
