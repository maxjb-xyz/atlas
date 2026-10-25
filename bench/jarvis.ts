// The Jarvis bar (VISION §23.7, M7 line C10) against a deployed Atlas. It
// talks to Atlas the way the app does, plays the scenarios in jarvis.json,
// and for each one measures how soon the reply's first words came, how long
// the run took, how many tokens the turn sent the brain and which tools it
// used. Hard checks are made here; a judge brain on the deployment
// (POST /api/judge) reads each conversation against what a person who's good
// at this would do.
//
//   ATLAS_OWNER_SECRET=... npm run eval:jarvis -w bench -- --url https://atlas.<you>.workers.dev
//   --only hey,status   play only these scenarios
//   --no-judge          hard checks only
//   --job-wait 120      watch a job at most this many seconds (each scenario sets its own, up to 300)
//   --turn-timeout 180  give up on a reply after this many seconds
//
// Bench turns go into the owner's real thread, and earlier scenarios are in
// the context of later ones. Reminders and other changes they make are undone
// at the end, and every job they start is stopped, even after a failure or
// Ctrl-C. Exits non-zero if any scenario fails.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));

interface Turn {
  say: string;
  /** Wait this long after the previous reply before sending. */
  after_ms?: number;
  /** Case-insensitive patterns this turn's reply must not match. */
  forbid?: string[];
}
interface Checks {
  first_text_ms?: number;
  tokens_in?: number;
  max_lines?: number;
  no_headers?: boolean;
  max_tools?: number;
  total_ms?: number;
}
interface Scenario {
  id: string;
  about: string;
  turns: Turn[];
  checks?: Checks;
  yardstick?: string;
  job?: { watch_ms?: number; comes_back?: boolean };
}
interface ScenarioFile {
  first_person: string[];
  scenarios: Scenario[];
}
interface LogRow {
  seq: number;
  id: string;
  actor: string;
  kind: string;
  run_id: string | null;
  surface: string | null;
  body: Record<string, unknown>;
}
interface JobView {
  id: string;
  title: string;
  state: string;
  activity?: string;
  status: string | null;
  run_id: string | null;
  result: string | null;
  owned?: { phase: string; latest: { text: string } | null; question: string | null };
  goal?: { phase: string; question: { text: string } | null };
}
interface TurnResult {
  say: string;
  run_id: string | null;
  state: string;
  reply: string;
  brain: string | null;
  first_text_ms: number | null;
  first_status_ms: number | null;
  /** The first thing the owner sees: Atlas's first words, or on a lookup its status line ("Checking your calendar"). */
  first_seen_ms: number | null;
  total_ms: number | null;
  tokens_in: number | null;
  /** Model calls in the run, from run.end: tokens in are checked per call. */
  calls: number | null;
  tokens_cached: number | null;
  tools: string[];
  error?: string;
}
interface Verdict {
  passed: boolean;
  failed: string[];
  notes: string;
  judge?: string | null;
}
interface ScenarioResult {
  id: string;
  passed: boolean;
  failed: string[];
  turns: TurnResult[];
  jobs: Array<{ id: string; title: string; came_back: boolean; stopped: string }>;
  /** What Atlas said on a job it started, after its reply. */
  later: string[];
  judge: Verdict | null;
}

// --- arguments ----------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (opt("url") ?? process.env.ATLAS_URL ?? "").replace(/\/$/, "");
const secret = process.env.ATLAS_OWNER_SECRET ?? "";
const only = opt("only")?.split(",");
const judging = !args.includes("--no-judge");
const jobWaitCap = Number(opt("job-wait") ?? "300") * 1000;
const turnTimeout = Number(opt("turn-timeout") ?? "180") * 1000;
if (!base || !secret || !/^https?:\/\//.test(base) || !Number.isFinite(jobWaitCap) || !Number.isFinite(turnTimeout)) {
  console.error(
    "Usage: ATLAS_OWNER_SECRET=... npm run eval:jarvis -w bench -- --url https://atlas.<you>.workers.dev [--only id,id] [--no-judge] [--job-wait 300] [--turn-timeout 180]",
  );
  process.exit(2);
}
const host = new URL(base).host;
const headers = { authorization: `Bearer ${secret}` };

// --- HTTP ---------------------------------------------------------------------

