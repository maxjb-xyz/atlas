import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seams } from "../src/agent";
import { appCsp, type McpClient, type McpResult, type McpServer, resultText, uiOf } from "../src/mcp";
import { setState } from "../src/store/state";
import { call, fakeCalendar, fakeEmbedder, say } from "./helpers";
import { brain, connect, inOwner, out, turn } from "./owner";

const PAGE = `<!doctype html><html><head></head><body><div id="app"></div><script>/* an MCP App */</script></body></html>`;

/** A pretend Linear: a search that only reads, a create that changes things, a delete, and a board with its own page. */
function linear(): McpServer {
  return {
    id: "lin1",
    name: "Linear",
    url: "https://mcp.linear.example/mcp",
    state: "ready",
    auth_url: null,
    error: null,
    instructions: "Issues and projects in the owner's Linear workspace.",
    tools: [
      {
        name: "search_issues",
        description: "Search issues by text.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        annotations: { readOnlyHint: true },
      },
      {
        name: "create_issue",
        title: "Create issue",
        description: "Create an issue in a team. Returns its URL.",
        inputSchema: { type: "object", properties: { title: { type: "string" }, team: { type: "string" } } },
      },
      { name: "delete_issue", description: "Delete an issue for good.", annotations: { destructiveHint: true } },
      {
        name: "show_board",
        title: "Board",
        description: "Show the team's board.",
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: "ui://linear/board" } },
      },
      {
        name: "move_card",
        description: "Move a card on the board.",
        _meta: { ui: { resourceUri: "ui://linear/board", visibility: ["app"] } },
      },
    ],
  };
}

let calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
let added: Array<{ name: string; url: string; token?: string }> = [];
let servers: McpServer[] = [];

function fakeMcp(): McpClient {
  return {
    servers: () => servers,
    async add(o) {
      added.push(o);
      const s: McpServer = {
        ...linear(),
        id: `s${added.length}`,
        name: o.name,
        url: o.url,
        tools: [],
        state: o.token ? "ready" : "authenticating",
      };
      if (!o.token) s.auth_url = "https://auth.example/authorize?state=xyz";
      servers = [...servers, s];
      return { id: s.id, state: s.state, ...(s.auth_url ? { auth_url: s.auth_url } : {}) };
    },
    async remove(id) {
      servers = servers.filter((s) => s.id !== id);
    },
    async retry(id) {
      const s = servers.find((x) => x.id === id);
      if (!s) throw new Error("That server isn't added any more: add it again in Abilities → Services.");
      if (s.state === "failed") throw new Error(`It still didn't connect: ${s.error ?? "it gave no reason"}`);
      return { state: s.state };
    },
    async call(server, tool, args): Promise<McpResult> {
      calls.push({ server, tool, args });
      if (tool === "search_issues") return { content: [{ type: "text", text: `ENG-12 Fix the login page (${String(args.query)})` }] };
      if (tool === "create_issue") return { content: [{ type: "text", text: "Created ENG-40: https://linear.example/ENG-40" }] };
      if (tool === "show_board")
        return { content: [{ type: "text", text: "3 columns" }], structuredContent: { columns: ["Todo", "Doing", "Done"] } };
      if (tool === "move_card") return { content: [{ type: "text", text: "Moved." }] };
      return { content: [{ type: "text", text: "No such issue." }], isError: true };
    },
    async read(_server, uri) {
      return {
        contents: [
          {
            uri,
            mimeType: "text/html;profile=mcp-app",
            text: PAGE,
            _meta: {
              ui: {
                csp: {
                  connectDomains: ["https://api.linear.example"],
                  resourceDomains: ["https://cdn.linear.example", "evil; script-src *"],
                },
              },
            },
          },
        ],
      };
    },
    async settle() {},
  };
}

beforeEach(async () => {
  calls = [];
  added = [];
  servers = [linear()];
  seams.calendar = fakeCalendar([]);
  seams.embed = fakeEmbedder();
  seams.mcp = fakeMcp();
  await inOwner((_a, sql) => {
    sql.exec(`DELETE FROM state WHERE key IN ('trust', 'mcp_apps')`);
    sql.exec(`DELETE FROM agenda WHERE kind = 'approval'`);
  });
});
afterEach(() => {
  seams.mcp = undefined;
  seams.makeBrain = null;
  seams.calendar = undefined;
  seams.embed = undefined;
});

