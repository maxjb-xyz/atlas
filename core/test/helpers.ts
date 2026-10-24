import { env as testEnv } from "cloudflare:test";
import type { Decider } from "../src/brains/decide";
import type { Embedder } from "../src/brains/embed";
import type { Brain, BrainEvent, BrainRequest } from "../src/brains/types";
import { BrainError } from "../src/brains/types";
import { type Calendar, type CalendarEvent, CalendarError, type CalendarRange, type CalendarSource } from "../src/calendar/types";
import { normalize } from "../src/store/memory";

export const env = testEnv as unknown as Env;
export const SECRET = "test-owner-secret-not-real";

/** One scripted model call: events to stream, a function of the request, or an error to throw. */
export type Step = BrainEvent[] | ((req: BrainRequest) => BrainEvent[]) | Error;

/**
 * A brain that plays a script, one entry per call, and records every
 * request it got. Shared across brains made from the same script.
 */
export function scripted(steps: Step[], provider: Brain["provider"] = "workers-ai", model = "fake") {
  const requests: BrainRequest[] = [];
  const brain: Brain = {
    provider,
    model,
    async *stream(req) {
      requests.push(req);
      const step = steps.shift();
      if (!step) throw new BrainError("script ran out");
      if (step instanceof Error) throw step;
      const events = typeof step === "function" ? step(req) : step;
      for (const e of events) {
        if (req.signal?.aborted) return;
        yield e;
        await Promise.resolve();
      }
    },
  };
  return { brain, requests, steps };
}

export const say = (text: string): BrainEvent[] => [
  { type: "text", text },
  { type: "done", finish: "stop" },
];

export const call = (name: string, input: unknown, id = `call_${name}`): BrainEvent[] => [
  { type: "tool_start", name },
  { type: "tool_call", call: { id, name, input } },
  { type: "done", finish: "tool_calls" },
];

/** A calendar for tests: usable as a source behind the guard (`seams.calendar`) or directly as a run's calendar. */
export function fakeCalendar(events: CalendarEvent[]): CalendarSource & Calendar & { ranges: Array<{ start: Date; end: Date }> } {
  const ranges: Array<{ start: Date; end: Date }> = [];
  const list = async (range: CalendarRange) => {
    ranges.push(range);
    return events.filter((e) => new Date(e.end) > range.start && new Date(e.start) < range.end);
  };
  return {
    ranges,
    list,
    async read(range) {
      return { events: await list(range) };
    },
    async check() {
      return { calendars: ["Home", "Work"], events_next_30_days: events.length };
    },
    async move(id, to) {
      const i = events.findIndex((e) => e.id === id);
      if (i < 0) throw new CalendarError("That event isn't on the calendar.", "protocol");
      const before = events[i]!;
      events[i] = { ...before, ...to };
      return { before, event: events[i]! };
    },
  };
}

/** A body that streams the given server-sent-event payloads. */
export function sse(payloads: Array<string | object>, split = 7): ReadableStream<Uint8Array> {
  const text = payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + split));
      i += split;
    },
  });
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const part = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A fake OpenAI: a real RSA key, a JWKS, and a token endpoint that signs ID tokens. */
export async function fakeOpenAI(opts: { scope?: string; tokenStatus?: number; tokenBody?: object } = {}) {
  const keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const kid = crypto.randomUUID();
  const jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid };
  const sign = async (claims: object) => {
    const unsigned = `${part({ alg: "RS256", kid })}.${part(claims)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64url(sig)}`;
  };
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  let nonce = "";
  const f = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ jwks_uri: "https://auth.openai.com/jwks" });
    if (url === "https://auth.openai.com/jwks") return Response.json({ keys: [jwk] });
    if (url === "https://api.openai.com/v1/models")
      return Response.json({
        models: [
          { slug: "gpt-6.1-sol", visibility: "list" },
          { slug: "hidden", visibility: "hide" },
        ],
      });
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url, body });
    if (opts.tokenStatus) return Response.json(opts.tokenBody ?? {}, { status: opts.tokenStatus });
    const id_token = await sign({
      iss: "https://auth.openai.com",
      aud: "oaiapp_123",
      exp: Date.now() / 1000 + 600,
      nonce,
      email: "max@example.com",
    });
    return Response.json({
      access_token: "at1",
      refresh_token: "rt2",
      id_token,
      expires_in: 3600,
      scope: opts.scope ?? "openid email offline_access chatgpt.tokens.use.direct",
    });
  }) as unknown as typeof fetch;
  return { f, calls, setNonce: (n: string) => (nonce = n) };
}

