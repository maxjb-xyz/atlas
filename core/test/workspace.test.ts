import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams, type WorkspaceStub } from "../src/agent";
import { saveEntry } from "../src/vault";
import { carrying, streamToR2, throughGate } from "../src/workspace";
import { type BrowserDriver, downloadName } from "../src/browser";
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
  const writes: Array<{ path: string; bytes: number[]; as?: string }> = [];
  const installs: string[][] = [];
  const stub: WorkspaceStub & { runs: typeof runs; writes: typeof writes; installs: typeof installs } = {
    runs,
    writes,
    installs,
    async write(path, body, as) {
      writes.push({ path, bytes: [...new Uint8Array(await new Response(body).arrayBuffer())], ...(as ? { as } : {}) });
      return { ok: true, path };
    },
    async install(packages) {
      installs.push(packages);
      return { ok: true, note: "" };
    },
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
    // The yes carries on the task, without another message from the owner.
    const carried = brain([say("Allowed. Trying again now.")]);
    s.send({ type: "atlas.approval.decide", id, yes: true });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "agenda.change" && r.body.change === "done"));
    const resumed = await s.next("atlas.run", (m) => m.client_id === `approval-${id}`);
    await s.next("atlas.run", (m) => m.run_id === resumed.run_id && m.state !== "running");
    expect(carried.requests[0]!.messages.at(-1)).toMatchObject({ content: expect.stringContaining("Carry on.") });

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