describe("MCP, the pieces", () => {
  it("puts a result in words, and reads a tool's page and who may use it", () => {
    expect(
      resultText({
        content: [
          { type: "text", text: "Hi" },
          { type: "image", mimeType: "image/png", data: "…" },
        ],
      }),
    ).toBe("Hi\n[image, image/png]");
    expect(resultText({ content: [], structuredContent: { a: 1 } })).toBe('{"a":1}');
    expect(resultText({})).toBe("(it answered with nothing)");
    const [, , , board, move] = linear().tools;
    expect(uiOf(board!)).toEqual({ uri: "ui://linear/board", visibility: ["model", "app"] });
    expect(uiOf(move!)).toEqual({ uri: "ui://linear/board", visibility: ["app"] });
    expect(uiOf(linear().tools[0]!)).toBeNull();
    // The old flat key still works.
    expect(uiOf({ name: "x", _meta: { "ui/resourceUri": "ui://x" } })?.uri).toBe("ui://x");
  });

  it("lets a page reach only the domains its server declared, and nothing it can't parse", () => {
    expect(appCsp(undefined)).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'",
    );
    const csp = appCsp({
      ui: { csp: { connectDomains: ["https://api.x.example", "wss://live.x.example"], resourceDomains: ["*.cdn.example", "a b", "x;y"] } },
    });
    expect(csp).toContain("connect-src https://api.x.example wss://live.x.example");
    expect(csp).toContain("script-src 'unsafe-inline' *.cdn.example;");
    expect(csp).not.toContain("a b");
    expect(csp).not.toContain("x;y");
  });
});

