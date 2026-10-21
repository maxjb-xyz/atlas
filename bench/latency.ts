// The M0 voice benchmark (VISION §25). It talks to a deployed Atlas the way
// the app does, speaks recorded prompts into the voice pipeline in real time,
// and measures from the end of the speech to the first audio back. It also
// asks the same prompts in text, so the answers and tool calls can be
// compared ("the same answers as text").
//
//   ATLAS_OWNER_SECRET=... ELEVENLABS_API_KEY=... npm run bench -- --url https://atlas.<you>.workers.dev
//   add --sweep to try every voice brain and speech-in option in candidates.json
//
// Bench turns go into the owner's real thread. Reminders they create are undone at the end.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const RATE = 16_000;
const FRAME_MS = 20;
const FRAME_BYTES = (RATE * 2 * FRAME_MS) / 1000;
const TARGET_MS = 1000;

interface Scenario {
  id: string;
  kind: "no_lookup" | "lookup";
  text: string;
}
interface BrainChoice {
  provider: "chatgpt" | "workers-ai";
  model: string;
}
interface Config {
  voice: BrainChoice[];
  speech_in: string;
}
interface VoiceResult {
  scenario: string;
  kind: Scenario["kind"];
  round: number;
  heard: string | null;
  said: string | null;
  first_audio_ms: number | null;
  server: Record<string, unknown> | null;
  error?: string;
}
interface TextResult {
  scenario: string;
  reply: string;
  first_text_ms: number | null;
  ms: number;
  brain: string | null;
  state: string;
}
interface LogRow {
  seq: number;
  id: string;
  kind: string;
  run_id: string | null;
  surface: string | null;
  body: Record<string, unknown>;
}

// --- arguments ----------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = (opt("url") ?? process.env.ATLAS_URL ?? "").replace(/\/$/, "");
const secret = process.env.ATLAS_OWNER_SECRET ?? "";
const rounds = Number(opt("rounds", "2"));
const only = opt("only");
if (!base || !secret) {
  console.error(
    "Usage: ATLAS_OWNER_SECRET=... npm run bench -- --url https://atlas.<you>.workers.dev [--sweep] [--rounds 2] [--only s1,s2]",
  );
  process.exit(1);
}
const headers = { authorization: `Bearer ${secret}` };

// --- prompt audio -------------------------------------------------------------

/** 16 kHz mono 16-bit PCM for each prompt, made once with ElevenLabs and cached in bench/audio. */
async function audioFor(s: Scenario): Promise<Buffer> {
  const file = join(here, "audio", `${s.id}.pcm`);
  if (existsSync(file)) return readFile(file);
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error(`No audio for "${s.id}". Set ELEVENLABS_API_KEY once to make it, or put 16 kHz mono PCM at ${file}.`);
  const voice = process.env.BENCH_VOICE_ID ?? "EXAVITQu4vr4xnSDxMaL";
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: s.text, model_id: "eleven_flash_v2_5" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs couldn't make the prompt audio: HTTP ${res.status} ${await res.text()}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, pcm);
  return pcm;
}

// --- the socket ---------------------------------------------------------------

class Line {
  ws: WebSocket;
  json: Array<Record<string, unknown>> = [];
  audioAt: number[] = [];
  #waiters = new Set<() => void>();

