// Codex (VISION §8.2): OpenAI's coding agent, run in the workspace for a
// coding job through its ACP adapter. It works on the owner's ChatGPT plan
// with the sign-in Atlas already has (Settings → Brains): the core points
// Codex at OpenAI's public Responses API with a placeholder, and the
// workspace's gate puts the plan's token into its requests there, so Codex
// never holds it. This is OpenAI's documented way for a tool to run Codex on
// a user's plan (Sign in with ChatGPT, Codex app-server).

import type { Extension } from "../sdk";

const ext: Extension = {
  manifest: {
    id: "codex",
    name: "Codex",
    version: "1.0.0",
    about:
      "OpenAI's coding agent, for coding jobs: it works in your workspace on a branch, on your ChatGPT plan through the sign-in in Settings → Brains. It never holds the sign-in's token; the workspace's gate adds it.",
    provides: ["coding"],
    hosts: ["api.openai.com"],
    agent: {
      package: "@agentclientprotocol/codex-acp@2.2.2",
      bin: "codex-acp",
      model: { url: "https://api.openai.com/v1", header: "authorization", prefix: "Bearer ", key: { signin: "chatgpt" } },
      // Codex's own ChatGPT sign-in talks to chatgpt.com, which refuses Cloudflare; the gateway sign-in points it at the public API.
      env: { NO_BROWSER: "1" },
      gateway: true,
      home: "CODEX_HOME",
      // Asks only about what looks unsafe; Atlas answers.
      mode: "agent",
    },
  },
};

export default ext;
