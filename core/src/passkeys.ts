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
}

/** What the passkey routes need from the owner's agent: its stored passkeys and the challenge in flight. */
export interface PasskeyStore {
  passkeys(): Promise<StoredPasskey[]>;
  savePasskeys(list: StoredPasskey[]): Promise<void>;
  /** Saves the challenge for the next step, or reads and clears it. */
  setChallenge(c: { value: string; kind: "register" | "login"; expires: number } | null): Promise<void>;
  takeChallenge(): Promise<{ value: string; kind: "register" | "login"; expires: number } | null>;
  ownerName(): Promise<string>;
}

const CHALLENGE_MS = 5 * 60_000;

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

export async function registrationOptions(store: PasskeyStore, request: Request) {
  const { rpID } = relyingParty(request);
  const existing = await store.passkeys();
  const owner = (await store.ownerName()) || "Owner";
  const options = await generateRegistrationOptions({
    rpName: "Atlas",
    rpID,
    userName: owner,
    userDisplayName: owner,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as never })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  await store.setChallenge({ value: options.challenge, kind: "register", expires: Date.now() + CHALLENGE_MS });
  return options;
}

export type PasskeyResult = { ok: true; passkey: StoredPasskey } | { ok: false; status: number; message: string };

export async function verifyRegistration(
  store: PasskeyStore,
  request: Request,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeyResult> {
  const challenge = await store.takeChallenge();
  if (!challenge || challenge.kind !== "register" || challenge.expires < Date.now()) {
    return { ok: false, status: 400, message: "That took too long or was already used. Start adding the passkey again." };
  }
  const { rpID, origin } = relyingParty(request);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.value,
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
  };
  const list = await store.passkeys();
  await store.savePasskeys([...list.filter((p) => p.id !== passkey.id), passkey]);
  return { ok: true, passkey };
}

export async function loginOptions(store: PasskeyStore, request: Request) {
  const { rpID } = relyingParty(request);
  const list = await store.passkeys();
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: list.map((p) => ({ id: p.id, transports: p.transports as never })),
    userVerification: "preferred",
  });
  await store.setChallenge({ value: options.challenge, kind: "login", expires: Date.now() + CHALLENGE_MS });
  return options;
}

export async function verifyLogin(store: PasskeyStore, request: Request, response: AuthenticationResponseJSON): Promise<PasskeyResult> {
  const challenge = await store.takeChallenge();
  if (!challenge || challenge.kind !== "login" || challenge.expires < Date.now()) {
    return { ok: false, status: 400, message: "That took too long or was already used. Try signing in again." };
  }
  const list = await store.passkeys();
  const known = list.find((p) => p.id === response.id);
  if (!known) {
    return {
      ok: false,
      status: 401,
      message: "This passkey isn't one this Atlas knows. Sign in with your setup code, then add it in Settings → Devices.",
    };
  }
  const { rpID, origin } = relyingParty(request);
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.value,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: known.id, publicKey: fromB64url(known.public_key), counter: known.counter, transports: known.transports as never },
      requireUserVerification: false,
    });
  } catch (err) {
    return { ok: false, status: 401, message: `The passkey couldn't be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!verified.verified) return { ok: false, status: 401, message: "The passkey didn't verify." };
  const updated = { ...known, counter: verified.authenticationInfo.newCounter, last_used: Date.now() };
  await store.savePasskeys(list.map((p) => (p.id === known.id ? updated : p)));
  return { ok: true, passkey: updated };
}