/** A request to Atlas whose failure says what went wrong: the status, the host and Atlas's own words. */
async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`Couldn't reach ${host} for ${path}: ${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " Check ATLAS_OWNER_SECRET."
        : res.status === 404 && path === "/api/judge"
          ? " This Atlas has no judge yet: deploy a version with POST /api/judge, or pass --no-judge."
          : "";
    throw new Error(`${path}: HTTP ${res.status} from ${host}: ${text.slice(0, 400)}${hint}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path}: ${host} answered with something that isn't JSON: ${text.slice(0, 200)}`);
  }
}

/** The log since `seq`, every page of it. */
async function logSince(seq: number): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  for (let at = seq; ;) {
    const page = (await call(`/api/log?since=${at}`)) as { rows: LogRow[]; last_seq: number };
    rows.push(...page.rows);
    if (page.rows.length < 500) return rows;
    at = page.rows[page.rows.length - 1]!.seq;
  }
}
const lastSeq = async () => ((await call(`/api/log?since=${Number.MAX_SAFE_INTEGER}`)) as { last_seq: number }).last_seq;

// --- the socket ---------------------------------------------------------------

type Msg = Record<string, unknown> & { type?: string };
interface Seen {
  at: number;
  m: Msg;
}

/** Everything the socket said from when it was made, to wait on. */
class Tape {
  seen: Seen[] = [];
  #line: Line;
  constructor(line: Line) {
    this.#line = line;
  }
  async until(test: (m: Msg) => boolean, ms: number, what: string): Promise<Seen> {
    const deadline = performance.now() + ms;
    for (;;) {
      const hit = this.seen.find((s) => test(s.m));
      if (hit) return hit;
      if (this.#line.closed) throw new Error(`The socket to ${host} closed while waiting for ${what}: ${this.#line.closed}`);
      if (performance.now() >= deadline) {
        const last = this.seen.slice(-6).map((s) => (s.m.type === "atlas.error" ? `atlas.error: ${String(s.m.message)}` : s.m.type));
        throw new Error(`Timed out after ${Math.round(ms / 1000)} s waiting for ${what} (last messages: ${last.join(", ") || "none"})`);
      }
      await this.#line.tick();
    }
  }
  stop(): void {
    this.#line.tapes.delete(this);
  }
}

class Line {
  ws: WebSocket;
  tapes = new Set<Tape>();
  jobs: JobView[] = [];
  closed: string | null = null;
  #waiters = new Set<() => void>();

