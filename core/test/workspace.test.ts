import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams, type WorkspaceStub } from "../src/agent";
import { saveEntry } from "../src/vault";
import { call, env, fakeCalendar, fakeEmbedder, say, SECRET } from "./helpers";
import { brain, connect, inOwner, out, turn } from "./owner";

/**
 * A workspace for tests: commands are answered from a script, the gate is
 * strict like the real one (a site not allowed is blocked and reported),
 * and every run's gate is recorded.
 */
function fakeWorkspace() {
  const runs: Array<{ command: string; allow: string[]; inject: Record<string, string> }> = [];
  const files: Record<string, Uint8Array> = { "/workspace/plan.xlsx": new Uint8Array([80, 75, 3, 4, 1, 2, 3]) };
  const stub: WorkspaceStub & { runs: typeof runs } = {
    runs,
    async run(o) {
      runs.push({ command: o.command, allow: o.allow, inject: o.inject });
      const lines: object[] = [];
      if (runs.length === 1) lines.push({ note: "Starting the workspace." });
      const site = /https:\/\/([^/\s]+)/.exec(o.command)?.[1];
      if (site && !o.allow.some((a) => site === a || site.endsWith(`.${a}`))) {
        lines.push({ out: "403\n" }, { done: { exit: 0, ms: 40, blocked: [site], kept: "" } });
      } else {
        lines.push({ out: "2 " }, { out: "2.2.3\n" }, { done: { exit: 0, ms: 120, blocked: [], kept: "" } });
      }
      const enc = new TextEncoder();
      return new ReadableStream({
        start(c) {
          for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
          c.close();
        },
      });
    },
    async read(path) {
      const f = files[path];
      return f ? { ok: true, bytes: f.slice().buffer } : { ok: false, error: `cat: ${path}: No such file or directory` };
    },
    async list() {
      return [{ path: "plan.xlsx", size: 7, dir: false }];
    },
    async preview(port) {
      return { token: `${"ab".repeat(18)}`, expires: Date.now() + 86_400_000 + port };
    },
    async restart() {},
    async status() {
      return { running: true, ready: true };
    },
  };
  return stub;
}

let ws: ReturnType<typeof fakeWorkspace>;

