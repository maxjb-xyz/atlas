// The Worker: sign-in, the owner's agent socket, a small HTTP API for the
// benchmark, and the app's files. Everything else lives in the person agent.

import { getAgentByName, routeAgentRequest } from "agents";
import { OWNER } from "./agent";
import { handleAuth, isOwner, sameOrigin } from "./auth";

export { PersonAgent } from "./agent";

/** The agent's HTTP-facing methods, typed narrowly (RPC stubs can't infer the log's recursive JSON type). */
interface OwnerApi {
  apiTurn(text: string): Promise<unknown>;
  apiRunsSince(seq: number): Promise<unknown[]>;
  apiLastSeq(): Promise<number>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      const auth = await handleAuth(request, env, path);
      if (auth) return auth;
      if (!(await isOwner(request, env))) return json({ error: "Sign in first." }, 401);
      const agent = (await getAgentByName(env.PersonAgent, OWNER)) as unknown as OwnerApi;

      if (path === "/api/turn" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { text?: unknown };
        if (typeof body.text !== "string" || !body.text.trim()) return json({ error: 'Send {"text": "..."}.' }, 400);
        return json(await agent.apiTurn(body.text.slice(0, 20_000)));
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
          if (!(await isOwner(req, env))) return new Response("Sign in first", { status: 401 });
          return undefined;
        },
        // The agent is only reached over its socket; plain HTTP to it is refused.
        onBeforeRequest: () => new Response("Not found", { status: 404 }),
      });
      return res ?? new Response("Not found", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
