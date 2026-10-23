import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SECRET } from "./helpers";

import { authenticator, ORIGIN, RP } from "./webauthn";

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

    const session = (await (await SELF.fetch(`${ORIGIN}/api/session`)).json()) as { has_passkeys: boolean; signed_in: boolean };
    expect(session).toMatchObject({ has_passkeys: true, signed_in: false });

    // Signing in with it.
    const login = (await (await post("/api/passkey/login/options", {})).json()) as {
      challenge: string;
      allowCredentials: Array<{ id: string }>;
    };
    // Strangers learn no credential ids: the browser finds its own passkey.
    expect(login.allowCredentials).toEqual([]);
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

  it("end sessions on sign-out, and when their passkey is removed", async () => {
    const key = await authenticator();
    const opts = await post("/api/passkey/register/options", { secret: SECRET });
    const codeCookie = cookieOf(opts);
    const { challenge } = (await opts.json()) as { challenge: string };
    expect((await post("/api/passkey/register/verify", { response: await key.create(challenge), name: "Phone" }, codeCookie)).status).toBe(
      200,
    );

    const signedIn = async (cookie: string) =>
      ((await (await SELF.fetch(`${ORIGIN}/api/session`, { headers: { cookie } })).json()) as { signed_in: boolean }).signed_in;

    // Signing out ends that session for good, even if the cookie is kept.
    expect(await signedIn(codeCookie)).toBe(true);
    expect((await post("/api/logout", {}, codeCookie)).status).toBe(204);
    expect(await signedIn(codeCookie)).toBe(false);

    // A passkey sign-in, then that passkey is removed: its session ends with it.
    const login = (await (await post("/api/passkey/login/options", {})).json()) as { challenge: string };
    const viaKey = cookieOf(await post("/api/passkey/login/verify", { response: await key.get(login.challenge) }));
    expect(await signedIn(viaKey)).toBe(true);
    const ws = await SELF.fetch(`${ORIGIN}/agents/person-agent/owner`, {
      headers: { Upgrade: "websocket", cookie: viaKey, origin: ORIGIN },
    });
    expect(ws.status).toBe(101);
    const sock = ws.webSocket!;
    sock.accept();
    const told = new Promise<void>((resolve) =>
      sock.addEventListener("message", (e) => {
        if (typeof e.data === "string" && e.data.includes('"atlas.signed_out"')) resolve();
      }),
    );
    sock.send(JSON.stringify({ type: "atlas.passkey.remove", id: key.id }));
    // The socket that session opened is told and closed, and the cookie no longer works.
    await told;
    expect(await signedIn(viaKey)).toBe(false);
  });

  it("keep each challenge apart, so a stranger can't use up the owner's", async () => {
    const key = await authenticator();
    const opts = await post("/api/passkey/register/options", { secret: SECRET });
    const cookie = cookieOf(opts);
    const { challenge } = (await opts.json()) as { challenge: string };
    // Someone else asks for sign-in challenges meanwhile.
    for (let i = 0; i < 3; i++) await post("/api/passkey/login/options", {});
    expect((await post("/api/passkey/register/verify", { response: await key.create(challenge), name: "Laptop" }, cookie)).status).toBe(
      200,
    );
    // A login challenge can't be used to register.
    const login = (await (await post("/api/passkey/login/options", {})).json()) as { challenge: string };
    const other = await authenticator();
    expect((await post("/api/passkey/register/verify", { response: await other.create(login.challenge), name: "x" }, cookie)).status).toBe(
      400,
    );
  });

  it("refuse a malformed answer in plain words", async () => {
    for (const response of [undefined, null, "x", { id: 1 }, { id: "a", rawId: "a", type: "public-key", response: {} }]) {
      const r = await post("/api/passkey/login/verify", { response });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("That isn't a passkey answer.");
    }
    const r = await SELF.fetch(`${ORIGIN}/api/passkey/login/verify`, { method: "POST", headers: { origin: ORIGIN }, body: "{not json" });
    expect(r.status).toBe(400);
  });

  it("make the setup code wait after wrong guesses", async () => {
    for (let i = 0; i < 5; i++) expect((await post("/api/login", { secret: `wrong-${i}` })).status).toBe(401);
    const blocked = await post("/api/login", { secret: SECRET });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/Try again in \d+ seconds/);
  });

  it("refuse posts from another site", async () => {
    const r = await SELF.fetch(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { origin: "https://evil.test" },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(r.status).toBe(403);
  });
});
