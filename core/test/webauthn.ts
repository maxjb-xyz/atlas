// A small, strict WebAuthn authenticator for tests: a P-256 key, "none" attestation.

export const ORIGIN = "https://atlas.test";
export const RP = "atlas.test";

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

export async function authenticator() {
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