  constructor(url: string) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) this.audioAt.push(performance.now());
      else {
        try {
          this.json.push(JSON.parse(String(data)));
        } catch {}
      }
      for (const w of this.#waiters) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`Atlas refused the socket: HTTP ${res.statusCode}. Check the URL and secret.`)),
      );
      this.ws.once("error", reject);
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Waits for a JSON message matching `test`, taking it off the list. */
  async take(test: (m: Record<string, unknown>) => boolean, ms = 20_000): Promise<Record<string, unknown>> {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      const i = this.json.findIndex(test);
      if (i >= 0) return this.json.splice(i, 1)[0]!;
      await new Promise<void>((r) => {
        const done = () => (this.#waiters.delete(done), r());
        this.#waiters.add(done);
        setTimeout(done, 100);
      });
    }
    const seen = this.json.map((m) => (m.type === "error" ? `error: ${m.message}` : m.type)).slice(-6);
    throw new Error(`timed out waiting for Atlas (last messages: ${seen.join(", ") || "none"})`);
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends audio paced like a real microphone. */
async function stream(line: Line, pcm: Buffer): Promise<void> {
  const start = performance.now();
  for (let i = 0, n = 0; i < pcm.length; i += FRAME_BYTES, n++) {
    line.ws.send(pcm.subarray(i, Math.min(i + FRAME_BYTES, pcm.length)));
    const due = start + (n + 1) * FRAME_MS;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

/** Keeps feeding silence, as a live mic would, until `stop` resolves. */
function silence(line: Line): () => void {
  let on = true;
  const frame = Buffer.alloc(FRAME_BYTES);
  (async () => {
    while (on) {
      if (line.ws.readyState === WebSocket.OPEN) line.ws.send(frame);
      await sleep(FRAME_MS);
    }
  })();
  return () => {
    on = false;
  };
}

async function voiceTurn(line: Line, s: Scenario, round: number, pcm: Buffer): Promise<VoiceResult> {
  line.json = [];
  line.audioAt = [];
  await stream(line, pcm);
  const end = performance.now();
  const stop = silence(line);
  const result: VoiceResult = { scenario: s.id, kind: s.kind, round, heard: null, said: null, first_audio_ms: null, server: null };
  try {
    const heard = await line.take((m) => m.type === "transcript" && m.role === "user", 15_000);
    result.heard = String(heard.text ?? "");
    const said = await line.take((m) => m.type === "transcript_end", 60_000);
    result.said = String(said.text ?? "");
    result.first_audio_ms = line.audioAt.length ? Math.round(line.audioAt[0]! - end) : null;
    const metrics = await line.take((m) => m.type === "turn_metrics", 30_000).catch(() => null);
    result.server = metrics;
    await line.take((m) => m.type === "status" && m.status === "listening", 60_000).catch(() => null);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.first_audio_ms ??= line.audioAt.length ? Math.round(line.audioAt[0]! - end) : null;
  } finally {
    stop();
  }
  await sleep(1500);
  return result;
}

// --- text, the log, and settings ----------------------------------------------

async function textTurn(s: Scenario): Promise<TextResult> {
  const res = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ text: s.text }),
  });
  if (!res.ok) throw new Error(`/api/turn: HTTP ${res.status} ${await res.text()}`);
  const r = (await res.json()) as Omit<TextResult, "scenario">;
  return { scenario: s.id, ...r };
}

async function logSince(seq: number): Promise<{ rows: LogRow[]; last_seq: number }> {
  const res = await fetch(`${base}/api/log?since=${seq}`, { headers });
  if (!res.ok) throw new Error(`/api/log: HTTP ${res.status}`);
  return (await res.json()) as { rows: LogRow[]; last_seq: number };
}

/** Tool names per run, in the order the runs started. */
function toolsByRun(rows: LogRow[], surface: string): string[][] {
  const runs: string[] = [];
  const tools = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.run_id) continue;
    if (r.kind === "message.in" && r.surface === surface) {
      runs.push(r.run_id);
      tools.set(r.run_id, []);
    }
    if (r.kind === "tool.call" && tools.has(r.run_id)) tools.get(r.run_id)!.push(String(r.body.name));
  }
  return runs.map((id) => tools.get(id)!);
}

// --- the run ------------------------------------------------------------------

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};
const share = (xs: number[], limit: number) => (xs.length ? xs.filter((x) => x <= limit).length / xs.length : 0);

