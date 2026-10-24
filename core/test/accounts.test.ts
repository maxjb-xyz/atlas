// Accounts (VISION §6.2, §17): a service added more than once. Two calendars
// read as one, a move going back to the calendar the event came from, and one
// that refuses its sign-in leaving the other's events in place. Two mail
// accounts: new mail from the area's, the default, or the one named.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { CalendarSense } from "../src/agent/calendar";
import { ExtensionError, type ExtensionHost, addAccount, install, saveData } from "../src/extensions";
import { createArea, setScope, updateArea } from "../src/store/areas";
import { emailSend, mailAccount } from "../src/tools/mail";
import { accountsLine } from "../src/accounts";
import { hat } from "../src/context";
import type { CalendarEvent } from "../src/calendar/types";
import { migrate, type Sql } from "../src/store/db";
import { readSettings } from "../src/store/settings";
import { env } from "./helpers";

async function withSql<T>(fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  const stub = env.PersonAgent.get(env.PersonAgent.idFromName(`acc-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_i, state) => {
    migrate(state.storage.sql);
    return fn(state.storage.sql);
  });
}

afterEach(() => {
  seams.calendar = undefined;
});

const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const ev = (id: string, title: string, h: number, calendar: string): CalendarEvent => ({
  id,
  title,
  start: at(h),
  end: at(h + 1),
  all_day: false,
  calendar,
});

describe("two calendar accounts", () => {
  it("are read as one, in order; a move goes back to its own; one refusing leaves the other's", () =>
    withSql(async (sql) => {
      seams.calendar = undefined;
      install(sql, { id: "icloud", source: "bundled" });
      const second = addAccount(sql, "icloud");
      expect(second.id).toBe("icloud--2");
      const events: Record<string, CalendarEvent[]> = {
        icloud: [ev("home-1", "Dentist", 3, "Home")],
        "icloud--2": [ev("work-1", "Standup", 1, "Work"), ev("work-2", "Review", 5, "Work")],
      };
      const moved: string[] = [];
      let refuse = "";
      const host = {
        call: async (id: string, method: string, args: unknown[]) => {
          if (id === refuse) throw new ExtensionError("iCloud didn't accept the Apple ID and app-specific password.", "auth");
          if (method === "calendar") return { events: events[id] ?? [] };
          if (method === "move") {
            moved.push(`${id}:${(args[0] as { id: string }).id}`);
            const e = events[id]!.find((x) => x.id === (args[0] as { id: string }).id)!;
            return { before: e, event: e };
          }
          if (method === "test") return { text: "ok" };
          throw new Error(`no ${method}`);
        },
        address: () => null,
      } as unknown as ExtensionHost;
      const cal = new CalendarSense(sql, () => {}, host).source(readSettings(sql))!;
      const range = { start: new Date(), end: new Date(Date.now() + 86_400_000) };

      const both = await cal.read(range);
      expect(both.events.map((e) => e.title)).toEqual(["Standup", "Dentist", "Review"]);
      expect(both.missing).toBeUndefined();

      await cal.move!("home-1", { start: at(4), end: at(5) });
      await cal.move!("work-2", { start: at(6), end: at(7) });
      expect(moved).toEqual(["icloud:home-1", "icloud--2:work-2"]);

      // The work account refuses: home's events still come, and the read says which couldn't be read and why.
      refuse = "icloud--2";
      const one = await cal.read(range);
      expect(one.events.map((e) => e.title)).toEqual(["Dentist"]);
      expect(one.missing?.[0]).toMatch(/^iCloud: iCloud didn't accept/);
    }));
});

describe("two mail accounts", () => {
  it("send new mail from the area's account, else the default, a named one when asked, and say so in the context", () =>
    withSql(async (sql) => {
      install(sql, { id: "gmail", source: "bundled" });
      saveData(sql, "gmail", { email: "me@home.example" });
      saveData(sql, addAccount(sql, "gmail").id, { email: "me@work.example" });
      const work = createArea(sql, { name: "Keyframes", by: "owner" });
      const sent: Array<{ via: string; from: string }> = [];
      const ctx = {
        sql,
        run_id: "run_t",
        source_log_id: null,
        exit: {
          request: async (a: { via: string; from: string }) => {
            sent.push({ via: a.via, from: a.from });
            return { ok: true, output: "waiting" };
          },
        },
      } as never;
      const mail = { as: "owner" as const, to: ["doug@acme.example"], subject: "Hi", text: "Hello." };
      type Run = (input: unknown, ctx: never) => Promise<{ ok: boolean }>;
      const send = (input: unknown) => (emailSend.run as unknown as Run)(input, ctx);
      const use = (input: unknown) => (mailAccount.run as unknown as Run)(input, ctx);

      await send(mail);
      expect(sent.at(-1)).toEqual({ via: "gmail", from: "me@home.example" });

      // Keyframes sends from work, set by asking.
      const set = await use({ account: "work", area: "Keyframes" });
      expect(set.ok).toBe(true);
      setScope(sql, work.id);
      await send(mail);
      expect(sent.at(-1)).toEqual({ via: "gmail--2", from: "me@work.example" });
      expect(accountsLine(sql, hat(sql))).toContain("new mail as them goes from Google (me@work.example) here");

      // Named when the owner says, whatever the area.
      await send({ ...mail, from: "me@home.example" });
      expect(sent.at(-1)!.via).toBe("gmail");
      expect((await send({ ...mail, from: "nope" })).ok).toBe(false);

      // The default, outside any area.
      setScope(sql, null);
      updateArea(sql, work.id, { settings: { ...work.settings, mail: "" } }, "owner");
      await use({ account: "me@work.example" });
      await send(mail);
      expect(sent.at(-1)!.via).toBe("gmail--2");
    }));
});
