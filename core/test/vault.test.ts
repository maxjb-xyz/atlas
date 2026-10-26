import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import type { BrowserDriver, BrowserPage, PageElement } from "../src/browser";
import { migrate } from "../src/store/db";
import { getSecret, secretValues } from "../src/store/settings";
import { fillsOn, hiddenValues, saveEntry, siteOf, totp, vault } from "../src/vault";
import { call, env, fakeCalendar, fakeEmbedder, say } from "./helpers";
import { brain, connect, inOwner, out, turn } from "./owner";

describe("the vault's parts", () => {
  it("makes two-factor codes the way authenticator apps do (RFC 6238's test values)", async () => {
    const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
    expect(await totp(seed, 59_000)).toBe("287082");
    expect(await totp(seed, 1_111_111_109_000)).toBe("081804");
    expect(await totp(seed, 2_000_000_000_000)).toBe("279037");
  });

  it("ties entries to sites, keeps values on an edit, and hides values from reads but only secrets from what leaves", async () => {
    await runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName("vault-parts")), async (_a, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      expect(siteOf("https://www.Chase.com/login")).toBe("chase.com");
      const e = saveEntry(sql, {
        name: "Chase login",
        kind: "login",
        sites: ["https://www.chase.com", "chase.co.uk"],
        values: { username: "maxb", password: "s3cret-pass" },
      });
      expect(e.sites).toEqual(["chase.com", "chase.co.uk"]);
      expect(fillsOn(e, "secure.chase.com")).toBe(true);
      expect(fillsOn(e, "chase.com.evil.example")).toBe(false);
      expect(fillsOn(e, "notchase.com")).toBe(false);
      const edited = saveEntry(sql, {
        id: e.id,
        name: "Chase login",
        kind: "login",
        sites: ["chase.com"],
        values: { username: "", password: "" },
        totp: "JBSW Y3DP EHPK 3PXP",
      });
      expect(edited.values).toEqual({ username: "maxb", password: "s3cret-pass" });
      expect(edited.totp).toBe("JBSWY3DPEHPK3PXP");
      expect(() => saveEntry(sql, { name: "chase LOGIN", kind: "login", sites: ["x.com"], values: { password: "abc" } })).toThrow(
        "already one called",
      );
      expect(() => saveEntry(sql, { name: "Nowhere", kind: "key", sites: [], values: { key: "k-123456" } })).toThrow(
        "Tie it to at least one site",
      );
      saveEntry(sql, {
        name: "Visa",
        kind: "card",
        sites: ["shop.example"],
        values: { number: "4111111111111111", cvc: "123", name: "Max Bailey" },
      });
      expect(hiddenValues(sql)).toEqual(
        expect.arrayContaining(["maxb", "s3cret-pass", "4111111111111111", "Max Bailey", "JBSWY3DPEHPK3PXP"]),
      );
      const leaving = secretValues(sql);
      expect(leaving).toEqual(expect.arrayContaining(["s3cret-pass", "4111111111111111", "123", "JBSWY3DPEHPK3PXP"]));
      expect(leaving).not.toContain("Max Bailey");
      expect(leaving).not.toContain("maxb");
    });
  });
});