beforeEach(async () => {
  ws = fakeWorkspace();
  seams.workspace = ws;
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM state WHERE key IN ('workspace_sites', 'workspace_runs')`);
    sql.exec(`DELETE FROM secrets WHERE name = 'vault'`);
    sql.exec(`DELETE FROM files`);
  });
});
afterEach(() => {
  seams.workspace = undefined;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("the workspace", () => {
  it("runs a command, streams what it prints to the app, and keeps it among the recent runs", async () => {
    const s = await connect();
    brain([call("workspace_run", { command: "python3 -c 'import pandas; print(1+1, pandas.__version__)'" }), say("Two.")]);
    const { results } = await turn(s, "check python");
    expect(JSON.parse(out(results[0]!))).toMatchObject({ exit: 0, output: "2 2.2.3\n", notes: ["Starting the workspace."] });
    expect(results[0]!.body.receipt).toMatchObject({ view: { kind: "workspace" } });
    // The app saw it as it printed.
    const live = await s.next("atlas.workspace.out", (m) => m.text.includes("2.2.3"));
    expect(live.text).toBe("2.2.3\n");

    s.send({ type: "atlas.stage", ref: "workspace", view: { kind: "workspace" } });
    const page = (await s.next("atlas.stage.page", (m) => m.ref === "workspace")).page;
    expect(page).toMatchObject({
      kind: "workspace",
      available: true,
      running: true,
      files: [{ path: "plan.xlsx" }],
      sites: [],
      runs: [{ command: "python3 -c 'import pandas; print(1+1, pandas.__version__)'", exit: 0, output: "2 2.2.3\n" }],
    });
  });

  it("asks once to open a website to it, carries a vault key there, and remembers the yes", async () => {
    const s = await connect();
    await inOwner((_a, sql) =>
      saveEntry(sql, { name: "GitHub token", kind: "key", sites: ["api.github.com"], values: { key: "ghp_secret_123456" } }),
    );

    // Not allowed yet: blocked, and Atlas is told which site to ask for.
    brain([call("workspace_run", { command: "curl https://api.github.com/user" }), say("I need GitHub.")]);
    const first = await turn(s, "check my github");
    expect(JSON.parse(out(first.results[0]!))).toMatchObject({
      blocked: ["api.github.com"],
      note: expect.stringContaining("workspace_allow"),
    });

    brain([call("workspace_allow", { site: "https://api.github.com", why: "To read your repositories" }), say("Waiting for your OK.")]);
    const asked = await turn(s, "allow it");
    const id = (asked.results[0]!.body.receipt as { approval: string }).approval;
    s.send({ type: "atlas.inbox" });
    const card = (await s.next("atlas.inbox.items")).items.find((i) => i.approval?.id === id)!.approval!;
    expect(card.steps[0]).toMatchObject({ kind: "site", title: "Let the workspace reach api.github.com", where: "api.github.com" });
    expect(card.steps[0]!.detail).toContain("carry your GitHub token from the vault");
    s.send({ type: "atlas.approval.decide", id, yes: true });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "agenda.change" && r.body.change === "done"));

    // Now it goes through, carrying the key; the model never sees it.
    const b = brain([call("workspace_run", { command: "curl https://api.github.com/user" }), say("Done.")]);
    await turn(s, "try again");
    expect(ws.runs.at(-1)).toMatchObject({ allow: ["api.github.com"], inject: { "api.github.com": "Bearer ghp_secret_123456" } });
    expect(JSON.stringify(b.requests)).not.toContain("ghp_secret");

    // Asking again for a site it can already reach doesn't make a card.
    brain([call("workspace_allow", { site: "api.github.com", why: "Again" }), say("Already allowed.")]);
    const again = await turn(s, "allow it again");
    expect(out(again.results[0]!)).toContain("can already reach api.github.com");

    // Remove takes it back.
    s.send({ type: "atlas.workspace.site.remove", site: "api.github.com" });
    const removed = (await s.next("atlas.stage.page", (m) => m.ref === "workspace")).page;
    expect(removed).toMatchObject({ sites: [] });
  });

  it("keeps a file from the workspace in Library, and makes a preview link", async () => {
    const s = await connect();
    brain([call("workspace_keep", { path: "plan.xlsx", note: "The plan" }), call("workspace_preview", { port: 8000 }), say("Here.")]);
    const { results } = await turn(s, "keep it and show me the site");
    const receipt = results[0]!.body.receipt as { text: string; view: { file: string } };
    expect(receipt.text).toBe("Made file · plan.xlsx");
    const obj = await env.FILES.get(`files/${receipt.view.file}`);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(new Uint8Array([80, 75, 3, 4, 1, 2, 3]));
    expect(JSON.parse(out(results[1]!))).toMatchObject({ url: expect.stringMatching(/\/preview\/(ab){18}\/$/) });

    brain([call("workspace_keep", { path: "missing.csv" }), say("Not there.")]);
    const missing = await turn(s, "keep the other one");
    expect(out(missing.results[0]!)).toContain("No such file or directory");
  });

  it("opens the terminal only for the owner, from the app's own page", async () => {
    const plain = await SELF.fetch("http://atlas.test/api/workspace/terminal", { headers: { upgrade: "websocket" } });
    expect(plain.status).toBe(401);
    const elsewhere = await SELF.fetch("http://atlas.test/api/workspace/terminal", {
      headers: { upgrade: "websocket", authorization: `Bearer ${SECRET}`, origin: "https://evil.example" },
    });
    expect(elsewhere.status).toBe(403);
  });
});