  constructor(url: string) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let m: Msg;
      try {
        m = JSON.parse(String(data)) as Msg;
      } catch {
        return;
      }
      if (!m.type?.startsWith("atlas.")) return;
      if (m.type === "atlas.jobs") this.jobs = m.jobs as JobView[];
      if (m.type === "atlas.snapshot") this.jobs = (m.jobs as JobView[]) ?? [];
      const at = performance.now();
      for (const t of this.tapes) t.seen.push({ at, m });
      this.#wake();
    });
    this.ws.on("close", (code, reason) => {
      this.closed = `code ${code}${reason.length ? `, ${String(reason)}` : ""}`;
      this.#wake();
    });
  }

  #wake(): void {
    for (const w of this.#waiters) w();
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += String(c)));
        res.on("end", () =>
          reject(
            new Error(
              `${host} refused the socket: HTTP ${res.statusCode}${body ? `: ${body.slice(0, 200)}` : ""}.${res.statusCode === 401 ? " Check ATLAS_OWNER_SECRET." : " Check the URL."}`,
            ),
          ),
        );
      });
      this.ws.once("error", (err) => reject(new Error(`Couldn't open the socket to ${host}: ${err.message}`)));
    });
  }

  tape(): Tape {
    const t = new Tape(this);
    this.tapes.add(t);
    return t;
  }

  send(msg: object): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error(`The socket to ${host} isn't open (${this.closed ?? "not connected"}).`);
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolves on the next message, or after 200 ms. */
  tick(): Promise<void> {
    return new Promise((r) => {
      const done = () => (this.#waiters.delete(done), clearTimeout(t), r());
      const t = setTimeout(done, 200);
      this.#waiters.add(done);
    });
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const textOf = (row: LogRow) => {
  const b = row.body;
  return String(b.text ?? b.question ?? b.result ?? b.error ?? "");
};

// --- a turn -------------------------------------------------------------------

async function turn(line: Line, scenario: string, n: number, say: string): Promise<TurnResult> {
  const clientId = `jarvis-${scenario}-${n}-${Math.random().toString(36).slice(2, 8)}`;
  const result: TurnResult = {
    say,
    run_id: null,
    state: "unknown",
    reply: "",
    brain: null,
    first_text_ms: null,
    first_seen_ms: null,
    calls: null,
    first_status_ms: null,
    total_ms: null,
    tokens_in: null,
    tokens_cached: null,
    tools: [],
  };
  const before = await lastSeq();
  const tape = line.tape();
  const t0 = performance.now();
  try {
    line.send({ type: "atlas.say", text: say, client_id: clientId });
    const started = await tape.until(
      (m) => (m.type === "atlas.run" && m.client_id === clientId) || m.type === "atlas.error",
      20_000,
      `the run for "${say}" to start`,
    );
    if (started.m.type === "atlas.error") throw new Error(`Atlas said: ${String(started.m.message)}`);
    const runId = String(started.m.run_id);
    result.run_id = runId;
    const end = await tape.until(
      (m) => m.type === "atlas.run" && m.run_id === runId && m.state !== "running",
      turnTimeout,
      `the reply to "${say}" to finish`,
    );
    result.state = String(end.m.state);
    result.total_ms = Math.round(end.at - t0);
    const mine = (s: Seen) => s.m.run_id === runId;
    const delta = tape.seen.find((s) => s.m.type === "atlas.delta" && mine(s));
    const outRow = tape.seen.find(
      (s) => s.m.type === "atlas.rows" && (s.m.rows as LogRow[]).some((r) => r.run_id === runId && r.kind === "message.out"),
    );
    const firstText = delta ?? outRow;
    result.first_text_ms = firstText ? Math.round(firstText.at - t0) : null;
    const status = tape.seen.find((s) => s.m.type === "atlas.status" && mine(s) && s.m.text);
    result.first_status_ms = status ? Math.round(status.at - t0) : null;
    const seen = [result.first_text_ms, result.first_status_ms].filter((x): x is number => x != null);
    result.first_seen_ms = seen.length ? Math.min(...seen) : null;
    const streamed = tape.seen
      .filter((s) => s.m.type === "atlas.delta" && mine(s))
      .map((s) => String(s.m.text))
      .join("");

    // The log is the saved truth: the reply, the tools, and what the run sent the brain.
    let rows: LogRow[] = [];
    for (let tries = 0; tries < 5; tries++) {
      rows = (await logSince(before)).filter((r) => r.run_id === runId);
      if (rows.some((r) => r.kind === "run.end")) break;
      await sleep(500);
    }
    const runEnd = rows.find((r) => r.kind === "run.end");
    const usage = runEnd?.body.usage as { input?: number; cached?: number } | undefined;
    result.tokens_in = typeof usage?.input === "number" ? usage.input : null;
    result.tokens_cached = typeof usage?.cached === "number" ? usage.cached : null;
    result.calls = typeof runEnd?.body.steps === "number" ? runEnd.body.steps : null;
    result.brain = typeof runEnd?.body.brain === "string" ? runEnd.body.brain : null;
    if (typeof runEnd?.body.error === "string") result.error = runEnd.body.error;
    result.tools = rows.filter((r) => r.kind === "tool.call").map((r) => String(r.body.name));
    result.reply =
      rows
        .filter((r) => r.kind === "message.out")
        .map(textOf)
        .join("\n\n")
        .trim() || streamed.trim();
  } catch (err) {
    result.state = "failed";
    result.error = errText(err);
  } finally {
    tape.stop();
  }
  return result;
}

// --- checks -------------------------------------------------------------------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const plain = (s: string) => s.replace(/[‘’]/g, "'");

function turnChecks(t: TurnResult, c: Checks, forbid: string[], label: string): string[] {
  const failed: string[] = [];
  const at = (what: string) => `${label}${what}`;
  if (t.state === "failed" || t.error) failed.push(at(`run failed: ${t.error ?? "no reason given"}`));
  else if (!t.reply.trim()) failed.push(at("no reply"));
  // What the owner waits on: Atlas's first words, or on a lookup its status line, then the answer (VISION §4.1, §11.2).
  if (c.first_text_ms != null && (t.first_seen_ms == null || t.first_seen_ms > c.first_text_ms))
    failed.push(at(t.first_seen_ms == null ? "nothing came" : `first words or status ${t.first_seen_ms} ms > ${c.first_text_ms}`));
  if (c.tokens_in != null) {
    const per = t.tokens_in != null ? Math.round(t.tokens_in / Math.max(1, t.calls ?? 1)) : null;
    if (per == null) failed.push(at("tokens in unknown (no usage on run.end)"));
    else if (per > c.tokens_in) failed.push(at(`tokens in per call ${per} > ${c.tokens_in}`));
  }
  const lines = t.reply.split("\n").filter((l) => l.trim()).length;
  if (c.max_lines != null && lines > c.max_lines) failed.push(at(`${lines} lines > ${c.max_lines}`));
  if (c.no_headers && /^ {0,3}#{1,6}\s/m.test(t.reply)) failed.push(at("markdown header"));
  if (c.max_tools != null && t.tools.length > c.max_tools) failed.push(at(`${t.tools.length} tool calls > ${c.max_tools}`));
  if (c.total_ms != null && (t.total_ms == null || t.total_ms > c.total_ms))
    failed.push(at(`took ${t.total_ms ?? "?"} ms > ${c.total_ms}`));
  for (const p of forbid) if (new RegExp(p, "i").test(plain(t.reply))) failed.push(at(`said /${p}/`));
  return failed;
}

function firstPerson(words: string[], texts: string[]): string[] {
  const found = new Set<string>();
  for (const w of words) {
    const re = new RegExp(`\\b${escape(w)}\\b`, "i");
    if (texts.some((t) => re.test(plain(t)))) found.add(w);
  }
  return [...found].map((w) => `first person: "${w}"`);
}

// --- jobs ---------------------------------------------------------------------

/** Whether a job has come back to the owner: it ended, or it waits on them. */
function cameBack(j: JobView): boolean {
  if (j.state !== "running") return true;
  return (
    j.activity === "waiting" || j.owned?.phase === "waiting" || j.goal?.phase === "waiting" || !!j.owned?.question || !!j.goal?.question
  );
}

async function stopJob(line: Line, id: string): Promise<string> {
  const job = line.jobs.find((j) => j.id === id);
  if (!job || job.state !== "running") return job ? `already ${job.state}` : "gone";
  const tape = line.tape();
  try {
    line.send({ type: "atlas.job.stop", id });
    const out = await tape.until(
      (m) =>
        (m.type === "atlas.jobs" && (m.jobs as JobView[]).some((j) => j.id === id && j.state !== "running")) || m.type === "atlas.error",
      15_000,
      `job ${id} to stop`,
    );
    return out.m.type === "atlas.error" ? `couldn't stop: ${String(out.m.message)}` : "stopped";
  } catch (err) {
    return `couldn't stop: ${errText(err)}`;
  } finally {
    tape.stop();
  }
}

// --- a scenario ---------------------------------------------------------------

const atlasKinds = new Set(["message.out", "job.update", "job.question", "job.result"]);

async function play(line: Line, s: Scenario, words: string[], known: Set<string>): Promise<ScenarioResult> {
  const out: ScenarioResult = { id: s.id, passed: false, failed: [], turns: [], jobs: [], later: [], judge: null };
  const checks = s.checks ?? {};
  // Everything said from here on, for what Atlas says on a job after its reply.
  const tape = line.tape();
  try {
    for (const [n, t] of s.turns.entries()) {
      if (t.after_ms) await sleep(t.after_ms);
      const r = await turn(line, s.id, n, t.say);
      out.turns.push(r);
      out.failed.push(...turnChecks(r, checks, t.forbid ?? [], s.turns.length > 1 ? `turn ${n + 1}: ` : ""));
      if (r.state === "failed" && !r.reply) break;
    }

    // A job it started: give it a moment to show, then watch it until it comes back to the owner or the time is up.
    await sleep(1500);
    const mine = () => line.jobs.filter((j) => !known.has(j.id));
    const watch = Math.min(s.job?.watch_ms ?? 0, jobWaitCap);
    if (watch > 0 && mine().length) {
      console.log(
        `  watching ${mine().length === 1 ? `"${mine()[0]!.title}"` : `${mine().length} jobs`} for up to ${Math.round(watch / 1000)} s`,
      );
      const deadline = performance.now() + watch;
      while (performance.now() < deadline && !mine().every(cameBack)) await line.tick();
    }
    // Atlas's words on its jobs: rows naming one of them or coming from their runs, and a job's question on the turn
    // that asked for it. The turns' own replies are already in the transcript.
    const turnRuns = new Set(out.turns.map((t) => t.run_id).filter(Boolean));
    const jobRuns = new Set(
      mine()
        .map((j) => j.run_id)
        .filter(Boolean),
    );
    const ids = new Set(mine().map((j) => j.id));
    for (const { m } of tape.seen) {
      if (m.type !== "atlas.rows") continue;
      for (const r of m.rows as LogRow[]) {
        if (r.actor !== "atlas" || !atlasKinds.has(r.kind)) continue;
        const job = r.body.job ?? r.body.item_id ?? r.body.job_id;
        const ours =
          (typeof job === "string" && ids.has(job)) ||
          (r.run_id != null && jobRuns.has(r.run_id)) ||
          (r.kind !== "message.out" && ((r.run_id != null && turnRuns.has(r.run_id)) || !job));
        const text = textOf(r).trim();
        if (ours && text && !out.later.includes(text)) out.later.push(text);
      }
    }
    for (const j of mine()) {
      for (const text of [j.owned?.latest?.text, j.goal?.question?.text, j.result]) {
        if (text?.trim() && !out.later.includes(text.trim())) out.later.push(text.trim());
      }
    }
    for (const j of mine()) {
      const back = cameBack(j);
      if (s.job?.comes_back && !back) out.failed.push(`still working after ${Math.round(watch / 1000)} s without coming back`);
      out.jobs.push({ id: j.id, title: j.title, came_back: back, stopped: await stopJob(line, j.id) });
      known.add(j.id);
    }
  } finally {
    tape.stop();
    for (const j of line.jobs) known.add(j.id);
  }

  out.failed.push(...firstPerson(words, [...out.turns.map((t) => t.reply), ...out.later]));

  if (judging && s.yardstick && out.turns.some((t) => t.reply)) {
    const transcript = [
      ...out.turns.flatMap((t) => [
        { who: "owner", text: t.say },
        { who: "atlas", text: t.reply || `(no reply: ${t.error ?? t.state})`, tools: t.tools },
      ]),
      ...out.later.map((text) => ({ who: "atlas", text: `(later, while working) ${text}` })),
    ].slice(0, 40);
    try {
      out.judge = (await call("/api/judge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yardstick: s.yardstick, transcript }),
      })) as Verdict;
      if (!out.judge.passed) out.failed.push(...(out.judge.failed.length ? out.judge.failed : ["did not pass"]).map((f) => `judge: ${f}`));
    } catch (err) {
      out.judge = { passed: false, failed: ["judge_unreachable"], notes: errText(err) };
      out.failed.push(`judge unreachable: ${errText(err)}`);
    }
  }
  out.passed = out.failed.length === 0;
  return out;
}

// --- cleaning up --------------------------------------------------------------

/** Stops every job the bench started and undoes what its runs changed, as far as Atlas can. */
async function cleanUp(line: Line, startJobs: Set<string>, startSeq: number): Promise<string[]> {
  const notes: string[] = [];
  for (const j of line.jobs.filter((j) => !startJobs.has(j.id) && j.state === "running")) {
    const how = await stopJob(line, j.id).catch((err: unknown) => `couldn't stop: ${errText(err)}`);
    notes.push(`job "${j.title}": ${how}`);
  }
  // Runs the owner started themselves while the bench ran are left alone.
  const rows = await logSince(startSeq);
  const theirs = new Set(
    rows.filter((r) => r.kind === "message.in" && r.run_id && !String(r.body.client_id ?? "").startsWith("jarvis-")).map((r) => r.run_id),
  );
  let undone = 0;
  for (const r of rows) {
    if (r.kind !== "tool.result" || theirs.has(r.run_id) || !(r.body.receipt as { undo?: unknown } | undefined)?.undo) continue;
    line.send({ type: "atlas.undo", log_id: r.id });
    undone++;
    await sleep(150);
  }
  if (undone) notes.push(`undid ${undone} change${undone === 1 ? "" : "s"} (reminders and the like)`);
  return notes;
}

// --- the run ------------------------------------------------------------------

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : null;
};
const p90 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)]! : null;
};
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

