// ChatGPT on the owner's plan as a brain (§18), through OpenAI's official
// plan usage for open-source tools: the public Responses API at
// api.openai.com with the sign-in token. (chatgpt.com's own backend blocks
// requests from Cloudflare, and OpenAI asks tools not to use it.)
// https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//
// The plan's limits: OpenAI's errors page for plan usage (read 2026-10-25)
// documents `subscription_sharing_usage_limit_exceeded` (429) but no reset
// time, no `retry-after` and no usage headers, and says not to guess one from
// the code. Codex's own client reads `x-codex-primary-used-percent`,
// `-primary-window-minutes` and `-primary-reset-at` (Unix seconds), the same
// for `secondary`, and other families like `x-codex-other-*`
// (openai/codex, codex-rs/codex-api/src/rate_limits.rs, main on 2026-10-25).
// Whether the public API sends them for plan usage isn't documented, so Atlas
// reads them when they're there, with `retry-after`, logs which came back
// (`chatgpt.limits` in the Worker log), and otherwise says it doesn't know.
// https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery

import { type Brain, BrainError, type BrainEvent, type BrainRequest, type Message, type PlanLimits, parseArgs, sseData } from "./types";

export const RESPONSES_URL = "https://api.openai.com/v1/responses";
/** Plan usage needs function tools grouped in a namespace. */
export const NAMESPACE = "atlas";

export interface ChatGPTAccess {
  /** A current token, refreshed if it's close to expiring. `force` refreshes now. Null when signed out. */
  access(force?: boolean): Promise<string | null>;
}

type Item =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; namespace: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export function toInput(messages: Message[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
    else if (m.role === "tool") out.push({ type: "function_call_output", call_id: m.callId, output: m.content });
    else {
      if (m.content) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls ?? []) {
        out.push({ type: "function_call", call_id: c.id, name: c.name, namespace: NAMESPACE, arguments: JSON.stringify(c.input ?? {}) });
      }
    }
  }
  return out;
}

/** The tool name without its namespace, however the server spells it. */
const bare = (name: string) => name.replace(new RegExp(`^${NAMESPACE}(\\.|__|/)`), "");

interface Event {
  type: string;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    error?: { message?: string; code?: string };
  };
  message?: string;
  code?: string;
  error?: { message?: string; code?: string };
}

/** Turns a Responses API event stream into brain events. Exported for tests. */
export async function* readResponsesStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<BrainEvent> {
  let sawTool = false;
  for await (const data of sseData(body, signal)) {
    if (data === "[DONE]") break;
    let e: Event;
    try {
      e = JSON.parse(data) as Event;
    } catch {
      continue;
    }
    switch (e.type) {
      case "response.output_text.delta":
        if (e.delta) yield { type: "text", text: e.delta };
        break;
      case "response.output_item.added":
        if (e.item?.type === "function_call" && e.item.name) yield { type: "tool_start", name: bare(e.item.name) };
        break;
      case "response.output_item.done":
        if (e.item?.type === "function_call") {
          sawTool = true;
          yield {
            type: "tool_call",
            call: { id: e.item.call_id ?? "", name: bare(e.item.name ?? ""), input: parseArgs(e.item.arguments ?? "") },
          };
        }
        break;
      case "response.completed":
      case "response.incomplete": {
        const u = e.response?.usage;
        yield {
          type: "done",
          finish: e.type === "response.incomplete" ? "length" : sawTool ? "tool_calls" : "stop",
          usage: u
            ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens }
            : undefined,
        };
        return;
      }
      case "response.failed":
        throw planError(e.response?.error?.code, e.response?.error?.message ?? "the response failed");
      case "error":
        throw planError(e.code ?? e.error?.code, e.message ?? e.error?.message ?? "stream error");
    }
  }
  throw new BrainError("ChatGPT: the answer ended early.");
}

/** OpenAI's documented plan-usage errors, in plain words, each with the right cooldown. */
function planError(code: string | undefined, message: string, status?: number): BrainError {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new BrainError(
        "Your ChatGPT plan's limit for Atlas is used up for now. ChatGPT settings → Usage shows when it resets.",
        false,
        429,
      );
    case "subscription_sharing_user_not_eligible":
      return new BrainError("This ChatGPT account can't share its plan with Atlas. Plan usage needs Plus or Pro.", true, 403);
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return new BrainError("ChatGPT plan usage is unavailable right now. Atlas will try it again shortly.", false, 503);
    case "subscription_sharing_unsupported_capability":
      return new BrainError(`ChatGPT's plan route doesn't support part of this request: ${message}`, true, 400);
    case "subscription_sharing_invalid_user":
      return new BrainError("ChatGPT didn't accept the sign-in. If it keeps happening, sign in again in Settings → Brains.", true, 401);
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return new BrainError("Atlas isn't allowed to use your ChatGPT plan. Sign in again and allow plan usage.", true, 403);
  }
  return new BrainError(`ChatGPT: ${message}${code ? ` (${code})` : ""}`, false, status);
}

/**
 * The plan's limits from a response's headers, in Codex's names: each
 * family's primary and secondary windows. Null when none came back.
 */
