// The Worker: sign-in, the owner's agent socket, a small HTTP API for the
// benchmark, and the app's files. Everything else lives in the person agent.

import { getAgentByName, routeAgentRequest } from "agents";
import { SESSION_HEADER } from "./auth";
import { OWNER } from "./agent";
import { type AuthStore, handleAuth, owner, sameOrigin } from "./auth";

export { PersonAgent } from "./agent";
// Helpers are sub-agents of the person agent; the class must be exported by this name.
export { HelperAgent } from "./helper";

/** The agent's HTTP-facing methods, typed narrowly (RPC stubs can't infer the log's recursive JSON type). */
interface OwnerApi {
  apiTurn(text: string): Promise<unknown>;
  apiRunsSince(seq: number): Promise<unknown[]>;
  apiLastSeq(): Promise<number>;
  apiCharacterCheck(): Promise<unknown>;
  apiApprove(id: string): Promise<{ ok: boolean; text: string }>;
}

/** Passkeys, challenges and sessions live in the owner's agent. */
const authStore = async (env: Env) => (await getAgentByName(env.PersonAgent, OWNER)) as unknown as AuthStore;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

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