async function main() {
  const file = JSON.parse(await readFile(join(here, "scenarios.json"), "utf8")) as { scenarios: Scenario[] };
  const scenarios = file.scenarios.filter((s) => !only || only.split(",").includes(s.id));
  const pcm = new Map<string, Buffer>();
  for (const s of scenarios) pcm.set(s.id, await audioFor(s));

  const wsUrl = `${base.replace(/^http/, "ws")}/agents/person-agent/owner`;
  const line = new Line(wsUrl);
  await line.open();
  line.send({ type: "atlas.hello" });
  const snapshot = await line.take((m) => m.type === "atlas.snapshot");
  const original = (
    snapshot.view as { settings: { brains: { main: BrainChoice[]; voice: BrainChoice[] }; voice: Record<string, unknown> } }
  ).settings;

  const configs: Config[] = [];
  if (flag("sweep")) {
    const c = JSON.parse(await readFile(join(here, "candidates.json"), "utf8")) as { voice: BrainChoice[]; speech_in: string[] };
    const current = [...original.brains.main, ...original.brains.voice].find((b) => b.provider === "chatgpt")?.model ?? "";
    for (const speech_in of c.speech_in) {
      for (const v of c.voice) {
        const model = v.provider === "chatgpt" && !v.model ? current : v.model;
        if (model) configs.push({ voice: [{ ...v, model }], speech_in });
      }
    }
  } else {
    configs.push({ voice: original.brains.voice, speech_in: String(original.voice.speech_in) });
  }

  const startSeq = (await logSince(Number.MAX_SAFE_INTEGER)).last_seq;
  console.log(`Text turns (${scenarios.length})...`);
  const text: TextResult[] = [];
  for (const s of scenarios) text.push(await textTurn(s));
  const afterText = (await logSince(Number.MAX_SAFE_INTEGER)).last_seq;

  const report: Array<{ config: Config; turns: VoiceResult[]; tools: string[][] }> = [];
  try {
    for (const config of configs) {
      const label = `${config.voice.map((b) => `${b.provider}:${b.model}`).join(" > ")} · ${config.speech_in}`;
      console.log(`Voice: ${label}`);
      line.send({
        type: "atlas.settings.update",
        patch: { brains: { ...original.brains, voice: config.voice }, voice: { ...original.voice, speech_in: config.speech_in } },
      });
      await line.take((m) => m.type === "atlas.view");
      const before = (await logSince(Number.MAX_SAFE_INTEGER)).last_seq;
      line.send({ type: "start_call" });
      const started = await line.take((m) => (m.type === "status" && m.status === "listening") || m.type === "error", 15_000);
      if (started.type === "error") throw new Error(`The call didn't start: ${String(started.message)}. Check Settings → Voice.`);
      const turns: VoiceResult[] = [];
      for (let round = 1; round <= rounds; round++) {
        for (const s of scenarios) {
          const r = await voiceTurn(line, s, round, pcm.get(s.id)!);
          console.log(`  ${s.id.padEnd(10)} ${String(r.first_audio_ms ?? "-").padStart(6)} ms  ${r.error ?? (r.said ?? "").slice(0, 70)}`);
          turns.push(r);
        }
      }
      line.send({ type: "end_call" });
      await sleep(500);
      report.push({ config, turns, tools: toolsByRun((await logSince(before)).rows, "voice") });
    }
  } finally {
    // Put the owner's settings back, and undo any reminders the bench made, even after a failure.
    line.send({ type: "end_call" });
    line.send({ type: "atlas.settings.update", patch: { brains: original.brains, voice: original.voice } });
    await line.take((m) => m.type === "atlas.view").catch(() => null);
    const all = (await logSince(startSeq)).rows;
    for (const r of all) {
      if (r.kind === "tool.result" && (r.body.receipt as { undo?: unknown } | undefined)?.undo) {
        line.send({ type: "atlas.undo", log_id: r.id });
        await sleep(100);
      }
    }
  }
  const textTools = toolsByRun(
    (await logSince(startSeq)).rows.filter((r) => r.seq <= afterText),
    "api",
  );
  line.close();

  // --- the report ---
  const lines: string[] = [
    `# Atlas voice benchmark, ${new Date().toISOString()}`,
    "",
    `Target: ${base}. Rounds: ${rounds}. Latency is from the end of the spoken prompt to the first audio back, measured here.`,
    "",
  ];
  lines.push("| Voice brain · speech in | No lookup p50 | ≤ 1 s | Lookup p50 | ≤ 1 s | Errors | Exit |", "|---|---|---|---|---|---|---|");
  for (const r of report) {
    const no = r.turns.filter((t) => t.kind === "no_lookup" && t.first_audio_ms != null).map((t) => t.first_audio_ms!);
    const yes = r.turns.filter((t) => t.kind === "lookup" && t.first_audio_ms != null).map((t) => t.first_audio_ms!);
    const errors = r.turns.filter((t) => t.error).length;
    const pass = median(no) <= TARGET_MS && median(yes) <= TARGET_MS && errors === 0;
    lines.push(
      `| ${r.config.voice.map((b) => `${b.provider}:${b.model}`).join(" > ")} · ${r.config.speech_in} | ${median(no)} ms | ${Math.round(share(no, TARGET_MS) * 100)}% | ${median(yes)} ms | ${Math.round(share(yes, TARGET_MS) * 100)}% | ${errors} | ${pass ? "pass" : "not yet"} |`,
    );
  }
  lines.push(
    "",
    "Exit (§25): with no lookup, half of replies start speaking within 1 s; with a lookup, an honest status line within 1 s; and the same answers as text.",
    "",
  );
  lines.push(
    "## Same answers as text",
    "",
    "Tools each prompt used, in text and in the first voice round of the first configuration. Read the answers side by side below.",
    "",
  );
  lines.push("| Prompt | Text tools | Voice tools | Match |", "|---|---|---|---|");
  const firstVoice = report[0];
  scenarios.forEach((s, i) => {
    const t = (textTools[i] ?? []).join(", ") || "none";
    const v = (firstVoice?.tools[i] ?? []).join(", ") || "none";
    lines.push(`| ${s.id} | ${t} | ${v} | ${t === v ? "yes" : "check"} |`);
  });
  lines.push("", "## Answers", "");
  scenarios.forEach((s, i) => {
    const v = firstVoice?.turns.find((t) => t.scenario === s.id);
    lines.push(
      `**${s.text}**`,
      "",
      `- Text (${text[i]?.brain ?? "?"}, first words ${text[i]?.first_text_ms ?? "?"} ms): ${text[i]?.reply ?? ""}`,
      `- Voice (heard "${v?.heard ?? ""}"): ${v?.said ?? v?.error ?? ""}`,
      "",
    );
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(join(here, "results"), { recursive: true });
  await writeFile(join(here, "results", `${stamp}.json`), JSON.stringify({ base, rounds, text, report }, null, 2));
  await writeFile(join(here, "results", `${stamp}.md`), lines.join("\n"));
  console.log(`\n${lines.slice(0, 6 + report.length).join("\n")}\n\nFull report: bench/results/${stamp}.md`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
