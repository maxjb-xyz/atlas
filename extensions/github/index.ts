// GitHub (VISION §10.4): what GitHub has for the owner, as items for the
// intake. With a token, a look on the clock asks GitHub's notifications
// what's new since the last one (reviews requested, issues assigned,
// mentions, comments on what they're part of), so nothing needs setting up
// on GitHub. It also reads GitHub's webhook posts, at its own address or at
// a webhook source made before it existed.
//
// It's also where coding jobs' repos live (§8.2): the workspace clones and
// pushes over git with the same token (added at the workspace's gate, never
// in the container), and Atlas opens the pull request through it.

import { type Ctx, type Extension, type Item, type Json, type Repo, Failure, get, json, tidy } from "../sdk";

const API = "https://api.github.com";

/** Notification reasons, in words, and the signal each is. */
const REASONS: Record<string, string> = {
  review_requested: "review requested",
  assign: "assigned to you",
  mention: "you were mentioned",
  team_mention: "your team was mentioned",
  comment: "a comment",
  author: "activity on what you opened",
  state_change: "its state changed",
  ci_activity: "a CI run finished",
  security_alert: "a security alert",
  subscribed: "activity on what you watch",
  manual: "activity on what you watch",
  invitation: "an invitation",
};

const htmlOf = (api: string | undefined, repo: string) =>
  (api ?? "")
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/pulls/", "/pull/")
    .replace(/\/commits\/([0-9a-f]+)$/, "/commit/$1") || `https://github.com/${repo}`;

const numberOf = (api: string | undefined) => /\/(?:pulls|issues)\/(\d+)$/.exec(api ?? "")?.[1] ?? "";

/** A webhook post from GitHub as an item. */
export function webhookItem(event: string, delivery: string | undefined, p: Record<string, unknown>): Item {
  const obj = (k: string) => (p[k] && typeof p[k] === "object" ? (p[k] as Record<string, unknown>) : undefined);
  const pick = (o: Record<string, unknown> | undefined, ...keys: string[]) => keys.map((k) => tidy(o?.[k], 160)).find(Boolean) ?? "";
  const thing = obj("pull_request") ?? obj("issue") ?? obj("discussion") ?? obj("release") ?? obj("comment") ?? obj("check_run");
  const repo = pick(obj("repository"), "full_name");
  const who = pick(obj("sender"), "login");
  const action = tidy(p.action, 60);
  const title = pick(thing, "title", "name") || pick(obj("head_commit"), "message");
  const num = thing ? String(thing.number ?? thing.id ?? "") : "";
  const signals = [event, action, ...(p.requested_reviewer ? ["review_requested"] : []), ...(p.assignee ? ["assigned"] : [])].filter(
    Boolean,
  );
  const kind = signals.includes("review_requested") ? "review_requested" : signals.includes("assigned") ? "assign" : "";
  return {
    event: `${event}${action ? `.${action}` : ""}`,
    what: `GitHub: ${event.replace(/_/g, " ")}${action ? ` ${action.replace(/_/g, " ")}` : ""}${title ? `, "${title}"` : ""}${repo ? ` in ${repo}` : ""}${who ? ` by ${who}` : ""}`,
    ...(delivery ? { key: delivery } : {}),
    ...(thing ? { thread: `${repo}#${num}` } : repo ? { thread: repo } : {}),
    ...(who ? { from: who } : {}),
    signals,
    ...(kind && num ? { topic: `github:${repo}#${num}:${kind}` } : {}),
    ...(pick(thing, "html_url") || pick(obj("repository"), "html_url")
      ? { link: pick(thing, "html_url") || pick(obj("repository"), "html_url") }
      : {}),
  };
}

