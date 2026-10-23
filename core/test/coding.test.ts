import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PersonAgent, seams, type WorkspaceStub } from "../src/agent";
import type { CodingJob } from "../src/agent/coding";
import { install, setExtSecrets } from "../src/extensions";
import type { Sql } from "../src/store/db";
import { migrate } from "../src/store/db";
import { getItem } from "../src/store/agenda";
import type { KeyRule, RunEvent } from "../src/workspace";
import type { Brain } from "../src/brains/types";
import { call, env, fakeCalendar, fakeEmbedder, say, scripted, type Step } from "./helpers";

/** One turn of the fake coding agent: what it does when prompted. */
interface Turn {
  updates?: object[];
  /** A permission request before it finishes, with the paths it touches. */
  ask?: { title: string; paths: string[] };
  say?: string;
  stop?: string;
  /** Never ends on its own (until cancelled). */
  hang?: boolean;
  /** Waits for the test's go (st.go()) before it starts. */
  held?: boolean;
  cost?: number;
}

/**
 * A workspace with a fake bridge and a fake ACP agent behind it: it answers
 * Atlas's requests as the real adapters do, plays a turn per prompt, and
 * keeps every line numbered until it's read.
 */
function fakeWorkspace(turns: Turn[]) {
  const st = {
    seq: 0,
    lines: [] as Array<{ seq: number; text: string }>,
    running: false,
    asleep: false,
    here: false,
    session: null as string | null,
    pending: null as number | null,
    afterAsk: null as null | (() => void),
    prompts: [] as string[],
    answers: [] as Array<{ id: unknown; result: unknown }>,
    commands: [] as Array<{ command: string; cwd?: string; rules?: KeyRule[] }>,
    envs: [] as Array<Record<string, string>>,
    gates: [] as unknown[],
    starts: 0,
    loads: 0,
    saves: 0,
    restores: 0,
    methods: [] as string[],
    held: null as null | (() => void),
    go() {
      const f = st.held;
      st.held = null;
      f?.();
    },
  };
  const emit = (m: object) => {
    st.seq += 1;
    st.lines.push({ seq: st.seq, text: JSON.stringify({ jsonrpc: "2.0", ...m }) });
  };
  const update = (u: object) => emit({ method: "session/update", params: { sessionId: st.session, update: u } });
  const finishTurn = (t: Turn, id: number) => {
    if (t.say) update({ sessionUpdate: "agent_message_chunk", messageId: `m${id}`, content: { type: "text", text: t.say } });
    if (t.cost != null) update({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: t.cost, currency: "USD" } });
    if (t.hang) return;
    emit({ id, result: { stopReason: t.stop ?? "end_turn" } });
    st.pending = null;
  };
  const handle = (m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }) => {
    if (m.method) st.methods.push(m.method);
    if (m.method === "initialize") emit({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === "authenticate" || m.method === "session/set_mode") emit({ id: m.id, result: {} });
    else if (m.method === "session/new") {
      st.session = "sess-1";
      emit({ id: m.id, result: { sessionId: "sess-1" } });
    } else if (m.method === "session/load") {
      st.loads += 1;
      if (m.params?.sessionId !== st.session) emit({ id: m.id, error: { code: -32002, message: "No such session" } });
      else {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(an old message, replayed)" } });
        emit({ id: m.id, result: {} });
      }
    } else if (m.method === "session/prompt") {
      st.prompts.push(String((m.params?.prompt as Array<{ text: string }>)[0]!.text));
      st.pending = m.id!;
      const t = turns.shift() ?? { say: "Nothing more to do." };
      if (t.held) {
        st.held = () => play(t, m.id!);
        return;
      }
      play(t, m.id!);
    } else if (m.method === "session/cancel") {
      if (st.pending != null) emit({ id: st.pending, result: { stopReason: "cancelled" } });
      st.pending = null;
    } else if (!m.method && m.id != null) {
      st.answers.push({ id: m.id, result: m.result });
      const f = st.afterAsk;
      st.afterAsk = null;
      f?.();
    }
  };
  const play = (t: Turn, id: number) => {
    for (const u of t.updates ?? []) update(u);
    if (t.ask) {
      emit({
        id: 900 + st.prompts.length,
        method: "session/request_permission",
        params: {
          sessionId: st.session,
          toolCall: {
            toolCallId: `t${st.prompts.length}`,
            title: t.ask.title,
            kind: "execute",
            locations: t.ask.paths.map((path) => ({ path })),
          },
          options: [
            { optionId: "allow-once", name: "Yes", kind: "allow_once" },
            { optionId: "reject", name: "No", kind: "reject_once" },
          ],
        },
      });
      st.afterAsk = () => finishTurn(t, id);
    } else finishTurn(t, id);
  };
  const status = () => ({ running: st.running, exit: st.running ? null : 0, signal: null, last: st.seq, stderr: "" });
  const stream = (events: RunEvent[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(new TextEncoder().encode(`${JSON.stringify(e)}\n`));
        c.close();
      },
    });
  const ws: WorkspaceStub = {
    async run(o) {
      st.commands.push({ command: o.command, ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.rules ? { rules: o.rules } : {}) });
      let out = "";
      if (o.command.includes("fetch -q --depth 50")) {
        st.here = true;
        out = "0123456789abcdef0123456789abcdef01234567\n";
      } else if (o.command.includes(" push ")) out = "commits: 2\n";
      else if (o.command.includes("npm test")) out = "12 passing\n";
      else if (o.command.includes("git diff")) out = "- off by one\n+ fixed\n";
      else if (o.command.includes("cat package.json")) out = '{ "scripts": { "test": "vitest" } }\n';
      return stream([{ out }, { done: { exit: 0, ms: 5, blocked: [], kept: "" } }]);
    },
    async read() {
      return { ok: false, error: "no" };
    },
    async list() {
      return null;
    },
    async preview() {
      return { token: "t", expires: 0 };
    },
    async status() {
      return { running: true, ready: true };
    },
    async restart() {},
    async jobAgent(o) {
      st.envs.push(o.env);
      st.gates.push(o.gate);
      if (st.running) return { ...status(), already: true, notes: [] };
      st.running = true;
      st.asleep = false;
      st.starts += 1;
      return { ...status(), already: false, notes: [] };
    },
    async jobSend(_id, lines) {
      if (!st.running) throw new Error("No agent is running for this job.");
      for (const l of lines) handle(JSON.parse(l));
      return status();
    },
    async jobRead(_id, after) {
      if (st.asleep) return { ok: false, gone: true, why: "The workspace is asleep, so the agent isn't running." };
      return { ok: true, lines: st.lines.filter((l) => l.seq > after), ...status() };
    },
    async jobStop() {
      st.running = false;
    },
    async jobSave() {
      st.saves += 1;
      return { ok: true, note: "" };
    },
    async jobRestore() {
      st.restores += 1;
      return { restored: true, note: "" };
    },
    async jobHere() {
      return st.here;
    },
  };
  return { ws, st, emit, update };
}

