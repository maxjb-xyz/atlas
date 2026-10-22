// The Worker: sign-in, the owner's agent socket, a small HTTP API for the
// benchmark, and the app's files. Everything else lives in the person agent.

import { getAgentByName, routeAgentRequest } from "agents";
import { SESSION_HEADER } from "./auth";
import { OWNER } from "./agent";
import { type AuthStore, handleAuth, owner, sameOrigin } from "./auth";

export { PersonAgent } from "./agent";
// Helpers are sub-agents of the person agent; the class must be exported by this name.
export { HelperAgent } from "./helper";
export { Workspace, WorkspaceEgress } from "./workspace";

/** The agent's HTTP-facing methods, typed narrowly (RPC stubs can't infer the log's recursive JSON type). */
interface OwnerApi {
  apiTurn(text: string): Promise<unknown>;
  apiRunsSince(seq: number): Promise<unknown[]>;
  apiLastSeq(): Promise<number>;
  apiCharacterCheck(): Promise<unknown>;
  apiApprove(id: string): Promise<{ ok: boolean; text: string }>;
  apiFile(id: string): Promise<{ key: string; name: string; type: string } | null>;
  apiWorkspaceGate(): Promise<{ allow: string[]; inject: Record<string, string> }>;
}

/** Passkeys, challenges and sessions live in the owner's agent. */
const authStore = async (env: Env) => (await getAgentByName(env.PersonAgent, OWNER)) as unknown as AuthStore;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // A preview of a server in the workspace (§9.1): the link's token is the permission, and the
    // workspace serves it sandboxed, so it can't act as Atlas with the owner's sign-in.
    if (/^\/preview\/[0-9a-f]{36}(\/|$)/.test(path)) {
      return env.WORKSPACE.getByName(OWNER).fetch(request);
    }

    // A sign-in to an MCP server comes back here (§9.2). It's a link from the service, so no sign-in cookie
    // comes with it (they're SameSite=Strict); the agent accepts only a sign-in it started, by its state.
    if (path === "/mcp/callback" && request.method === "GET") {
      return (await getAgentByName(env.PersonAgent, OWNER)).fetch(request);
    }

    if (path.startsWith("/api/")) {
      const auth = await handleAuth(request, env, path, () => authStore(env));
      if (auth) return auth;
      if (!(await owner(request, env, () => authStore(env)))) return json({ error: "Sign in first." }, 401);
      const agent = (await getAgentByName(env.PersonAgent, OWNER)) as unknown as OwnerApi;

      if (path === "/api/turn" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { text?: unknown };
        if (typeof body.text !== "string" || !body.text.trim()) return json({ error: 'Send {"text": "..."}.' }, 400);
        return json(await agent.apiTurn(body.text.slice(0, 20_000)));
      }
      // Approve from a push notification's button: the service worker posts here with the session cookie.
      if (path === "/api/approve" && request.method === "POST") {
        if (!sameOrigin(request)) return json({ error: "Wrong origin." }, 403);
        const body = (await request.json().catch(() => ({}))) as { id?: unknown };
        if (typeof body.id !== "string" || body.id.length > 64) return json({ error: 'Send {"id": "..."}.' }, 400);
        const out = await agent.apiApprove(body.id);
        return json(out, out.ok ? 200 : 409);
      }
      // The workspace's terminal (§9.1): the owner's only, from the app's own page.
      if (path === "/api/workspace/terminal" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!sameOrigin(request)) return json({ error: "Wrong origin." }, 403);
        const ws = env.WORKSPACE.getByName(OWNER);
        await ws.setGate(await agent.apiWorkspaceGate());
        return ws.fetch(new Request(`https://workspace/terminal${url.search}`, request));
      }
      // A file Atlas made (§21.7), from R2. It's served sandboxed, so an HTML or SVG file can't run scripts as Atlas.
      const file = /^\/api\/files\/([\w-]{1,64})$/.exec(path);
      if (file && request.method === "GET") {
        const meta = await agent.apiFile(file[1]!);
        const obj = meta ? await env.FILES.get(meta.key) : null;
        if (!meta || !obj) return json({ error: "That file isn't there any more." }, 404);
        const inline = url.searchParams.get("inline") === "1";
        return new Response(obj.body, {
          headers: {
            "content-type": meta.type,
            "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
            // Chrome's PDF viewer won't run in a sandbox; a PDF can't script this origin anyway.
            ...(meta.type === "application/pdf" ? {} : { "content-security-policy": "sandbox" }),
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
          },
        });
      }
      if (path === "/api/character-check" && request.method === "POST") {
        return json(await agent.apiCharacterCheck());
      }
      if (path === "/api/log" && request.method === "GET") {
        const since = Number(url.searchParams.get("since") ?? "0");
        return json({ rows: await agent.apiRunsSince(Number.isFinite(since) ? since : 0), last_seq: await agent.apiLastSeq() });
      }
      return json({ error: "Not found." }, 404);
    }

    if (path.startsWith("/agents/")) {
      const res = await routeAgentRequest(request, env, {
        onBeforeConnect: async (req, route) => {
          if (route.name !== OWNER) return new Response("Not found", { status: 404 });
          if (!sameOrigin(req)) return new Response("Wrong origin", { status: 403 });
          const who = await owner(req, env, () => authStore(env));
          if (!who) return new Response("Sign in first", { status: 401 });
          // The agent learns which sign-in opened this socket, so ending that sign-in can close it.
          const headers = new Headers(req.headers);
          headers.set(SESSION_HEADER, who.via === "session" ? who.id : "");
          return new Request(req, { headers });
        },
        // The agent is only reached over its socket; plain HTTP to it is refused.
        onBeforeRequest: () => new Response("Not found", { status: 404 }),
      });
      return res ?? new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