/** A shop with a sign-in page that greets you by your username, and a checkout. */
function fakeShop() {
  const fields: Record<string, string> = {};
  const signIn: PageElement[] = [
    { ref: "1", kind: "link", text: "Help", href: "https://shop.example/help" },
    { ref: "2", kind: "field", text: "Email", field: "email", value: "" },
    { ref: "3", kind: "field", text: "Password", field: "password", value: "" },
    { ref: "4", kind: "button", text: "Sign in", submits: true },
  ];
  const log: string[] = [];
  let at: string | null = null;
  const page = (): BrowserPage => {
    const signedIn = at === "https://shop.example/account";
    const text = signedIn ? `Welcome back, ${fields["2"]}.` : "Sign in to Shop.";
    return {
      url: at!,
      title: signedIn ? "Your account" : "Sign in",
      text,
      length: text.length,
      elements: signedIn ? [] : signIn.map((e) => (e.ref in fields ? { ...e, value: e.ref === "3" ? "(filled)" : fields[e.ref] } : e)),
    };
  };
  const driver: BrowserDriver & { log: string[]; goTo(u: string): void } = {
    log,
    goTo: (u) => (at = u),
    async open(url) {
      at = url;
      return page();
    },
    async look() {
      return page();
    },
    async act() {
      return page();
    },
    async fill(list, press) {
      for (const f of list) fields[f.ref] = f.value;
      log.push(`fill ${list.map((f) => `${f.ref}=${f.value}`).join(" ")}${press ? ` press ${press}` : ""}`);
      if (press === "4") at = "https://shop.example/account";
      return page();
    },
    async find(ref) {
      return at ? (page().elements.find((e) => e.ref === ref) ?? null) : null;
    },
    async live() {
      return "https://live.example/x";
    },
    async close() {
      at = null;
    },
    where: () => (at ? { open: true, url: at, title: page().title } : { open: false, url: "", title: "" }),
    async download() {
      throw new Error("No downloads here.");
    },
  };
  return driver;
}

let shop: ReturnType<typeof fakeShop>;

