// Phone calls (VISION §16.1): the core's side. The calls extension (Telnyx)
// talks to its service; this desk shares what it needs (the owner's own
// numbers, where to stream, what to say to anyone else), lets the owner pick
// or buy the number from Settings, checks a call's stream before the Worker
// joins it to Atlas's voice, and places a call to the owner when something
// can't wait and they've allowed it (§12.3, §14). A call that connects is an
// ordinary voice session; one Atlas placed starts with what it called about.

import type { CallData, NumberOffer, PhoneNumber } from "../../../extensions/sdk";
import type { ExtensionHost, Installed } from "../extensions";
import { installed } from "../extensions";
import type { Json, Sql } from "../store/db";
import { append } from "../store/log";
import { ownerName } from "../store/records";
import { readSettings } from "../store/settings";
import { getState, setState } from "../store/state";

/** How long a call Atlas placed waits for its stream, before what it was going to say is dropped. */
const PENDING_MS = 2 * 60_000;
/** How long a stream's one-time key is good for: a call is answered, and its stream connects, within seconds. */
const TOKEN_MS = 2 * 60_000;
/** Calls Atlas places in an hour, at most: what can't wait still can't ring you all day. */
export const CALLS_PER_HOUR = 4;

export interface CallDeskDeps {
  sql: Sql;
  host: ExtensionHost;
  changed(): void;
}

/**
 * The owner's own phone numbers: only the ones they set themselves (§16.1).
 * Not their record's, which what Atlas reads can add to: a number there
 * could otherwise be answered as the owner.
 */
export function ownerPhones(sql: Sql): string[] {
  return readSettings(sql).phone.mine.filter((n) => n.replace(/\D/g, "").length >= 7);
}

/** A one-time key for one call's stream, good for a couple of minutes. */
function mintToken(sql: Sql): string {
  const now = Date.now();
  const live = Object.entries(getState<Record<string, number>>(sql, "call_tokens") ?? {})
    .filter(([, until]) => until > now)
    .slice(-40);
  const token = crypto.randomUUID().replace(/-/g, "");
  setState(sql, "call_tokens", Object.fromEntries([...live, [token, now + TOKEN_MS]]));
  return token;
}

/** Uses up a stream's key: true once, while it's good. */
export function useToken(sql: Sql, token: string): boolean {
  const all = getState<Record<string, number>>(sql, "call_tokens") ?? {};
  const until = all[token];
  if (!until) return false;
  delete all[token];
  setState(sql, "call_tokens", all);
  return until > Date.now();
}

/**
 * What a calls extension is told: the owner's numbers, where to stream a
 * call (with a one-time key, so the address alone can't open a voice
 * session), and what anyone else hears.
 */
export function callData(sql: Sql, address: string | undefined): CallData {
  const s = readSettings(sql);
  const owner = ownerName(sql) || "the owner";
  return {
    owner_numbers: ownerPhones(sql),
    stream: address ? `${address.replace(/^http/, "ws")}/stream/${mintToken(sql)}` : "",
    greeting: `You've reached ${s.assistant_name}, ${owner}'s assistant. ${owner} doesn't take calls on this number. Please send them a message instead. Goodbye.`,
  };
}

export class CallDesk {
  /** Calls Atlas placed, by the id on their stream: what to say when they connect. */
  #pending = new Map<string, { text: string; at: number }>();

  constructor(private readonly d: CallDeskDeps) {}

  /** The calls extension that's on, if any. */
  extension(): Installed | null {
    return installed(this.d.sql).find((e) => e.state === "on" && e.manifest.provides.includes("calls")) ?? null;
  }

  #need(): Installed {
    const e = this.extension();
    if (!e) throw new Error("No phone service is set up: add Telnyx in Abilities → Services.");
    return e;
  }

  #call<T>(method: string, args: unknown[] = []): Promise<T> {
    const e = this.#need();
    return this.d.host.call<T>(e.id, method, args, { data: callData(this.d.sql, this.d.host.address(e)) as unknown as Json });
  }

  async numbers(): Promise<PhoneNumber[]> {
    return (await this.#call<{ numbers: PhoneNumber[] }>("numbers")).numbers;
  }

  async use(id: string): Promise<string> {
    const out = await this.#call<{ text: string; number: string }>("use", [{ id }]);
    append(this.d.sql, { actor: "owner", kind: "settings.change", body: { calls: "number", number: out.number } });
    this.d.changed();
    return out.text;
  }

  async release(): Promise<string> {
    const out = await this.#call<{ text: string }>("release");
    append(this.d.sql, { actor: "owner", kind: "settings.change", body: { calls: "number given back" } });
    this.d.changed();
    return out.text;
  }

  available(area?: string): Promise<NumberOffer[]> {
    return this.#call<NumberOffer[]>("available", [{ ...(area ? { area } : {}) }]);
  }

  async order(number: string): Promise<string> {
    const out = await this.#call<{ text: string }>("order", [{ number }]);
    append(this.d.sql, { actor: "owner", kind: "settings.change", body: { calls: "number bought", number } });
    this.d.changed();
    return out.text;
  }

  /** The number Atlas answers, when it has one. */
  number(): string | null {
    const st = this.extension()?.data as { number?: { e164?: string } } | null | undefined;
    return st?.number?.e164 ?? null;
  }

  /**
   * Calls the owner, to say `text` when they pick up. Throws, with why,
   * when it can't: no phone service, no number of Atlas's, no number for
   * the owner.
   */
  async dial(text: string): Promise<void> {
    const to = ownerPhones(this.d.sql)[0];
    if (!to) throw new Error("Atlas doesn't have your phone number: add it under Telnyx in Abilities → Services.");
    const now = Date.now();
    const placed = (getState<number[]>(this.d.sql, "calls_placed") ?? []).filter((t) => now - t < 3_600_000);
    if (placed.length >= CALLS_PER_HOUR)
      throw new Error(
        `Atlas has called you ${placed.length} times in the last hour, its most; it doesn't call again until an hour after the first.`,
      );
    if (!this.number()) throw new Error("Atlas has no number to call from yet: pick or buy one for Telnyx in Abilities → Services.");
    const call = `out-${crypto.randomUUID()}`;
    for (const [k, v] of this.#pending) if (Date.now() - v.at > PENDING_MS) this.#pending.delete(k);
    this.#pending.set(call, { text, at: Date.now() });
    try {
      await this.#call("dial", [{ to, call }]);
      setState(this.d.sql, "calls_placed", [...placed, now]);
    } catch (err) {
      this.#pending.delete(call);
      throw err;
    }
  }

  /** Whether a call's stream may join Atlas's voice: its extension's own address, with its key, and a one-time key from a call. */
  streamAllowed(id: string, key: string, token: string): boolean {
    const e = this.extension();
    return !!e && e.id === id && e.key.length > 0 && same(e.key, key) && useToken(this.d.sql, token);
  }

  /** A call's stream connected: what Atlas says first, when it placed the call. */
  opening(call: string): string | null {
    const p = this.#pending.get(call);
    if (!p) return null;
    this.#pending.delete(call);
    return Date.now() - p.at <= PENDING_MS ? p.text : null;
  }
}

/** Compares two keys in time that doesn't depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
