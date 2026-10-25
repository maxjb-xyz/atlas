// Accounts (VISION §6.2, §17): a service added more than once. Two calendars
// read as one, a move going back to the calendar the event came from, and one
// that refuses its sign-in leaving the other's events in place. Two mail
// accounts: new mail from the area's, the default, or the one named.

import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { CalendarSense } from "../src/agent/calendar";
import { ExtensionError, type ExtensionHost, addAccount, install, saveData, setExtSecrets } from "../src/extensions";
import { createArea, setScope, updateArea } from "../src/store/areas";
import { emailSend, mailAccount } from "../src/tools/mail";
import { calendarAdd } from "../src/tools/calendar";
import { eventAreas } from "../src/agent/areas";
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
      const host0 = { call: async () => ({ events: [] }), address: () => null } as unknown as ExtensionHost;
      // An account just added isn't signed in, so it isn't asked: it can't count as a refusal.
      setExtSecrets(sql, "icloud", { app_password: "one" });
      expect(new CalendarSense(sql, () => {}, host0).providers().map((e) => e.id)).toEqual(["icloud"]);
      setExtSecrets(sql, "icloud--2", { app_password: "two" });
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
      for (const id of ["gmail", "gmail--2"]) setExtSecrets(sql, id, { access_token: "ya29.x" });
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

describe("calendars in areas", () => {
  it("put new events on the area's calendar, the named one when asked, and take their area from the calendar they're on", () =>
    withSql(async (sql) => {
      seams.calendar = undefined;
      install(sql, { id: "icloud", source: "bundled" });
      addAccount(sql, "icloud");
      for (const id of ["icloud", "icloud--2"]) setExtSecrets(sql, id, { app_password: id });
      const work = createArea(sql, { name: "Keyframes", by: "owner" });
      updateArea(sql, work.id, { settings: { ...work.settings, calendars: ["icloud--2::Shoots"] } }, "owner");
      const added: string[] = [];
      const host = {
        call: async (id: string, method: string, args: unknown[]) => {
          if (method === "calendar") return { events: [ev(`${id}-1`, "Thing", 1, id === "icloud" ? "Home" : "Shoots")] };
          if (method === "add") {
            const e = args[0] as { title: string; start: string; end: string; calendar?: string };
            added.push(`${id}:${e.calendar ?? "(first)"}:${e.title}`);
            return {
              event: { id: `${id}-new`, title: e.title, start: e.start, end: e.end, all_day: false, calendar: e.calendar ?? "Home" },
            };
          }
          throw new Error(`no ${method}`);
        },
        address: () => null,
      } as unknown as ExtensionHost;
      const sense = new CalendarSense(sql, () => {}, host);
      const calendar = sense.source(readSettings(sql))!;
      const ctx = { sql, run_id: "run_c", tz: "America/New_York", now: new Date(), calendar } as never;
      type Run = (input: unknown, ctx: never) => Promise<{ ok: boolean; receipt?: { undo?: unknown } }>;
      const add = (input: unknown) => (calendarAdd.run as unknown as Run)(input, ctx);

      // Outside any area: the first account, its first calendar.
      expect((await add({ title: "Dentist", start: "2026-11-02T15:00" })).ok).toBe(true);
      // In Keyframes: its calendar, Shoots, on the second account; Undo takes it off.
      setScope(sql, work.id);
      const shoot = await add({ title: "Reel shoot", start: "2026-11-03T10:00" });
      expect(shoot.receipt?.undo).toEqual({ kind: "calendar.remove", id: "icloud--2-new", title: "Reel shoot" });
      // Named by the owner.
      await add({ title: "Gym", start: "2026-11-04T07:00", account: "icloud", calendar: "Home" });
      expect(added).toEqual(["icloud:(first):Dentist", "icloud--2:Shoots:Reel shoot", "icloud:Home:Gym"]);

      // Events read from Shoots are Keyframes', with no call to Clef; the rest wait for it.
      const read = await calendar.read({ start: new Date(), end: new Date(Date.now() + 86_400_000) });
      expect(eventAreas(sql, read.events)).toEqual([[], [work.id]]);
      expect(sense.names()).toEqual({ icloud: ["Home"], "icloud--2": ["Shoots"] });
    }));
});