/** A fake GitHub API: the repo, and pull requests opened on it. */
function fakeGitHub() {
  const prs: Array<Record<string, unknown>> = [];
  seams.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/repos/ann/budget"))
      return Response.json({
        full_name: "ann/budget",
        description: "My budget app",
        default_branch: "main",
        html_url: "https://github.com/ann/budget",
      });
    if (u.endsWith("/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member"))
      return Response.json([
        { full_name: "ann/budget", description: "My budget app", default_branch: "main", html_url: "https://github.com/ann/budget" },
      ]);
    if (u.endsWith("/repos/ann/budget/pulls") && init?.method === "POST") {
      prs.push({ ...(JSON.parse(String(init.body)) as object), auth: new Headers(init.headers).get("authorization") });
      return Response.json({ number: 7, html_url: "https://github.com/ann/budget/pull/7" }, { status: 201 });
    }
    return new Response(`no fake for ${u}`, { status: 404 });
  };
  return prs;
}

/**
 * Scripted brains: the owner's runs (their turns, and Atlas telling them how a job went) play `owner`;
 * a job's looks play `looks`. Separate, so a look finishing and a report starting can't take each other's lines.
 */
function brain(owner: Step[], looks: Step[] = []) {
  const o = scripted(owner, "chatgpt", "gpt-5.6-terra");
  const l = scripted(looks, "chatgpt", "gpt-5.6-terra");
  const b: Brain = {
    provider: "chatgpt",
    model: "gpt-5.6-terra",
    stream: (req) => (req.system.includes("middleman on a coding job") ? l : o).brain.stream(req),
  };
  seams.makeBrain = (c) => (c.provider === "chatgpt" ? b : null);
  return { owner: o, looks: l };
}

