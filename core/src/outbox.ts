// One way out (§4.4): every message from Atlas leaves through here. In M0
// the only person is the owner and the channels are the app thread and a
// live voice call. The exit check here is the secrets scrubber; approvals,
// sharing rules and the public-query check join it in M2 and M5.

import type { Sql } from "./store/db";
import { append, type LogRow, type Surface } from "./store/log";
import { secretValues } from "./store/settings";

export const HIDDEN = "[hidden]";

/** Replaces any stored secret that appears in outgoing text. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join(HIDDEN);
  return out;
}

/**
 * The scrubber for streamed text. It holds back only a tail that could be
 * the start of a secret, so a secret split across two chunks is still caught
 * while ordinary text (almost always) goes straight out. Holding back a fixed
 * length instead would hold whole replies, since sign-in tokens run to
 * thousands of characters.
 */
export class StreamScrubber {
  private held = "";

  constructor(private readonly secrets: string[]) {}

  push(chunk: string): string {
    const all = scrub(this.held + chunk, this.secrets);
    const keep = this.partialTail(all);
    this.held = all.slice(all.length - keep);
    return all.slice(0, all.length - keep);
  }

  flush(): string {
    const rest = scrub(this.held, this.secrets);
    this.held = "";
    return rest;
  }

  /** The length of the longest end of `text` that is the beginning of a secret. */
  private partialTail(text: string): number {
    let best = 0;
    for (const s of this.secrets) {
      for (let k = Math.min(s.length - 1, text.length); k > best; k--) {
        // Cheap first-character check before comparing the whole stretch.
        if (text.charCodeAt(text.length - k) === s.charCodeAt(0) && text.endsWith(s.slice(0, k))) {
          best = k;
          break;
        }
      }
    }
    return best;
  }
}

export interface Delivery {
  text: string;
  run_id: string | null;
  /** Where the owner gets it: the surface they asked on, or "app" for something Atlas starts. */
  channel: Surface;
  brain?: { provider: string; model: string } | null;
  fallback?: boolean;
  interrupted?: boolean;
  usage?: unknown;
  trigger?: string;
  /** For spoken replies: when the status line and the answer were ready. */
  timing?: Record<string, unknown>;
}

/** The live ends of each channel. The agent provides them. */
export interface Channels {
  /** Every open app connection. */
  broadcast(rows: LogRow[]): void;
  /** Speaks into a live call, if there is one. Resolves false when nobody is in a call. */
  speak(text: string): Promise<boolean>;
}

export class Outbox {
  constructor(
    private readonly sql: Sql,
    private readonly channels: Channels,
  ) {}

  secrets(): string[] {
    return secretValues(this.sql);
  }

  /**
   * Saves and sends one message to the owner. A reply is already streamed on
   * the surface that asked, so it's only saved and shown. Something Atlas
   * starts on its own (a reminder) also goes out loud when the owner is in a
   * call. Returns the delivery receipt row.
   */
  async deliver(d: Delivery, opts: { alreadyStreamed: boolean }): Promise<LogRow> {
    const text = scrub(d.text, this.secrets());
    let channel = d.channel;
    if (!opts.alreadyStreamed && (await this.channels.speak(text))) channel = "voice";
    const row = append(this.sql, {
      actor: "atlas",
      kind: "message.out",
      run_id: d.run_id,
      surface: channel,
      body: {
        text,
        channel,
        ...(d.brain ? { brain: d.brain } : {}),
        ...(d.fallback ? { fallback: true } : {}),
        ...(d.interrupted ? { interrupted: true } : {}),
        ...(d.usage ? { usage: d.usage as never } : {}),
        ...(d.trigger ? { trigger: d.trigger } : {}),
        ...(d.timing ? { timing: d.timing as never } : {}),
      },
    });
    this.channels.broadcast([row]);
    return row;
  }
}