async function main() {
  const file = JSON.parse(await readFile(join(here, "jarvis.json"), "utf8")) as ScenarioFile;
  const scenarios = file.scenarios.filter((s) => !only || only.includes(s.id));
  if (!scenarios.length)
    throw new Error(`No scenario matches --only ${only?.join(",")}. They are: ${file.scenarios.map((s) => s.id).join(", ")}.`);

  // The log first: it checks the URL and the secret with a plain answer before the socket.
  const startSeq = await lastSeq();
  const line = new Line(`${base.replace(/^http/, "ws")}/agents/person-agent/owner`);
  await line.open();
  const hello = line.tape();
  line.send({ type: "atlas.hello" });
  await hello.until((m) => m.type === "atlas.snapshot", 20_000, "Atlas's first snapshot");
  hello.stop();
  const startJobs = new Set(line.jobs.map((j) => j.id));
  const known = new Set(startJobs);

  console.log(
    `Jarvis bar against ${host}: ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}. Turns go into your real thread.\n`,
  );
  let cleaning: Promise<string[]> | null = null;
  const clean = () => (cleaning ??= cleanUp(line, startJobs, startSeq).catch((err: unknown) => [`cleaning up failed: ${errText(err)}`]));
  process.once("SIGINT", () => {
    console.log("\nStopped. Cleaning up...");
    void clean().then((notes) => {
      for (const n of notes) console.log(`  ${n}`);
      process.exit(130);
    });
  });

  const results: ScenarioResult[] = [];
  try {
    for (const s of scenarios) {
      console.log(`${s.id}: ${s.about}`);
      const r = await play(line, s, file.first_person, known);
      results.push(r);
      for (const t of r.turns) console.log(`  > ${t.say}\n  < ${(t.reply || t.error || "").replace(/\n/g, " / ").slice(0, 200)}`);
      for (const l of r.later) console.log(`  < (later) ${l.replace(/\n/g, " / ").slice(0, 200)}`);
      console.log(`  ${r.passed ? "PASS" : `FAIL: ${r.failed.join("; ")}`}\n`);
    }
  } finally {
    const notes = await clean();
    if (notes.length) console.log(`Cleaned up: ${notes.join("; ")}.\n`);
    line.close();
  }

  // --- the report ---
  const ms = (xs: Array<number | null>) => xs.map((x) => (x == null ? "-" : String(x))).join(" / ");
  const table = [
    "| Scenario | Result | First seen ms | First text ms | Total ms | Tokens in (cached) | Failed | Judge |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.passed ? "PASS" : "FAIL"} | ${ms(r.turns.map((t) => t.first_seen_ms))} | ${ms(r.turns.map((t) => t.first_text_ms))} | ${ms(r.turns.map((t) => t.total_ms))} | ${r.turns.map((t) => (t.tokens_in == null ? "-" : `${t.tokens_in} (${t.tokens_cached ?? 0})`)).join(" / ")} | ${cell(r.failed.join("; ") || "-")} | ${cell(r.judge ? `${r.judge.notes}${r.judge.judge ? ` (${r.judge.judge})` : ""}` : "-")} |`,
    ),
  ];
  const turns = results.flatMap((r) => r.turns);
  const first = turns.map((t) => t.first_seen_ms).filter((x): x is number => x != null);
  const cached = turns.reduce((n, t) => n + (t.tokens_cached ?? 0), 0);
  const all = turns.reduce((n, t) => n + (t.tokens_in ?? 0), 0);
  const tokens = turns.map((t) => t.tokens_in).filter((x): x is number => x != null);
  const passed = results.filter((r) => r.passed).length;
  const summary =
    `${passed} of ${results.length} scenarios passed. ` +
    `First seen (words or status line): median ${median(first) ?? "-"} ms, p90 ${p90(first) ?? "-"} ms. ` +
    `Tokens in: median ${median(tokens) ?? "-"}, p90 ${p90(tokens) ?? "-"}, ${all ? Math.round((100 * cached) / all) : 0}% from the cache.` +
    (judging ? "" : " Not judged (--no-judge).");
  console.log(`${table.join("\n")}\n\n${summary}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(join(here, "results"), { recursive: true });
  const out = join(here, "results", `jarvis-${stamp}.json`);
  await writeFile(out, JSON.stringify({ base, at: new Date().toISOString(), judged: judging, summary, results }, null, 2));
  console.log(`Full results: bench/results/jarvis-${stamp}.json`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(errText(err));
  process.exit(1);
});