/** Words a fake embedder treats as the same idea, so tests can check search by meaning. */
const SAME_IDEA: Record<string, string> = {
  camera: "camera",
  lens: "camera",
  lenses: "camera",
  rental: "rent",
  rent: "rent",
  hire: "rent",
  hired: "rent",
  vegetarian: "food",
  meat: "food",
  dinner: "food",
};

/**
 * A fake `embed` role: each word (or its idea) lights up one of 64 slots.
 * Strict like the real one: it fails when told to, and records each call.
 */
export function fakeEmbedder(opts: { fail?: string; refuse?: string } = {}): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: "fake-embed",
    calls,
    async embed(texts) {
      calls.push(texts);
      if (opts.fail) throw new Error(opts.fail);
      // Like a model refusing one input: the whole call fails.
      if (opts.refuse && texts.some((t) => t.includes(opts.refuse!))) throw new Error("Workers AI: 400 input too long");
      return texts.map((t) => {
        const v = new Array<number>(64).fill(0);
        for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
          const key = SAME_IDEA[w] ?? w;
          let h = 0;
          for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
          v[h % 64]! += SAME_IDEA[w] ? 3 : 1;
        }
        return normalize(v);
      });
    },
  };
}

/**
 * A fake `decide` role. An area question gets a high probability when the
 * text has one of that area's words (or its name, or a word from an example
 * in the question); "ongoing" when the text has any word from `ongoing`.
 */
export function fakeDecider(
  words: Record<string, string[]> = {},
  ongoing: string[] = [],
): Decider & { calls: Array<{ state: string; questions: Record<string, string> }> } {
  const calls: Array<{ state: string; questions: Record<string, string> }> = [];
  return {
    model: "fake-decide",
    calls,
    async yesNo(state, questions) {
      calls.push({ state, questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.instructions])) });
      const text = state.toLowerCase();
      const out: Record<string, number> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (id === "ongoing") {
          out[id] = ongoing.some((w) => text.includes(w)) ? 0.9 : 0.1;
          continue;
        }
        const name = /Is this about (.+?)(?: \(|,)/.exec(q.instructions)?.[1] ?? "";
        const keys = [name.toLowerCase(), ...(words[name] ?? [])];
        const shown = [...q.instructions.matchAll(/These belong to [^:]+: (.+?)\.(?: These|$)/g)].flatMap(
          (m) => m[1]!.toLowerCase().match(/[a-z]{4,}/g) ?? [],
        );
        const notShown = [...q.instructions.matchAll(/These don't: (.+?)\.$/g)].flatMap(
          (m) => m[1]!.toLowerCase().match(/[a-z]{4,}/g) ?? [],
        );
        const hit = keys.some((k) => k && text.includes(k)) || shown.some((w) => text.includes(w) && !notShown.includes(w));
        out[id] = hit ? 0.9 : 0.05;
      }
      return out;
    },
  };
}

// --- extensions, run in-process ---------------------------------------------------------------------
// A Dynamic Worker's gate would reach the real service, which tests never do (CLAUDE.md). So the tests run
// each extension's module here, with the same rules as the gate: placeholders filled with the secrets, and
// only the manifest's hosts, over the test's fake network (`seams.fetch`).

import { seams } from "../src/agent/seams";
import { allowedHost, fill, textual } from "../src/extensions";
import { type Extension, useFetch } from "../../extensions/sdk";
import brave from "../../extensions/brave";
import claudeCode from "../../extensions/claude-code";
import codex from "../../extensions/codex";
import exa from "../../extensions/exa";
import github from "../../extensions/github";
import gmail from "../../extensions/gmail";
import icloud from "../../extensions/icloud";
import linear from "../../extensions/linear";
import mapbox from "../../extensions/mapbox";
import openMeteo from "../../extensions/open-meteo";
import osm from "../../extensions/osm";
import owntracks from "../../extensions/owntracks";
import tavily from "../../extensions/tavily";
import resend from "../../extensions/resend";
import telegram from "../../extensions/telegram";
import telnyx from "../../extensions/telnyx";

