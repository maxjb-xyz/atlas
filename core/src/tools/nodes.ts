// Paired devices' tools (VISION §16.3), through one tool, like mcp_call.
// Showing a notification just happens; anything that acts on the device
// (running a command) asks first, like any outside action (§12.1). A call to
// a device that's offline waits and runs when it's back.

import { z } from "zod";
import type { Json } from "../store/db";
import { allowed, findNode, nodes } from "../nodes";
import { defineTool, fail } from "./types";

export const deviceCall = defineTool({
  name: "device_call",
  kind: "look",
  status: "Asking your device",
  timeoutMs: 120_000,
  description: [
    "Use a tool on one of the owner's paired devices (their Mac, their phone app), from the paired devices in your context.",
    "Tools marked off are turned off by the owner: say so, and that Settings → Devices turns them on. Tools that act on the device ask the owner first, on a card.",
    "When the device is offline, the call waits and runs when it's back; tell the owner that, in words like \"Your Mac's asleep. I'll do it when it wakes.\"",
  ].join(" "),
  input: z.object({
    device: z.string().min(1).max(80).describe("The device's name, as in your context."),
    tool: z.string().min(1).max(40),
    input: z.record(z.string(), z.unknown()).default({}).describe("The tool's input, as its schema says."),
  }),
  async run(input, ctx) {
    const n = findNode(ctx.sql, input.device);
    if (!n) {
      const all = nodes(ctx.sql).map((x) => x.name);
      return fail(
        all.length
          ? `There's no paired device called "${input.device}". Paired: ${all.join(", ")}.`
          : "No device is paired yet. The owner pairs one in Settings → Devices.",
      );
    }
    const cap = n.capabilities.find((c) => c.name === input.tool);
    if (!cap) {
      return fail(
        n.capabilities.length
          ? `${n.name} has no tool called ${input.tool}. Its tools: ${n.capabilities.map((c) => c.name).join(", ")}.`
          : `${n.name} hasn't said what it can do yet; it does when it first connects.`,
      );
    }
    if (!allowed(n, cap)) return fail(`${cap.name} is off on ${n.name}. The owner turns it on in Settings → Devices.`);
    const args = input.input as Record<string, Json>;
    const what = Object.entries(args)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("; ");
    if (cap.acts) {
      if (!ctx.exit) return fail("This run can't ask the owner for an OK.");
      return ctx.exit.request(
        {
          kind: "node",
          node: n.id,
          device: n.name,
          tool: cap.name,
          input: args,
          name: `${cap.name.replace(/_/g, " ")} on ${n.name}${typeof args.command === "string" ? `: ${args.command.slice(0, 80)}` : ""}`,
          // The whole input, so the card shows everything that would run.
          what: `${cap.description}${what ? ` With ${what.slice(0, 4_000)}.` : ""}`,
        },
        { run_id: ctx.run_id, source_log_id: ctx.source_log_id },
      );
    }
    if (!ctx.devices) return fail("Paired devices can't be reached from this run.");
    const out = await ctx.devices.call({ node: n.id, device: n.name, tool: cap.name, input: args }, { run_id: ctx.run_id, by: "owner" });
    return {
      ok: out.ok,
      output: out.ok ? (out.queued ? { waiting: out.text } : { done: out.text }) : { error: out.text },
      receipt: {
        text: `On ${n.name} · ${out.queued ? `waiting until it's back · ${cap.name.replace(/_/g, " ")}` : out.ok ? cap.name.replace(/_/g, " ") : `didn't work · ${cap.name.replace(/_/g, " ")}`}`,
      },
    };
  },
});