const fresh = () => env.PersonAgent.get(env.PersonAgent.idFromName(`c-${crypto.randomUUID()}`));

async function until<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  ms = 8_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Steps the job until it reaches `phase` (decisions run as helpers in the background). */
const stepTo = async (agent: PersonAgent, id: string, phase: CodingJob["phase"], also: (j: CodingJob) => boolean = () => true) => {
  let last: CodingJob | null = null;
  try {
    return await until(async () => {
      last = await agent.apiCodingWake(id);
      return last && last.phase === phase && also(last) ? last : null;
    }, `the job to reach ${phase}`);
  } catch (err) {
    const j = last as CodingJob | null;
    throw new Error(
      `${(err as Error).message}; it's ${j?.phase} after ${j?.turns} turns (${j?.error ?? ""}): ${JSON.stringify(j?.log.slice(-6))}`,
    );
  }
};

function setUp(sql: Sql, agent: "claude-code" | "codex" = "claude-code") {
  migrate(sql);
  install(sql, { id: agent, source: "bundled" });
  if (agent === "claude-code") setExtSecrets(sql, "claude-code", { api_key: "sk-ant-test-key-123" });
  install(sql, { id: "github", source: "bundled" });
  setExtSecrets(sql, "github", { token: "ghp_test_token_456" });
}

const rows = (sql: Sql, kind: string) =>
  sql
    .exec<{ body: string }>(`SELECT body FROM log WHERE kind = ? ORDER BY seq`, kind)
    .toArray()
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);

beforeEach(() => {
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
});
afterEach(() => {
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
  seams.workspace = undefined;
  seams.fetch = null;
});

