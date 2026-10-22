import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SECRET } from "./helpers";

const ORIGIN = "https://atlas.test";
const RP = "atlas.test";

// --- a small, strict authenticator: a P-256 key, "none" attestation ------------------------

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) =>
  Uint8Array.from(
    atob(
      s
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(s.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

/** Just enough CBOR for an attestation object and a COSE key. */
function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24
      ? new Uint8Array([(major << 5) | n])
      : n < 256
        ? new Uint8Array([(major << 5) | 24, n])
        : new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return cat(head(3, enc.encode(v).length), enc.encode(v));
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (v instanceof Map) return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  throw new Error("unsupported");
}

/** ECDSA signatures from WebCrypto are r||s; WebAuthn wants DER. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let x = b.slice(i);
    if (x[0]! & 0x80) x = cat(new Uint8Array([0]), x);
    return cat(new Uint8Array([2, x.length]), x);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

async function authenticator() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const credId = crypto.getRandomValues(new Uint8Array(16));
  let counter = 0;
  const rpHash = await sha256(enc.encode(RP));
  return {
    id: b64url(credId),
    async create(challenge: string) {
      const clientData = enc.encode(JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN }));
      const cose = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, fromB64url(jwk.x!)],
          [-3, fromB64url(jwk.y!)],
        ]),
      );
      const authData = cat(
        rpHash,
        new Uint8Array([0x45, 0, 0, 0, 0]),
        new Uint8Array(16),
        new Uint8Array([0, credId.length]),
        credId,
        cose,
      );
      const att = cbor(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: b64url(credId),
        rawId: b64url(credId),
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: b64url(clientData), attestationObject: b64url(att), transports: ["internal"] },
      };
    },
    async get(challenge: string, origin = ORIGIN) {
      counter += 1;
      const clientData = enc.encode(JSON.stringify({ type: "webauthn.get", challenge, origin }));
      const authData = cat(rpHash, new Uint8Array([0x05, 0, 0, 0, counter]));
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, cat(authData, await sha256(clientData))),
      );
      return {
        id: b64url(credId),
        rawId: b64url(credId),
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(der(sig)) },
      };
    },
  };
}

// --- the routes ---------------------------------------------------------------------------

const post = (path: string, body: unknown, cookie = "") =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

describe("passkeys", () => {
  it("are added with the setup code, then sign the owner in; others are refused in plain words", async () => {
    // Without the setup code, nothing.
    expect((await post("/api/passkey/register/options", { secret: "wrong" })).status).toBe(401);

    const key = await authenticator();
    const opts = await post("/api/passkey/register/options", { secret: SECRET });
    expect(opts.status).toBe(200);
    const cookie = cookieOf(opts);
    const { challenge, rp } = (await opts.json()) as { challenge: string; rp: { id: string } };
    expect(rp.id).toBe(RP);
    const added = await post("/api/passkey/register/verify", { response: await key.create(challenge), name: "Test laptop" }, cookie);
    expect([added.status, await added.json()]).toEqual([200, { name: "Test laptop" }]);

    const session = (await (await SELF.fetch(`${ORIGIN}/api/session`)).json()) as { passkeys: number; signed_in: boolean };
    expect(session).toMatchObject({ passkeys: 1, signed_in: false });

    // Signing in with it.
    const login = (await (await post("/api/passkey/login/options", {})).json()) as {
      challenge: string;
      allowCredentials: Array<{ id: string }>;
    };
    expect(login.allowCredentials.map((c) => c.id)).toEqual([key.id]);
    const ok = await post("/api/passkey/login/verify", { response: await key.get(login.challenge) });
    expect(ok.status).toBe(204);
    const me = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { cookie: cookieOf(ok) } });
    expect(((await me.json()) as { signed_in: boolean }).signed_in).toBe(true);

    // The same challenge can't be used twice.
    expect((await post("/api/passkey/login/verify", { response: await key.get(login.challenge) })).status).toBe(400);

    // A passkey this Atlas doesn't know is refused, and the reason says what to do.
    const stranger = await authenticator();
    const again = (await (await post("/api/passkey/login/options", {})).json()) as { challenge: string };
    const refused = await post("/api/passkey/login/verify", { response: await stranger.get(again.challenge) });
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toContain("isn't one this Atlas knows");

    // A signature for another site doesn't work here.
    const third = (await (await post("/api/passkey/login/options", {})).json()) as { challenge: string };
    const phished = await post("/api/passkey/login/verify", { response: await key.get(third.challenge, "https://evil.test") });
    expect(phished.status).toBe(401);
  });
});