export const EXTENSIONS: Record<string, Extension> = {
  brave,
  "claude-code": claudeCode,
  codex,
  exa,
  github,
  gmail,
  icloud,
  linear,
  mapbox,
  "open-meteo": openMeteo,
  osm,
  owntracks,
  tavily,
  resend,
  telegram,
  telnyx,
};

/** The requests extensions made in this test, as the gate let them out (secrets filled in). */
export const extensionRequests: Array<{ ext: string; url: string; init: RequestInit }> = [];

export function runExtensionsHere(more: Record<string, Extension> = {}): void {
  seams.extension = async ({ id, method, args, ctx, secrets, hosts }) => {
    const ext = more[id] ?? EXTENSIONS[id];
    if (!ext) throw new Error(`The test has no extension called ${id}.`);
    const nonce = "testnonce" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    useFetch(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      const url = fill(req.url, secrets, nonce, { url: true });
      const host = new URL(url).hostname;
      if (!allowedHost(host, hosts))
        return new Response(`Atlas's gate refused ${host}: the ${ext.manifest.name} extension may reach only ${hosts.join(", ")}.`, {
          status: 403,
        });
      const headers = new Headers();
      for (const [k, v] of req.headers) headers.set(k, fill(v, secrets, nonce, { authorization: k === "authorization" }));
      // As at the gate: text bodies get their secrets put in; anything else (a file) goes as it is.
      const body = req.body
        ? textual(req.headers.get("content-type"))
          ? fill(await req.text(), secrets, nonce)
          : await req.formData().catch(() => null)
        : undefined;
      const out: RequestInit = { method: req.method, headers, ...(body != null ? { body } : {}) };
      extensionRequests.push({ ext: id, url, init: out });
      if (!seams.fetch) throw new Error(`An extension (${id}) reached for ${host}, and this test has no fake network.`);
      return seams.fetch(url, out);
    });
    const fn = (ext as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
    if (typeof fn !== "function") throw new Error(`${ext.manifest.name} has no ${method} call.`);
    const value = await fn.call(
      ext,
      {
        ...ctx,
        secret: (n: string) => `{{secret:${nonce}:${n}}}`,
        basic: (u: string, n: string) => `Basic {{basic:${nonce}:${btoa(u)}:${n}}}`,
      },
      ...JSON.parse(JSON.stringify(args)),
    );
    // What crosses the sandbox's edge is JSON.
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  };
}

runExtensionsHere();

/**
 * One call to an extension's module, outside any agent: with the gate's rules (its placeholders filled with
 * `secrets`, only its hosts) over `fetch`. Throws the extension's Failure as it would come back.
 */
export async function runExt<T>(
  ext: Extension,
  method: string,
  args: unknown[],
  o: {
    fetch: typeof fetch;
    secrets?: Record<string, string>;
    settings?: Record<string, string>;
    state?: unknown;
    cursor?: unknown;
    data?: unknown;
    address?: string;
    now?: number;
  },
): Promise<T> {
  const secrets = o.secrets ?? {};
  const nonce = "testnonce" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  useFetch(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = fill(req.url, secrets, nonce, { url: true });
    const host = new URL(url).hostname;
    if (!allowedHost(host, ext.manifest.hosts)) return new Response(`Atlas's gate refused ${host}.`, { status: 403 });
    const headers = new Headers();
    for (const [k, v] of req.headers) headers.set(k, fill(v, secrets, nonce, { authorization: k === "authorization" }));
    const body = req.body ? fill(await req.text(), secrets, nonce) : undefined;
    return o.fetch(url, { method: req.method, headers, ...(body !== undefined ? { body } : {}) });
  });
  const fn = (ext as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method]!;
  return fn.call(
    ext,
    {
      cursor: o.cursor ?? null,
      state: o.state ?? null,
      settings: o.settings ?? {},
      now: o.now ?? Date.now(),
      tz: "America/New_York",
      ...(o.address ? { address: o.address } : {}),
      ...(o.data !== undefined ? { data: o.data } : {}),
      secret: (n: string) => `{{secret:${nonce}:${n}}}`,
      basic: (u: string, n: string) => `Basic {{basic:${nonce}:${btoa(u)}:${n}}}`,
    },
    ...args,
  );
}