beforeEach(async () => {
  shop = fakeShop();
  seams.browser = shop;
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.fetch = (async () => new Response("ok")) as unknown as typeof fetch;
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM secrets WHERE name = 'vault'`);
    sql.exec(`DELETE FROM state WHERE key IN ('browser', 'browser_taken')`);
  });
});
afterEach(() => {
  seams.browser = undefined;
  seams.fetch = null;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("the vault in a run", () => {
  it("signs in on its own site: asks the first time, fills without the model seeing a value, then fills without asking", async () => {
    const s = await connect();
    s.send({
      type: "atlas.vault.save",
      name: "Shop login",
      kind: "login",
      sites: ["shop.example"],
      values: { username: "max@shop.test", password: "hunter2-long" },
    });
    const view = await s.next("atlas.view", (m) => m.view.vault.some((e) => e.name === "Shop login"));
    expect(JSON.stringify(view.view.vault)).not.toContain("hunter2");
    shop.goTo("https://shop.example/signin");

    const b = brain([
      call("vault_fill", { entry: "shop login", fields: { username: "2", password: "3" }, press: "4" }),
      say("It's waiting for your OK in Inbox."),
      call("browser_act", { action: "look" }),
      say("Signed in."),
    ]);
    // The model is told what's in the vault, by name and site only.
    const first = await turn(s, "sign in to the shop");
    expect(b.requests[0]!.system).toContain("- Shop login (login, fills on shop.example): username, password");
    expect(b.requests[0]!.system).not.toContain("hunter2");
    const receipt = first.results[0]!.body.receipt as { text: string; approval: string };
    expect(receipt.text).toBe("Waiting for your OK · Use Shop login on shop.example");
    expect(shop.log).toEqual([]);

    s.send({ type: "atlas.inbox" });
    const card = (await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.approval?.id === receipt.approval))).items.find(
      (i) => i.approval?.id === receipt.approval,
    )!.approval!;
    expect(card).toMatchObject({ hold: false, steps: [{ kind: "vault", title: "Fill in Shop login on shop.example" }] });
    expect(card.steps[0]!.detail).toContain('username or email, password, then press "Sign in"');

    // Yes in the app: it fills, signs in, remembers the site, and Atlas carries on, seeing no value.
    s.send({ type: "atlas.approval.decide", id: receipt.approval, yes: true });
    await s.next("atlas.run", (m) => m.state === "replied" && m.run_id !== first.run);
    expect(shop.log).toEqual(["fill 2=max@shop.test 3=hunter2-long press 4"]);
    const carried = JSON.stringify(b.requests[2]!.messages);
    expect(carried).toContain("Yes to Use Shop login on shop.example. Carry on.");
    expect(carried).toContain("Welcome back, [hidden].");
    expect(carried).not.toContain("max@shop.test");
    expect(carried).not.toContain("hunter2");
    const saved = await inOwner((_a, sql) => getSecret<Array<{ allowed: string[]; uses: number }>>(sql, "vault")![0]!);
    expect(saved).toMatchObject({ allowed: ["shop.example"], uses: 1 });

    // Next time on that site: no card, though the run has read the web.
    shop.goTo("https://shop.example/signin");
    brain([call("vault_fill", { entry: "Shop login", fields: { username: "2", password: "3" }, press: "4" }), say("Signed in.")]);
    const second = await turn(s, "sign in again");
    expect(second.results[0]!.body.receipt).toEqual({ text: "Filled · Shop login on shop.example" });
    expect(out(second.results[0]!)).toContain("Filled 2 fields from Shop login on shop.example and pressed");
    expect(out(second.results[0]!)).not.toContain("max@shop.test");
    expect(second.deliveries.map((d) => d.body)).toEqual([
      expect.objectContaining({ channel: "vault", to: "shop.example", ok: true, by: "trusted", pressed: "Sign in" }),
    ]);

    // Ask again takes the yes back.
    s.send({ type: "atlas.vault.revoke", id: view.view.vault.find((e) => e.name === "Shop login")!.id, site: "shop.example" });
    await s.next("atlas.view", (m) => m.view.vault.some((e) => e.name === "Shop login" && e.allowed.length === 0));
  });

  it("won't fill on another site, or a field that isn't there", async () => {
    const s = await connect();
    await inOwner((_a, sql) =>
      saveEntry(sql, { name: "Bank login", kind: "login", sites: ["bank.example"], values: { username: "maxb", password: "pw-123456" } }),
    );
    shop.goTo("https://shop.example/signin");
    brain([call("vault_fill", { entry: "Bank login", fields: { username: "2", password: "3" } }), say("That login is only for the bank.")]);
    const { results } = await turn(s, "use my bank login here");
    expect(out(results[0]!)).toContain("Bank login only fills on bank.example, and the browser is on shop.example");
    expect(shop.log).toEqual([]);
    brain([call("vault_fill", { entry: "Bank login", fields: { code: "2" } }), say("No code.")]);
    await inOwner((_a, sql) => saveEntry(sql, { name: "Shop key", kind: "key", sites: ["shop.example"], values: { key: "sk-shop-0001" } }));
    brain([call("vault_fill", { entry: "Shop key", fields: { password: "3" } }), say("Wrong field.")]);
    const wrong = await turn(s, "put the key in");
    expect(out(wrong.results[0]!)).toContain("Shop key is a key; its fields are key");
  });

  it("a card asks every time, with a hold", async () => {
    const s = await connect();
    await inOwner((_a, sql) => {
      saveEntry(sql, { name: "Visa", kind: "card", sites: ["shop.example"], values: { number: "4111111111111111" } });
      const v = vault(sql)[0]!;
      sql.exec(`UPDATE secrets SET value = ? WHERE name = 'vault'`, JSON.stringify([{ ...v, allowed: ["shop.example"] }]));
    });
    shop.goTo("https://shop.example/signin");
    brain([call("vault_fill", { entry: "Visa", fields: { number: "2" } }), say("Waiting in Inbox.")]);
    const { results } = await turn(s, "pay with my visa");
    const receipt = results[0]!.body.receipt as { approval: string };
    s.send({ type: "atlas.inbox" });
    const card = (await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.approval?.id === receipt.approval))).items.find(
      (i) => i.approval?.id === receipt.approval,
    )!.approval!;
    expect(card.hold).toBe(true);
    expect(card.steps[0]!.undo).toBe("Card details always ask, every time.");
  });
});