export function planLimits(h: Headers, now = Date.now()): PlanLimits | null {
  const families = new Set<string>();
  h.forEach((_v, name) => {
    const m = /^x-(.+)-primary-used-percent$/i.exec(name);
    if (m) families.add(m[1]!.toLowerCase());
  });
  const windows: PlanLimits["windows"] = [];
  for (const fam of [...families].sort()) {
    for (const which of ["primary", "secondary"] as const) {
      const used = Number(h.get(`x-${fam}-${which}-used-percent`));
      if (!Number.isFinite(used) || h.get(`x-${fam}-${which}-used-percent`) == null) continue;
      const minutes = Number(h.get(`x-${fam}-${which}-window-minutes`));
      const reset = Number(h.get(`x-${fam}-${which}-reset-at`));
      const label = h.get(`x-${fam}-limit-name`)?.trim();
      windows.push({
        name: `${fam === "codex" ? "" : `${label || fam} `}${which}`,
        used_percent: used,
        ...(Number.isFinite(minutes) && minutes > 0 ? { window_minutes: minutes } : {}),
        ...(Number.isFinite(reset) && reset > 0 ? { resets_at: reset * 1000 } : {}),
      });
    }
  }
  return windows.length ? { windows, seen_at: now } : null;
}

/** When a plan that's run out can be used again: `retry-after`, else the reset of a window that's full. */
export function resetFrom(h: Headers, limits: PlanLimits | null, now = Date.now()): number | undefined {
  const after = Number(h.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return now + after * 1000;
  const full = (limits?.windows ?? []).filter((w) => w.used_percent >= 100 && w.resets_at && w.resets_at > now);
  return full.length ? Math.max(...full.map((w) => w.resets_at!)) : undefined;
}

let lastLogged = "";
/** Which limit headers OpenAI sent, in the Worker log when they change, so what's really there can be seen. */
function logLimits(res: Response): void {
  const seen: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/^x-codex|ratelimit|retry-after/i.test(k)) seen[k] = v;
  });
  const names = Object.keys(seen).sort().join(",");
  if (names === lastLogged && res.status !== 429) return;
  lastLogged = names;
  console.log(JSON.stringify({ at: "chatgpt.limits", status: res.status, headers: seen }));
}

/** The same error, with when it can be tried again. */
const withReset = (e: BrainError, at: number | undefined) =>
  at && e.status === 429 && !e.resetAt ? new BrainError(e.message, e.permanent, e.status, at) : e;

/** A plain reason for a refused request, with the status and what OpenAI said. Exported for tests. */
export async function refusal(res: Response): Promise<BrainError> {
  return withReset(await refused(res), resetFrom(res.headers, planLimits(res.headers)));
}

async function refused(res: Response): Promise<BrainError> {
  const raw = await res.text().catch(() => "");
  let code: string | undefined;
  let detail = raw;
  try {
    const body = JSON.parse(raw) as { detail?: unknown; error?: { message?: unknown; code?: unknown }; message?: unknown };
    code = typeof body.error?.code === "string" ? body.error.code : undefined;
    const d = body.error?.message ?? body.detail ?? body.message;
    if (d) detail = typeof d === "string" ? d : JSON.stringify(d);
  } catch {
    // Not JSON: an HTML page, so keep only its words.
    detail = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 200);
  if (code) return planError(code, detail, res.status);
  const status = `HTTP ${res.status}`;
  if (res.status === 401) return new BrainError(`ChatGPT refused the sign-in (${status}${detail ? `: ${detail}` : ""}).`, true, 401);
  if (res.status === 429) return new BrainError(`ChatGPT is rate limiting Atlas for now (${status}).`, false, 429);
  if (res.status === 400 || res.status === 403 || res.status === 404) {
    return new BrainError(`ChatGPT refused the request (${status}${detail ? `: ${detail}` : ""}).`, true, res.status);
  }
  return new BrainError(`ChatGPT: ${status}${detail ? ` ${detail}` : ""}`, false, res.status);
}

export function chatgptBrain(auth: ChatGPTAccess, model: string, f: typeof fetch = fetch): Brain {
  async function open(req: BrainRequest, force: boolean): Promise<Response> {
    const token = await auth.access(force);
    if (!token) throw new BrainError("ChatGPT isn't signed in.", true);
    return f(RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "user-agent": "Atlas (+https://github.com/maxjb-xyz/atlas)",
      },
      signal: req.signal,
      body: JSON.stringify({
        model,
        instructions: req.system,
        input: toInput(req.messages),
        ...(req.tools.length
          ? {
              tools: [
                {
                  type: "namespace",
                  name: NAMESPACE,
                  description: "Atlas's own tools.",
                  tools: req.tools.map((t) => ({
                    type: "function",
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                    strict: false,
                  })),
                },
              ],
              tool_choice: "auto",
              parallel_tool_calls: true,
            }
          : {}),
        reasoning: { effort: req.effort ?? "medium" },
        store: false,
        stream: true,
      }),
    });
  }

  return {
    provider: "chatgpt",
    model,
    async *stream(req: BrainRequest): AsyncIterable<BrainEvent> {
      let res = await open(req, false);
      if (res.status === 401) res = await open(req, true);
      logLimits(res);
      if (!res.ok || !res.body) throw await refusal(res);
      const limits = planLimits(res.headers);
      try {
        for await (const ev of readResponsesStream(res.body, req.signal)) yield ev.type === "done" && limits ? { ...ev, limits } : ev;
      } catch (err) {
        // A limit can also arrive mid-stream as response.failed: the headers may still say when it resets.
        throw err instanceof BrainError ? withReset(err, resetFrom(res.headers, limits)) : err;
      }
    },
  };
}