describe("the workspace's gate", () => {
  const gate = {
    allow: ["github.com", "api.anthropic.com", "pypi.org"],
    inject: { "pypi.org": "Bearer vault-key" },
    rules: [
      { host: "api.anthropic.com", header: "x-api-key", value: "sk-ant-real" },
      { host: "github.com", path: "/ann/budget.git/", header: "authorization", value: "Basic dG9rZW4=", nonce: "n0nce" },
    ],
  };
  const pass = (url: string, headers: Record<string, string> = {}) => {
    const out = throughGate(new Request(url, { headers }), gate);
    if ("refused" in out) throw new Error(`refused ${out.refused}`);
    return out.request.headers;
  };

  it("opens a key's site for the command that carries it, even one the owner never allowed (a clone from GitHub)", () => {
    const rule = { host: "github.com", path: "/ann/budget.git/", header: "authorization", value: "Basic dG9rZW4=", nonce: "n0nce" };
    const extra = carrying([rule]);
    expect(extra.allow).toEqual(["github.com"]);
    const out = throughGate(new Request("https://github.com/ann/budget.git/info/refs", { headers: { "x-atlas-key": "n0nce" } }), {
      allow: [...extra.allow],
      inject: {},
      rules: extra.rules,
    });
    expect("request" in out && out.request.headers.get("authorization")).toBe("Basic dG9rZW4=");
  });

  it("refuses a site the owner hasn't allowed", () => {
    expect(throughGate(new Request("https://evil.example/x"), gate)).toEqual({ refused: "evil.example" });
  });

  it("puts a job's key in the header its site reads, over the placeholder the agent sent", () => {
    const h = pass("https://api.anthropic.com/v1/messages", { "x-api-key": "atlas-gate-adds-the-key" });
    expect(h.get("x-api-key")).toBe("sk-ant-real");
    expect(pass("https://pypi.org/simple/").get("authorization")).toBe("Bearer vault-key");
  });

  it("adds git's token only for a request carrying the nonce, and never lets the nonce out", () => {
    // A coding agent's push: no nonce, no token.
    expect(pass("https://github.com/ann/budget.git/git-receive-pack").get("authorization")).toBeNull();
    // A wrong nonce: no token either, and the header doesn't leave.
    const wrong = pass("https://github.com/ann/budget.git/info/refs", { "x-atlas-key": "guess" });
    expect(wrong.get("authorization")).toBeNull();
    expect(wrong.get("x-atlas-key")).toBeNull();
    // Atlas's own git step.
    const ok = pass("https://github.com/ann/budget.git/info/refs", { "x-atlas-key": "n0nce" });
    expect(ok.get("authorization")).toBe("Basic dG9rZW4=");
    expect(ok.get("x-atlas-key")).toBeNull();
    // Even with the nonce, the token reaches only this repo's git address: not another repo, not the API.
    expect(pass("https://github.com/mallory/loot.git/git-receive-pack", { "x-atlas-key": "n0nce" }).get("authorization")).toBeNull();
    expect(pass("https://api.github.com/user", { "x-atlas-key": "n0nce" }).get("authorization")).toBeNull();
  });

  it("keeps a job's folder in R2 in equal parts as it streams, and keeps nothing when the copy didn't end well", async () => {
    const MiB = 1024 * 1024;
    const bytes = new Uint8Array(11 * MiB + 123).map((_, i) => i % 251);
    // In uneven pieces, as a command's output comes.
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let at = 0; at < bytes.length; at += 777_777) c.enqueue(bytes.subarray(at, Math.min(at + 777_777, bytes.length)));
          c.close();
        },
      });
    expect(await streamToR2(env.FILES, "jobs/test/ag_x/folder.tgz", stream(), async () => true, 5 * MiB)).toBe(true);
    const kept = await env.FILES.get("jobs/test/ag_x/folder.tgz");
    const digest = async (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].join(",");
    expect(kept!.size).toBe(bytes.length);
    expect(await digest(await kept!.arrayBuffer())).toBe(await digest(bytes));
    // A copy whose command failed leaves the last good one in place.
    expect(await streamToR2(env.FILES, "jobs/test/ag_x/folder.tgz", new Response("half").body!, async () => false, 5 * MiB)).toBe(false);
    expect((await env.FILES.get("jobs/test/ag_x/folder.tgz"))!.size).toBe(bytes.length);
  });

  it("saves a file the browser gets into the workspace, past the check the browser cleared, and installs system tools by name", async () => {
    const page = { url: "https://pixabay.com/music/track-1/", title: "Track", text: "Download", length: 8, elements: [] };
    let opened = false;
    const driver: BrowserDriver = {
      open: async () => ((opened = true), page),
      look: async () => page,
      act: async () => page,
      fill: async () => page,
      find: async () => null,
      live: async () => "https://live.example/",
      close: async () => {},
      where: () => (opened ? { open: true, url: page.url, title: page.title } : { open: false, url: "", title: "" }),
      download: async (url) => ({ url: url ?? page.url, name: "track.mp3", type: "audio/mpeg", bytes: new Uint8Array([73, 68, 51]) }),
    };
    seams.browser = driver;
    try {
      const s = await connect();
      brain([
        call("browser_open", { url: page.url }),
        call("browser_save", { url: "https://cdn.pixabay.com/audio/track-1.mp3", path: "music/track.mp3" }),
        call("packages_install", { packages: ["sox"] }),
        say("Saved it, and sox is in."),
      ]);
      const { results } = await turn(s, "get that track into the workspace and install sox");
      const saved = results.find((r) => r.body.name === "browser_save")!;
      expect(JSON.parse(out(saved))).toMatchObject({ saved: "/workspace/music/track.mp3", name: "track.mp3", size: 3 });
      expect(saved.body.receipt).toMatchObject({ text: "Saved · track.mp3" });
      expect(ws.writes).toEqual([{ path: "/workspace/music/track.mp3", bytes: [73, 68, 51] }]);
      expect(ws.installs).toEqual([["sox"]]);
    } finally {
      seams.browser = undefined;
    }
  });

  it("names a download from its headers, else its address", () => {
    expect(downloadName("https://cdn.example/a/b/track%201.mp3?x=1", {})).toBe("track 1.mp3");
    expect(downloadName("https://cdn.example/get", { "Content-Disposition": 'attachment; filename="Neon Rush.mp3"' })).toBe(
      "Neon Rush.mp3",
    );
    expect(downloadName("https://cdn.example/get", { "content-disposition": "attachment; filename*=UTF-8''Caf%C3%A9.mp3" })).toBe(
      "Café.mp3",
    );
    expect(downloadName("https://cdn.example/", {})).toBe("download");
  });
});
