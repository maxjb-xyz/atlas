// Linear (VISION §10.4): issues assigned to the owner, mentions and comments,
// as items for the intake. With a personal API key, a look on the clock asks
// Linear's notifications what's new since the last one. It also reads
// Linear's webhook posts, at its own address or at a webhook source made
// before it existed.

import { type Extension, type Item, type Json, Failure, get, json, tidy } from "../sdk";

const TYPES: Record<string, string> = {
  issueAssignedToYou: "assigned to you",
  issueMention: "you were mentioned",
  issueCommentMention: "you were mentioned in a comment",
  issueNewComment: "a new comment",
  issueCommentReaction: "a reaction to your comment",
  issueStatusChanged: "its status changed",
  issueUnassignedFromYou: "unassigned from you",
  issuePriorityUrgent: "marked urgent",
  issueDue: "it's due",
  issueSubscribed: "you were subscribed",
};

const QUERY = `query Atlas { notifications(first: 50, orderBy: createdAt) { nodes { id type createdAt readAt ... on IssueNotification { actor { name email } issue { identifier title url } comment { body } } } } }`;

/** A webhook post from Linear as an item. */
export function webhookItem(delivery: string | undefined, p: Record<string, unknown>): Item {
  const data = p.data && typeof p.data === "object" ? (p.data as Record<string, unknown>) : {};
  const title = tidy(data.title ?? data.name ?? data.body, 160);
  const id = tidy(data.identifier, 40);
  const type = tidy(p.type, 40);
  const action = tidy(p.action, 40);
  return {
    event: `${type}.${action}`,
    what: `Linear: ${type} ${action}${id ? ` ${id}` : ""}${title ? `, "${title}"` : ""}`,
    ...(delivery ? { key: delivery } : {}),
    ...(id || data.id ? { thread: id || String(data.id) } : {}),
    signals: [type, action].filter(Boolean),
    ...(tidy(p.url, 400) || tidy(data.url, 400) ? { link: tidy(p.url, 400) || tidy(data.url, 400) } : {}),
  };
}

const ext: Extension = {
  manifest: {
    id: "linear",
    name: "Linear",
    version: "1.0.0",
    about: "Issues assigned to you, mentions and comments in Linear, as things Atlas notices. It only reads.",
    provides: ["sense"],
    hosts: ["api.linear.app"],
    secrets: [
      { name: "key", label: "Personal API key", help: "In Linear: Settings → Security & access → Personal API keys.", optional: true },
      {
        name: "webhook_secret",
        label: "Webhook signing secret",
        help: "Only if you also send Linear's webhooks to this extension's address.",
        optional: true,
      },
    ],
    every: 2,
    look_needs: ["key"],
    receives: { signature: { header: "linear-signature", secret: "webhook_secret" }, claims: ["linear-delivery"] },
  },
  async look(ctx) {
    const since = typeof ctx.cursor === "string" ? Date.parse(ctx.cursor) : ctx.now - 60 * 60_000;
    const res = await get("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: ctx.secret("key"), "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY }),
    });
    const body = await json<{
      data?: {
        notifications?: {
          nodes?: Array<{
            id: string;
            type: string;
            createdAt: string;
            actor?: { name?: string; email?: string } | null;
            issue?: { identifier: string; title: string; url: string } | null;
            comment?: { body?: string } | null;
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    }>(res, "Linear");
    if (body.errors?.length)
      throw new Failure(
        `Linear answered: ${body.errors.map((e) => e.message).join("; ")}`,
        /auth/i.test(body.errors[0]!.message) ? "auth" : "protocol",
      );
    let newest = since;
    const items: Item[] = [];
    for (const n of body.data?.notifications?.nodes ?? []) {
      const at = Date.parse(n.createdAt);
      if (!(at > since)) continue;
      newest = Math.max(newest, at);
      const who = n.actor?.name ? (n.actor.email ? `${n.actor.name} <${n.actor.email}>` : n.actor.name) : "";
      items.push({
        event: n.type,
        what: `Linear: ${TYPES[n.type] ?? n.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}${n.issue ? ` on ${n.issue.identifier}, "${tidy(n.issue.title, 160)}"` : ""}${who ? ` by ${n.actor!.name}` : ""}`,
        key: n.id,
        ...(n.issue ? { thread: n.issue.identifier, link: n.issue.url } : {}),
        ...(who ? { from: who } : {}),
        signals: [n.type],
        ...(n.comment?.body ? { raw: n.comment.body.slice(0, 8_000) } : {}),
      });
    }
    return { items, cursor: new Date(newest).toISOString() as Json };
  },
  async receive(_ctx, req) {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      throw new Failure("Linear's post wasn't JSON.");
    }
    return {
      items: [{ ...webhookItem(req.headers["linear-delivery"], p), raw: req.body.slice(0, 20_000) }],
      reply: { json: { ok: true } },
    };
  },
  async test(ctx) {
    if (ctx.has && !ctx.has.includes("key"))
      return { text: "Without a key, Linear's webhooks still come in; add a key to hear about what's assigned to you or mentions you." };
    const res = await get("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: ctx.secret("key"), "content-type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { name email } }" }),
    });
    const body = await json<{ data?: { viewer?: { name: string; email: string } }; errors?: Array<{ message: string }> }>(res, "Linear");
    if (!body.data?.viewer) throw new Failure(`Linear answered: ${body.errors?.map((e) => e.message).join("; ") ?? "no viewer"}`, "auth");
    return { text: `Linear knows this key as ${body.data.viewer.name}.`, owner: { emails: [body.data.viewer.email] } };
  },
};

export default ext;