describe("coding jobs", { timeout: 30_000 }, () => {
  it("run end to end: the agent asks a routine question, Atlas answers it from the repo, reviews the work and opens a pull request", async () => {
    const { ws, st } = fakeWorkspace([
      {
        updates: [
          {
            sessionUpdate: "tool_call",
            toolCallId: "c1",
            title: "npm test",
            kind: "execute",
            status: "completed",
            rawInput: { command: "npm test" },
          },
        ],
        say: "One test fails in the date parser. Which test runner should I use, vitest or jest?",
      },
      { held: true, ask: { title: "npm test", paths: [] }, say: "Fixed: the parser was off by one. All 12 tests pass." },
    ]);
    seams.workspace = ws;
    const prs = fakeGitHub();
    const b = brain(
      [
        // The owner's turn starts the job.
        call("code_job", { title: "Budget app: failing test", repo: "ann/budget", task: "Fix the failing test in the budget app." }),
        say("Started: Claude Code is on it. Watch it in Home → Jobs."),
        // Atlas tells the owner how it went.
        say("Done: I opened a pull request on ann/budget that fixes the failing test."),
      ],
      [
        // Atlas's first look: the routine question, answered from the repo.
        call("job_run", { command: "cat package.json" }, "c_pkg"),
        call(
          "agent_reply",
          {
            text: "Use vitest: it's what package.json runs.",
            answered: { question: "Which test runner?", answer: "vitest", source: "package.json" },
          },
          "c_reply",
        ),
        say("Answered."),
        // The second look: the work is done; review it, then open the pull request.
        call("job_run", { command: "git diff main...HEAD" }, "c_diff"),
        call("job_run", { command: "npm test" }, "c_test"),
        call(
          "job_ready",
          { title: "Fix the off-by-one in the date parser", body: "The date parser was off by one; fixed, and the tests pass." },
          "c_ready",
        ),
        say("Publishing."),
      ],
    );
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      setUp(sql);
      const out = await agent.apiTurn("fix the failing test in my budget app");
      expect(out.reply).toContain("Started");
      const id = sql.exec<{ id: string }>(`SELECT id FROM coding`).one().id;

      // It clones with the token behind a nonce, branches, starts the agent and sends the brief.
      const working = await stepTo(agent, id, "working");
      const clone = st.commands[0]!;
      expect(clone.command).toContain("git remote add origin 'https://github.com/ann/budget.git'");
      expect(clone.command).toMatch(/http\.extraHeader='x-atlas-key: [0-9a-f]{32}'/);
      expect(clone.rules![0]).toMatchObject({
        host: "github.com",
        header: "authorization",
        value: `Basic ${btoa("x-access-token:ghp_test_token_456")}`,
      });
      expect(clone.rules![0]!.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(working.branch).toMatch(/^atlas\/budget-app-failing-test-/);
      expect(working.base_sha).toBe("0123456789abcdef0123456789abcdef01234567");
      // The agent gets a placeholder; the gate holds its key.
      expect(st.envs[0]).toMatchObject({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "atlas-gate-adds-the-key" });
      expect(JSON.stringify(st.envs[0])).not.toContain("sk-ant-test-key-123");
      expect(st.gates[0]).toEqual({
        allow: ["api.anthropic.com"],
        rules: [{ host: "api.anthropic.com", header: "x-api-key", value: "sk-ant-test-key-123" }],
      });
      expect(st.methods.slice(0, 4)).toEqual(["initialize", "session/new", "session/set_mode", "session/prompt"]);
      expect(st.prompts[0]).toContain("Fix the failing test in the budget app.");
      expect(st.prompts[0]).toContain("Don't push");

      // The routine question is answered by Atlas's first look; once that look is over, the agent's next turn plays.
      await stepTo(agent, id, "working", (j) => j.turns === 2 && !Object.keys(j.looks ?? {}).length);
      st.go();
      // The clock carries it the rest of the way: the review, the pull request.
      const done = await stepTo(agent, id, "done");
      // The routine question is answered without the owner, with its source.
      expect(done.answers).toEqual([expect.objectContaining({ q: "Which test runner?", a: "vitest", source: "package.json" })]);
      expect(st.prompts[1]).toBe("Use vitest: it's what package.json runs.");
      const look = b.looks.requests[0]!;
      expect(look.system).toContain("middleman on a coding job");
      expect(look.messages[0]!.content).toContain("Which test runner should I use");
      expect(look.messages[0]!.content).toContain("The agent ran: npm test");
      expect(look.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["agent_reply", "owner_ask", "job_run", "job_ready", "recall"]));
      expect(look.tools.map((t) => t.name)).not.toContain("code_job");

      // Its permission request inside the job's folder is a yes.
      expect(st.answers[0]).toEqual({ id: 902, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });

      // Atlas ran the review itself, pushed with the nonce, and opened the pull request through GitHub.
      const push = st.commands.find((c) => c.command.includes(" push "))!;
      expect(push.command).toContain("git add -A");
      expect(push.command).toMatch(/push -q --force origin 'HEAD:refs\/heads\/atlas\/budget-app-failing-test-/);
      expect(push.rules![0]!.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(prs).toEqual([
        expect.objectContaining({
          title: "Fix the off-by-one in the date parser",
          base: "main",
          head: expect.stringMatching(/^atlas\//),
          auth: "Bearer ghp_test_token_456",
          body: expect.stringContaining("Nothing is merged until you do."),
        }),
      ]);
      expect(done.pr).toEqual({ number: 7, link: "https://github.com/ann/budget/pull/7", title: "Fix the off-by-one in the date parser" });
      expect(getItem(sql, id)!.state).toBe("done");
      expect(rows(sql, "delivery").find((r) => r.channel === "code")).toMatchObject({
        to: "ann/budget",
        ok: true,
        link: "https://github.com/ann/budget/pull/7",
      });
      expect(rows(sql, "job.result")[0]).toMatchObject({
        state: "done",
        text: expect.stringContaining("https://github.com/ann/budget/pull/7"),
      });
      // Jobs shows the steps, the stream and what Atlas answered.
      const view = (await agent.apiJobs()).find((j) => j.id === id)!;
      expect(view.coding!.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
      expect(view.coding!.answers[0]).toMatchObject({ q: "Which test runner?", source: "package.json" });
      expect(view.coding!.log.some((e) => e.who === "tool" && e.text === "npm test")).toBe(true);
      // The owner hears it in the thread.
      await until(() => rows(sql, "message.out").some((r) => String(r.text).includes("opened a pull request")), "the report");
    });
  });

  it("bring a real decision to the owner as one question, in Inbox and on the chat with buttons, and carry on with the answer", async () => {
    const { ws, st } = fakeWorkspace([{ say: "Drop the old API or keep both?" }, { say: "Kept both.", hang: true }]);
    seams.workspace = ws;
    fakeGitHub();
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      setUp(sql);
      brain(
        [call("code_job", { title: "Budget API", repo: "ann/budget", task: "Move the budget API to v2." }), say("Started.")],
        [
          call("owner_ask", {
            question: "Drop the old API, or keep both?",
            options: ["Drop it", "Keep both"],
            why: "Two apps still call the old one.",
          }),
          say("Asked."),
        ],
      );
      await agent.apiTurn("move the budget api to v2");
      const id = sql.exec<{ id: string }>(`SELECT id FROM coding`).one().id;
      const waiting = await stepTo(agent, id, "waiting");
      expect(waiting.question).toMatchObject({ text: "Drop the old API, or keep both?", options: ["Drop it", "Keep both"] });
      const inbox = await agent.apiInbox();
      expect(inbox.find((i) => i.job?.id === id)).toMatchObject({
        kind: "question",
        job: { question: "Drop the old API, or keep both?", options: ["Drop it", "Keep both"] },
      });
      // The job was kept before it waits, so a container that sleeps meanwhile loses nothing.
      expect(st.saves).toBeGreaterThan(0);

      const out = await agent.apiJobSay(id, "Keep both");
      expect(out.ok).toBe(true);
      expect(st.prompts.at(-1)).toBe('The owner answered your question ("Drop the old API, or keep both?"): Keep both');
      const after = (await agent.apiCodingWake(id))!;
      expect(after.answers).toEqual([expect.objectContaining({ a: "Keep both", source: "you" })]);
      expect((await agent.apiInbox()).some((i) => i.job?.id === id)).toBe(false);
    });
  });

  it("say no to the agent outside its folder, and stop at the cap with what it spent", async () => {
    const { ws, st } = fakeWorkspace([{ ask: { title: "rm -rf /etc/hosts", paths: ["/etc/hosts"] }, cost: 6.25, hang: true }]);
    seams.workspace = ws;
    fakeGitHub();
    brain([
      call("code_job", { title: "Budget: cleanup", repo: "ann/budget", task: "Clean up." }),
      say("Started."),
      say("It stopped at its cap."),
    ]);
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      setUp(sql);
      await agent.apiTurn("clean up the budget app");
      const id = sql.exec<{ id: string }>(`SELECT id FROM coding`).one().id;
      const failed = await stepTo(agent, id, "failed");
      expect(st.answers[0]).toEqual({ id: 901, result: { outcome: { outcome: "selected", optionId: "reject" } } });
      expect(failed.log.some((e) => e.text.includes("/etc/hosts is outside the job's folder"))).toBe(true);
      expect(failed.error).toContain("reached this job's cap of $5.00 ($6.25 spent)");
      expect(st.methods).toContain("session/cancel");
      expect(getItem(sql, id)!.state).toBe("failed");
    });
  });

  it("carry on after the container was lost: the branch comes back, the agent loads its session, and it's told to go on", async () => {
    const { ws, st } = fakeWorkspace([
      { hang: true, say: "Working on it…" },
      { say: "Back, and working.", hang: true },
    ]);
    seams.workspace = ws;
    fakeGitHub();
    brain([call("code_job", { title: "Budget: long one", repo: "ann/budget", task: "A long change." }), say("Started.")]);
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      setUp(sql);
      await agent.apiTurn("make the long change");
      const id = sql.exec<{ id: string }>(`SELECT id FROM coding`).one().id;
      await stepTo(agent, id, "working", (j) => j.log.some((e) => e.text === "Working on it…"));
      // The container went away (a host restart): its folder and the agent's process with it.
      st.running = false;
      st.asleep = true;
      st.here = false;
      st.pending = null;
      const back = await stepTo(agent, id, "working", (j) => j.turns === 2);
      expect(st.restores).toBe(1);
      expect(st.starts).toBe(2);
      expect(st.loads).toBe(1);
      expect(st.prompts.at(-1)).toContain("You were interrupted");
      // The replay of the loaded session isn't taken as new words.
      expect(back.log.some((e) => e.text.includes("replayed"))).toBe(false);
      expect(back.log.some((e) => e.text.includes("coming back from where it was kept"))).toBe(true);
    });
  });

  it("let the owner steer while the agent works: its turn is stopped and their words go in next", async () => {
    const { ws, st } = fakeWorkspace([{ hang: true }, { say: "Using the date helper now.", hang: true }]);
    seams.workspace = ws;
    fakeGitHub();
    brain([call("code_job", { title: "Budget: dates", repo: "ann/budget", task: "Fix dates." }), say("Started.")]);
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      setUp(sql);
      await agent.apiTurn("fix the dates");
      const id = sql.exec<{ id: string }>(`SELECT id FROM coding`).one().id;
      await stepTo(agent, id, "working");
      const out = await agent.apiJobSay(id, "Use the existing date helper instead.");
      expect(out.text).toContain("as soon as it stops");
      expect(st.methods).toContain("session/cancel");
      await stepTo(agent, id, "working", (j) => j.turns === 2);
      expect(st.prompts[1]).toBe("The owner says: Use the existing date helper instead.\n\nCarry on with that in mind.");
    });
  });

  it("refuse to start without what they need, saying what's missing", async () => {
    seams.workspace = fakeWorkspace([]).ws;
    fakeGitHub();
    await runInDurableObject(fresh(), async (agent: PersonAgent, state) => {
      const sql = state.storage.sql;
      migrate(sql);
      install(sql, { id: "codex", source: "bundled" });
      install(sql, { id: "github", source: "bundled" });
      setExtSecrets(sql, "github", { token: "ghp_x" });
      brain([call("code_job", { title: "x", repo: "ann/budget", task: "x" }), say("Couldn't.")]);
      await agent.apiTurn("fix it");
      const result = sql.exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'tool.result' ORDER BY seq DESC LIMIT 1`).one();
      expect(result.body).toContain("Codex works on your ChatGPT plan: sign in with ChatGPT in Settings → Brains first.");
    });
  });
});