describe("MCP in a run", () => {
  it("names connected servers in context, finds tools, and calls one that only reads as a look", async () => {
    const s = await connect();
    const b = brain([
      call("mcp_tools", { search: "issue" }),
      call("mcp_call", { server: "linear", tool: "search_issues", arguments: { query: "login" } }),
      say("ENG-12."),
    ]);
    const { results, deliveries } = await turn(s, "is there an issue about the login page?");
    expect(b.requests[0]!.system).toContain("- Linear (4 tools): Issues and projects in the owner's Linear workspace.");
    const found = JSON.parse(out(results[0]!)) as { tools: Array<{ tool: string; asks_first: string }> };
    expect(found.tools.map((t) => [t.tool, t.asks_first])).toEqual([
      ["search_issues", "no: it only reads"],
      ["create_issue", "yes, until the owner trusts it"],
      ["delete_issue", "always, with a hold: it can't be undone"],
    ]);
    expect(JSON.parse(out(results[1]!))).toMatchObject({
      answer: "ENG-12 Fix the login page (login)",
      untrusted: expect.stringContaining("someone else's words"),
    });
    expect(results[1]!.body.receipt).toEqual({ text: "Asked Linear · search_issues", look: true });
    expect(calls).toEqual([{ server: "lin1", tool: "search_issues", args: { query: "login" } }]);
    expect(deliveries[0]!.body).toMatchObject({ channel: "mcp", to: "Linear", text: "search_issues", ok: true, by: "atlas" });
  });

  it("asks before a tool that changes things, sends the card's edit, and carries on with the answer", async () => {
    const s = await connect();
    brain([
      call("mcp_call", { server: "Linear", tool: "create_issue", arguments: { title: "Fix login", team: "ENG" } }),
      say("Waiting for your OK."),
    ]);
    const asked = await turn(s, "file an issue to fix the login");
    const receipt = asked.results[0]!.body.receipt as { text: string; approval: string };
    expect(receipt.text).toBe("Waiting for your OK · Create issue on Linear");
    expect(calls).toEqual([]);
    s.send({ type: "atlas.inbox" });
    const card = (await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.approval?.id === receipt.approval))).items.find(
      (i) => i.approval?.id === receipt.approval,
    )!.approval!;
    expect(card.hold).toBe(false);
    expect(card.steps[0]).toMatchObject({
      kind: "mcp",
      title: "Create issue on Linear",
      detail: "Create an issue in a team.",
      where: "Linear · mcp.linear.example",
    });
    expect(JSON.parse(card.steps[0]!.message!)).toEqual({ title: "Fix login", team: "ENG" });

    // The yes carries on in a run of its own, which sees what the server answered.
    const b = brain([say("Filed as ENG-40.")]);
    s.send({
      type: "atlas.approval.decide",
      id: receipt.approval,
      yes: true,
      edits: [{ index: 0, message: JSON.stringify({ title: "Fix the login page", team: "ENG" }) }],
    });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "agenda.change" && r.body.change === "done"));
    await s.next("atlas.run", (m) => m.state === "replied");
    expect(calls).toEqual([{ server: "lin1", tool: "create_issue", args: { title: "Fix the login page", team: "ENG" } }]);
    expect(b.requests[0]!.system).toContain("Create issue on Linear, approved: Create issue on Linear answered: Created ENG-40");

    // Something its server says can't be undone needs a hold.
    brain([call("mcp_call", { server: "Linear", tool: "delete_issue", arguments: { id: "ENG-1" } }), say("Waiting.")]);
    const del = await turn(s, "delete ENG-1");
    const delId = (del.results[0]!.body.receipt as { approval: string }).approval;
    s.send({ type: "atlas.inbox" });
    const delCard = (await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.approval?.id === delId))).items.find(
      (i) => i.approval?.id === delId,
    )!.approval!;
    expect(delCard).toMatchObject({ hold: true, steps: [{ undo: "Its server says this can't be undone." }] });
  });

  it("asks before anything leaves once a run has read a service's answer", async () => {
    const s = await connect();
    await inOwner((_a, sql) =>
      setState(sql, "trust", {
        "mcp:lin1:create_issue": { name: "Create issue on Linear", as_is: 5, offered: false, trusted_at: Date.now() },
      }),
    );
    // Trusted, on its own: done straight away.
    brain([call("mcp_call", { server: "Linear", tool: "create_issue", arguments: { title: "A" } }), say("Done.")]);
    const trusted = await turn(s, "file A");
    expect(trusted.results[0]!.body.receipt).toMatchObject({ text: "Done · Create issue on Linear" });
    // After reading a search's answer in the same run, it asks.
    brain([
      call("mcp_call", { server: "Linear", tool: "search_issues", arguments: { query: "B" } }),
      call("mcp_call", { server: "Linear", tool: "create_issue", arguments: { title: "B" } }),
      say("Waiting."),
    ]);
    const read = await turn(s, "find B and file it");
    expect((read.results[1]!.body.receipt as { text: string }).text).toBe("Waiting for your OK · Create issue on Linear");
  });

  it("shows a tool's page on the stage, gives the app its page, and lets the page use only its own tools", async () => {
    const s = await connect();
    brain([
      call("mcp_tools", { server: "Linear", search: "move" }),
      call("mcp_call", { server: "Linear", tool: "show_board", arguments: { team: "ENG" } }),
      say("Here's the board."),
    ]);
    const { results } = await turn(s, "show me the board");
    // A tool only for its page isn't offered to the model.
    expect(JSON.parse(out(results[0]!))).toMatchObject({ tools: [] });
    const receipt = results[1]!.body.receipt as { text: string; view: { kind: string; call: string; title: string } };
    expect(receipt).toMatchObject({ text: "Asked Linear · Board", view: { kind: "mcp_app", title: "Board" } });
    expect(out(results[1]!)).toContain(`page ${receipt.view.call}`);

    s.send({ type: "atlas.mcp.app", req: "r1", call: receipt.view.call });
    const page = (await s.next("atlas.mcp.app.result", (m) => m.req === "r1")).page!;
    expect(page).toMatchObject({
      server: "Linear",
      html: PAGE,
      border: true,
      input: { team: "ENG" },
      result: { structuredContent: { columns: ["Todo", "Doing", "Done"] } },
      tool: { name: "show_board" },
    });
    expect(page.csp).toContain("connect-src https://api.linear.example");
    expect(page.csp).not.toContain("evil");

    // The page moves a card (a tool only it may use); it can't use one meant for the model alone, or another server's.
    s.send({
      type: "atlas.mcp.app.call",
      req: "r2",
      call: receipt.view.call,
      name: "move_card",
      arguments: { card: "ENG-12", to: "Done" },
    });
    expect((await s.next("atlas.mcp.app.answer", (m) => m.req === "r2")).result).toEqual({ content: [{ type: "text", text: "Moved." }] });
    s.send({ type: "atlas.mcp.app.call", req: "r3", call: receipt.view.call, name: "nope" });
    expect((await s.next("atlas.mcp.app.answer", (m) => m.req === "r3")).error).toBe("nope isn't a tool Linear's page may use.");
    s.send({ type: "atlas.mcp.app", req: "r4", call: "app_missing" });
    expect((await s.next("atlas.mcp.app.result", (m) => m.req === "r4")).error).toContain("isn't kept any more");
    const owned = await inOwner((_a, sql) =>
      sql.exec<{ body: string }>(`SELECT body FROM log WHERE kind = 'delivery' AND json_extract(body, '$.text') = 'move_card'`).one(),
    );
    expect(JSON.parse(owned.body)).toMatchObject({ channel: "mcp", by: "owner", ok: true });
  });

  it("asks to connect a server, connects it on a yes, and Settings adds and removes them", async () => {
    const s = await connect();
    await inOwner((_a, sql) => setState(sql, "origin", "https://atlas.example"));
    brain([call("mcp_add", { name: "Notion", url: "https://mcp.notion.example/mcp", why: "To read your project notes" }), say("Waiting.")]);
    const asked = await turn(s, "can you read my notion?");
    const id = (asked.results[0]!.body.receipt as { approval: string }).approval;
    s.send({ type: "atlas.inbox" });
    const card = (await s.next("atlas.inbox.items", (m) => m.items.some((i) => i.approval?.id === id))).items.find(
      (i) => i.approval?.id === id,
    )!.approval!;
    expect(card.steps[0]).toMatchObject({ kind: "mcp_add", title: "Connect Notion", where: "https://mcp.notion.example/mcp" });
    brain([say("Sign in when you're ready.")]);
    s.send({ type: "atlas.approval.decide", id, yes: true });
    await s.next("atlas.rows", (m) => m.rows.some((r) => r.kind === "agenda.change" && r.body.change === "done"));
    expect(added).toEqual([{ name: "Notion", url: "https://mcp.notion.example/mcp" }]);

    // Settings: the list never has a token; add one with a token; remove one.
    s.send({ type: "atlas.mcp.add", name: "Docs", url: "https://docs.example/mcp", token: "sk_live_123" });
    const list = (await s.next("atlas.mcp.servers", (m) => m.servers.length === 3)).servers;
    expect(list.map((x) => [x.name, x.state, x.auth_url])).toEqual([
      ["Linear", "ready", null],
      ["Notion", "authenticating", "https://auth.example/authorize?state=xyz"],
      ["Docs", "ready", null],
    ]);
    expect(list[0]!.tools[0]).toEqual({
      name: "search_issues",
      title: null,
      description: "Search issues by text.",
      reads: true,
      page: false,
    });
    expect(JSON.stringify(list)).not.toContain("sk_live");
    expect(added[1]).toEqual({ name: "Docs", url: "https://docs.example/mcp", token: "sk_live_123" });
    s.send({ type: "atlas.mcp.remove", id: "s1" });
    expect((await s.next("atlas.mcp.servers", (m) => m.servers.length === 2)).servers.map((x) => x.name)).toEqual(["Linear", "Docs"]);
    s.send({ type: "atlas.mcp.add", name: "Plain", url: "http://insecure.example/mcp" });
    expect((await s.next("atlas.error")).message).toBe("An MCP server's address starts with https://.");
  });

  it("signs in to a service under Atlas's name, not the agent's id", async () => {
    const meta = await inOwner((agent) => agent.createMcpOAuthProvider("https://atlas.example/mcp/callback").clientMetadata);
    expect(meta).toMatchObject({ client_name: "Atlas", redirect_uris: ["https://atlas.example/mcp/callback"] });
  });

  it("refuses a sign-in callback it didn't start", async () => {
    seams.mcp = undefined;
    const res = await SELF.fetch("http://atlas.test/mcp/callback?code=abc&state=forged");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("an MCP server that didn't connect", () => {
  it("is tried again as it was added, keeps its place when it fails again, and says why in the service's words", async () => {
    servers = [
      {
        ...linear(),
        id: "gh1",
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        state: "failed",
        error: "HTTP 401: Bad credentials",
        tools: [],
      },
    ];
    const s = await connect();
    s.send({ type: "atlas.mcp.retry", id: "gh1" });
    expect((await s.next("atlas.error")).message).toBe("It still didn't connect: HTTP 401: Bad credentials");
    expect(servers.map((x) => x.id)).toEqual(["gh1"]);
  });
});
