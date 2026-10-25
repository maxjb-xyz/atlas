// Claude Code (VISION §8.2): Anthropic's coding agent, run in the workspace
// for a coding job through its ACP adapter. It needs an Anthropic API key:
// Anthropic points products built on Claude Code to API keys, and whether a
// Claude plan may power it inside Atlas is unsettled (§18). The key stays in
// Atlas: the agent is given a placeholder, and the workspace's gate puts the
// key into its requests to Anthropic. A job stops at the cap set here.

import { type Extension, get, json } from "../sdk";

const ext: Extension = {
  manifest: {
    id: "claude-code",
    name: "Claude Code",
    version: "1.1.0",
    about:
      "Anthropic's coding agent, for coding jobs and a job's coding steps: it works in your workspace on a branch, by your Anthropic API key, on the model and effort you pick, and each job stops at the cap you set. It never holds the key; the workspace's gate adds it.",
    provides: ["coding"],
    hosts: ["api.anthropic.com"],
    secrets: [
      {
        name: "api_key",
        label: "Anthropic API key",
        help: "From console.anthropic.com → API keys. Jobs bill it by what they use, up to the cap below.",
      },
    ],
    settings: [{ name: "cap", label: "Most one job may spend, in US dollars", default: "5" }],
    costs: "What each job uses of your Anthropic API key, up to the cap per job.",
    agent: {
      package: "@agentclientprotocol/claude-agent-acp@0.95.0",
      bin: "claude-agent-acp",
      model: { url: "https://api.anthropic.com", header: "x-api-key", key: { secret: "api_key" } },
      env: {
        ANTHROPIC_BASE_URL: "{url}",
        ANTHROPIC_API_KEY: "{key}",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_AUTOUPDATER: "1",
        // It runs as root in the container, which it allows only in a sandbox.
        IS_SANDBOX: "1",
      },
      home: "CLAUDE_CONFIG_DIR",
      // Edits in the job's folder go ahead; commands ask, and Atlas answers.
      mode: "acceptEdits",
      costs_money: true,
      // A job can pick the model and effort (code.claude.com/docs/en/env-vars).
      choose: { model: "ANTHROPIC_MODEL", effort: "CLAUDE_CODE_EFFORT_LEVEL" },
    },
  },
  async test(ctx) {
    const models = await json<{ data?: Array<{ id: string }> }>(
      await get("https://api.anthropic.com/v1/models?limit=5", {
        headers: { "x-api-key": ctx.secret("api_key"), "anthropic-version": "2023-06-01" },
      }),
      "Anthropic",
    );
    return {
      text: `Anthropic took the key${models.data?.length ? `; it can use ${models.data.map((m) => m.id).join(", ")} and more` : ""}.`,
    };
  },
};

export default ext;