const ext: Extension = {
  manifest: {
    id: "github",
    name: "GitHub",
    version: "1.0.0",
    about:
      "Reviews requested of you, issues assigned to you, mentions and comments on GitHub, as things Atlas notices; and the repos coding jobs work on, where Atlas pushes a job's branch and opens its pull request. It never merges.",
    provides: ["sense", "code"],
    hosts: ["api.github.com"],
    secrets: [
      {
        name: "token",
        label: "Personal access token (classic)",
        help: "On GitHub: Settings → Developer settings → Personal access tokens → Tokens (classic), with the notifications and repo scopes (and workflow, if a coding job may change .github/workflows). GitHub's notifications only answer classic tokens. The repo scope is what lets a coding job clone your repos, push its branch and open a pull request; without it, a job stops before the push, in GitHub's words.",
        optional: true,
      },
      {
        name: "webhook_secret",
        label: "Webhook secret",
        help: "Only if you also send GitHub's webhooks to this extension's address: the secret you set on GitHub.",
        optional: true,
      },
    ],
    every: 2,
    look_needs: ["token"],
    receives: { signature: { header: "x-hub-signature-256", prefix: "sha256=", secret: "webhook_secret" }, claims: ["x-github-event"] },
    git: {
      clone: "https://github.com/{repo}.git",
      hosts: ["github.com"],
      user: "x-access-token",
      secret: "token",
      branch_link: "https://github.com/{repo}/tree/{branch}",
    },
  },
  async look(ctx) {
    const since = typeof ctx.cursor === "string" ? ctx.cursor : new Date(ctx.now - 60 * 60_000).toISOString();
    const started = new Date(ctx.now - 60_000).toISOString();
    const res = await get(`${API}/notifications?participating=true&all=false&since=${encodeURIComponent(since)}&per_page=50`, {
      headers: {
        authorization: `Bearer ${ctx.secret("token")}`,
        accept: "application/vnd.github+json",
        "user-agent": "Atlas",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.status === 304) return { items: [], cursor: since };
    const list = await json<
      Array<{
        id: string;
        reason: string;
        updated_at: string;
        subject: { title: string; url?: string; type: string };
        repository: { full_name: string };
      }>
    >(res, "GitHub");
    const items: Item[] = list.map((n) => {
      const repo = n.repository.full_name;
      const num = numberOf(n.subject.url);
      const kind =
        n.subject.type === "PullRequest"
          ? "pull request"
          : n.subject.type === "Issue"
            ? "issue"
            : n.subject.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
      return {
        event: n.reason,
        what: `GitHub: ${REASONS[n.reason] ?? n.reason.replace(/_/g, " ")} on the ${kind} "${tidy(n.subject.title, 160)}" in ${repo}`,
        key: `${n.id}:${n.updated_at}`,
        thread: num ? `${repo}#${num}` : repo,
        signals: [n.reason, n.subject.type],
        ...(num && (n.reason === "review_requested" || n.reason === "assign") ? { topic: `github:${repo}#${num}:${n.reason}` } : {}),
        link: htmlOf(n.subject.url, repo),
      };
    });
    return { items, cursor: started as Json };
  },
  async receive(_ctx, req) {
    const event = req.headers["x-github-event"];
    if (!event) return { reply: { status: 400, json: { error: "That isn't a GitHub webhook (no X-GitHub-Event)." } } };
    if (event === "ping") return { reply: { json: { ok: true } } };
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      throw new Failure("GitHub's post wasn't JSON. Set the webhook's content type to application/json.");
    }
    return {
      items: [{ ...webhookItem(event, req.headers["x-github-delivery"], p), raw: req.body.slice(0, 20_000) }],
      reply: { json: { ok: true } },
    };
  },
  async repos(ctx) {
    const list = await json<GhRepo[]>(
      await get(`${API}/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member`, { headers: headers(ctx) }),
      "GitHub",
    );
    return list.map(repoOf);
  },
  async repo(ctx, q) {
    return repoOf(await json<GhRepo>(await get(`${API}/repos/${repoPath(q.repo)}`, { headers: headers(ctx) }), "GitHub"));
  },
  async pull_request(ctx, pr) {
    const path = repoPath(pr.repo);
    const res = await get(`${API}/repos/${path}/pulls`, {
      method: "POST",
      headers: { ...headers(ctx), "content-type": "application/json" },
      body: JSON.stringify({ title: pr.title, head: pr.head, base: pr.base, body: pr.body }),
    });
    if (res.status === 422) {
      // One already open for this branch: that's the one.
      const owner = path.split("/")[0]!;
      const open = await json<Array<{ number: number; html_url: string }>>(
        await get(`${API}/repos/${path}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.head}`)}`, { headers: headers(ctx) }),
        "GitHub",
      );
      if (open[0]) return { number: open[0].number, link: open[0].html_url };
    }
    const made = await json<{ number: number; html_url: string }>(res, "GitHub");
    return { number: made.number, link: made.html_url };
  },
  async test(ctx) {
    if (ctx.has && !ctx.has.includes("token"))
      return {
        text: "Without a token, GitHub's webhooks still come in; add a token to hear about reviews, assignments and mentions without one.",
      };
    const me = await json<{ login: string; email?: string | null }>(
      await get(`${API}/user`, {
        headers: { authorization: `Bearer ${ctx.secret("token")}`, accept: "application/vnd.github+json", "user-agent": "Atlas" },
      }),
      "GitHub",
    );
    return { text: `GitHub knows this token as ${me.login}.`, ...(me.email ? { owner: { emails: [me.email] } } : {}) };
  },
};

interface GhRepo {
  full_name: string;
  description?: string | null;
  default_branch: string;
  html_url: string;
  private?: boolean;
  pushed_at?: string | null;
}

const headers = (ctx: Ctx) => ({
  authorization: `Bearer ${ctx.secret("token")}`,
  accept: "application/vnd.github+json",
  "user-agent": "Atlas",
  "x-github-api-version": "2022-11-28",
});

/** "owner/name", checked, for a path. */
function repoPath(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Failure(`"${repo}" isn't a GitHub repo, written as owner/name.`, "refused");
  return repo;
}

const repoOf = (r: GhRepo): Repo => ({
  repo: r.full_name,
  ...(r.description ? { about: tidy(r.description, 200) } : {}),
  default_branch: r.default_branch,
  link: r.html_url,
  ...(r.private != null ? { private: r.private } : {}),
  ...(r.pushed_at ? { pushed_at: r.pushed_at } : {}),
});

export default ext;
