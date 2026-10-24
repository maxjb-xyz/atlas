import { describe, expect, it } from "vitest";
import { type AcpEvent, type AcpState, answerAsk, freshState, initializeParams, optionOf, read, request } from "../src/acp";

// Shapes as the real adapters sent them (codex-acp 2.2.2, claude-agent-acp 0.95.0), with paths shortened.
const CODEX_TOOL = {
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "exec-1",
      name: "exec_command",
      kind: "execute",
      title: "npm test",
      status: "in_progress",
      content: [{ type: "terminal", terminalId: "exec-1" }],
      rawInput: { command: "npm test", cwd: "/workspace/jobs/j/repo" },
    },
  },
};
const CODEX_OUTPUT = {
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-1",
      status: "completed",
      _meta: { terminal_output_delta: { data: "1 failing\n", terminal_id: "exec-1" }, terminal_exit: { exit_code: 1 } },
    },
  },
};
const CLAUDE_ASK = {
  jsonrpc: "2.0",
  id: 0,
  method: "session/request_permission",
  params: {
    sessionId: "s2",
    toolCall: {
      toolCallId: "toolu_2",
      name: "Bash",
      status: "pending",
      rawInput: { command: "touch made-by-claude.txt", description: "Make the file" },
      title: "touch made-by-claude.txt",
      kind: "execute",
      locations: [{ path: "/workspace/jobs/j/repo/made-by-claude.txt" }],
    },
    options: [
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      { optionId: "reject", name: "No", kind: "reject_once" },
    ],
  },
};

const all = (events: AcpEvent[], type: AcpEvent["type"]) => events.filter((e) => e.type === type);

describe("the ACP client", () => {
  it("starts a session: requests are numbered, answered by id, and the session is kept", () => {
    let s = freshState();
    const init = request(s, "initialize", initializeParams("m6"));
    s = init.state;
    expect(JSON.parse(init.line)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { terminal: false, auth: { _meta: { gateway: true } } } },
    });
    const r1 = read(s, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }));
    expect(r1.events).toEqual([{ type: "result", id: 1, method: "initialize", result: expect.objectContaining({ protocolVersion: 1 }) }]);
    s = r1.state;
    expect(s.pending).toEqual({});
    const sn = request(s, "session/new", { cwd: "/workspace/jobs/j/repo", mcpServers: [] });
    s = read(sn.state, JSON.stringify({ jsonrpc: "2.0", id: sn.id, result: { sessionId: "s1", modes: {} } })).state;
    expect(s.session).toBe("s1");
  });

  it("follows a prompt to its end, with the agent's commands and their output", () => {
    let s: AcpState = { ...freshState(), session: "s1" };
    const p = request(s, "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "Fix the failing test." }] });
    s = p.state;
    expect(s.turn?.id).toBe(p.id);
    const tool = read(s, JSON.stringify(CODEX_TOOL));
    expect(tool.events[0]).toEqual({
      type: "update",
      update: {
        kind: "tool",
        id: "exec-1",
        title: "npm test",
        tool_kind: "execute",
        status: "in_progress",
        output: "",
        input: expect.objectContaining({ command: "npm test" }),
      },
    });
    const out = read(s, JSON.stringify(CODEX_OUTPUT));
    expect(out.events[0]).toMatchObject({
      type: "update",
      update: { kind: "tool", id: "exec-1", status: "completed", output: "1 failing\n" },
    });
    const msg = read(
      s,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Which test runner?" } },
        },
      }),
    );
    expect(msg.events[0]).toEqual({ type: "update", update: { kind: "message", id: "m1", text: "Which test runner?" } });
    const end = read(s, JSON.stringify({ jsonrpc: "2.0", id: p.id, result: { stopReason: "end_turn" } }));
    expect(all(end.events, "turn_end")).toEqual([{ type: "turn_end", stop: "end_turn" }]);
    expect(end.state.turn).toBeNull();
  });

  it("ends the turn when the prompt is refused, in the agent's own words", () => {
    const p = request({ ...freshState(), session: "s1" }, "session/prompt", { sessionId: "s1", prompt: [] });
    const r = read(
      p.state,
      JSON.stringify({ jsonrpc: "2.0", id: p.id, error: { code: -32000, message: "Usage limit reached", data: { resets: "1h" } } }),
    );
    expect(r.events).toEqual([
      { type: "error", id: p.id, method: "session/prompt", message: 'Usage limit reached ({"resets":"1h"})', code: -32000 },
      { type: "turn_end", stop: "error" },
    ]);
  });

  it("reads a permission request, and answers it with one of the agent's own options", () => {
    const r = read(freshState(), JSON.stringify(CLAUDE_ASK));
    const ask = (r.events[0] as Extract<AcpEvent, { type: "ask" }>).ask;
    expect(ask).toMatchObject({
      id: 0,
      tool: { id: "toolu_2", title: "touch made-by-claude.txt", kind: "execute", paths: ["/workspace/jobs/j/repo/made-by-claude.txt"] },
    });
    expect(optionOf(ask, "allow_once", "allow_always")).toBe("allow-once");
    expect(JSON.parse(answerAsk(ask, "allow-once"))).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    expect(JSON.parse(answerAsk(ask, null))).toEqual({ jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } });
  });

  it("says no to what Atlas doesn't offer, and keeps lines that aren't JSON-RPC", () => {
    const r = read(freshState(), JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: { path: "/etc/passwd" } }));
    expect(r.events).toEqual([]);
    expect(JSON.parse(r.replies[0]!)).toMatchObject({ id: 7, error: { code: -32601 } });
    expect(read(freshState(), "npm warn deprecated something").events).toEqual([{ type: "noise", text: "npm warn deprecated something" }]);
  });

  it("keeps a huge tool input as the start of its JSON", () => {
    const big = { ...CODEX_TOOL, params: { update: { ...CODEX_TOOL.params.update, rawInput: { patch: "x".repeat(10_000) } } } };
    const u = read(freshState(), JSON.stringify(big)).events[0] as Extract<AcpEvent, { type: "update" }>;
    expect(u.update).toMatchObject({ kind: "tool", input: { cut: expect.any(String) } });
    expect(JSON.stringify(u.update).length).toBeLessThan(5_000);
  });
});
