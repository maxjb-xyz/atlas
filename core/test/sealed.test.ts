import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/store/db";
import { clearUnreadable, dataKeyView, open, seal, useDataKey } from "../src/store/sealed";
import { getSecret, sealSecrets, secretValues, setSecret } from "../src/store/settings";
import { saveEntry } from "../src/vault";
import { env } from "./helpers";

const KEY = "test-data-key-not-real-0123456789abcdef";
const raw = (sql: SqlStorage, name: string) =>
  sql.exec<{ value: string }>(`SELECT value FROM secrets WHERE name = ?`, name).toArray()[0]?.value;

describe("Atlas's own sealing of secrets (§20)", () => {
  afterEach(() => {
    useDataKey(KEY);
    clearUnreadable();
  });

  it("seals each value so storage never holds it, and opens it only under its own name", () => {
    useDataKey(KEY);
    const a = seal("tavily_api_key", '"tvly-secret-value"');
    expect(a.startsWith("enc1:")).toBe(true);
    expect(a).not.toContain("tvly-secret-value");
    expect(seal("tavily_api_key", '"tvly-secret-value"')).not.toBe(a); // a new nonce each time
    expect(open("tavily_api_key", a)).toBe('"tvly-secret-value"');
    // Moved under another name, it doesn't open, and Settings says why.
    expect(open("brave_api_key", a)).toBeNull();
    expect(dataKeyView().unreadable).toContain("brave_api_key");
  });

  it("refuses a short key, and with no key keeps values as they were and says so", () => {
    useDataKey("short");
    expect(dataKeyView().state).toBe("short");
    expect(seal("x", "plain")).toBe("plain");
    useDataKey(undefined);
    expect(dataKeyView().state).toBe("missing");
    expect(open("x", "plain")).toBe("plain");
  });

  it("seals what was kept before, reads it the same, and a changed key gives a plain reason, never a crash", async () => {
    await runInDurableObject(env.PersonAgent.get(env.PersonAgent.idFromName("sealed-store")), async (_a, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      // Kept before sealing: plain JSON in the table.
      useDataKey(undefined);
      setSecret(sql, "mapbox_token", "pk.mapbox-token-value");
      saveEntry(sql, { name: "Chase login", kind: "login", sites: ["chase.com"], values: { username: "maxb", password: "s3cret-pass" } });
      expect(raw(sql, "mapbox_token")).toContain("pk.mapbox-token-value");

      // The update with sealing starts: everything is sealed, and reads the same.
      useDataKey(KEY);
      expect(sealSecrets(sql)).toBeGreaterThanOrEqual(2);
      expect(raw(sql, "mapbox_token")).not.toContain("pk.mapbox-token-value");
      expect(raw(sql, "vault")).not.toContain("s3cret-pass");
      expect(getSecret(sql, "mapbox_token")).toBe("pk.mapbox-token-value");
      expect(secretValues(sql)).toEqual(expect.arrayContaining(["pk.mapbox-token-value", "s3cret-pass"]));
      expect(sealSecrets(sql)).toBe(0);

      // The owner changes the key: the value reads as missing, and Settings says to put the old key back.
      useDataKey("a-completely-different-key-0123456789");
      expect(getSecret(sql, "mapbox_token")).toBeNull();
      expect(dataKeyView().unreadable).toMatch(/mapbox_token.*Put the old key back/);
      // Nothing is written over it meanwhile: a new vault entry would replace the whole vault.
      expect(() => saveEntry(sql, { name: "Amex", kind: "card", sites: ["amex.com"], values: { number: "4111111111111111" } })).toThrow(
        /Not saved/,
      );
      // With the old key back, everything opens again, the vault whole.
      useDataKey(KEY);
      expect(getSecret(sql, "mapbox_token")).toBe("pk.mapbox-token-value");
      expect(JSON.stringify(getSecret(sql, "vault"))).toContain("Chase login");
    });
  });
});
