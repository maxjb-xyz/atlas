// The Worker: sign-in, the owner's agent socket, a small HTTP API for the
// benchmark, and the app's files. Everything else lives in the person agent.

import { getAgentByName, routeAgentRequest } from "agents";
import { SESSION_HEADER } from "./auth";
import { CALL_HEADER, NODE_HEADER, OWNER } from "./agent";
import { bridge } from "./voice/phone";
import { NODE_KINDS } from "./nodes";
import { type AuthStore, handleAuth, memberOf, owner, sameOrigin } from "./auth";
import { agentNameOf } from "./members";

export { PersonAgent } from "./agent";
// Helpers are sub-agents of the person agent; the class must be exported by this name.
export { HelperAgent } from "./helper";
export { Workspace, WorkspaceEgress } from "./workspace";
// Extensions' only way out of their sandbox (§17).
export { ExtensionGate } from "./extensions";

/** The agent's HTTP-facing methods, typed narrowly (RPC stubs can't infer the log's recursive JSON type). */
interface OwnerApi {
  apiTurn(text: string): Promise<unknown>;
  apiRunsSince(seq: number): Promise<unknown[]>;
  apiLastSeq(): Promise<number>;
  apiCharacterCheck(): Promise<unknown>;
  apiApprove(id: string): Promise<{ ok: boolean; text: string }>;
  apiFile(id: string): Promise<{ key: string; name: string; type: string } | null>;
  apiWorkspaceGate(): Promise<{ allow: string[]; inject: Record<string, string> }>;
  apiReaction(id: string, how: "opened" | "dismissed"): Promise<void>;
}

interface SenseApi {
  apiOwnTracks(authorization: string | null, text: string): Promise<{ status: number; body: string; headers: Record<string, string> }>;
  apiExtPost(
    id: string,
    key: string,
    req: { method: string; headers: Record<string, string>; body: string; query: Record<string, string> },
  ): Promise<{ status: number; body: string; headers: Record<string, string> }>;
  apiExtSignin(state: string, code: string | null, error: string | null): Promise<{ ok: boolean; text: string }>;
  apiMailIn(time: string | null, signature: string | null, body: Uint8Array): Promise<{ status: number; text: string }>;
  apiPairStart(o: {
    name: string;
    kind: (typeof NODE_KINDS)[number];
    platform?: string;
  }): Promise<{ code: string; poll: string; expires: number }>;
  apiPairPoll(poll: string): Promise<unknown>;
  apiNodeAuth(token: string): Promise<string | null>;
  apiSenseHook(id: string, key: string | null, headers: Record<string, string>, text: string): Promise<{ status: number; body: unknown }>;
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
    if (path === "/mcp/callback" && request.method === "GET" && !request.headers.get("upgrade")) {
      // Only the device route may say a request comes from a paired device.
      const headers = new Headers(request.headers);
      headers.delete(NODE_HEADER);
      return (await getAgentByName(env.PersonAgent, OWNER)).fetch(new Request(request, { headers }));
    }

    // The location app's address from before it was an extension (§10.1): its post goes to the location extension,
    // which checks OwnTracks' own user and password. They open nothing else.
    if (path === "/owntracks" && request.method === "POST") {
      const agent = (await getAgentByName(env.PersonAgent, OWNER)) as unknown as SenseApi;
      const text = await request.text();
      if (text.length > 64_000) return json({ error: "That's too big for one OwnTracks post." }, 413);
      const out = await agent.apiOwnTracks(request.headers.get("authorization"), text);
      return new Response(out.body, { status: out.status, headers: out.headers });
    }

    // A sign-in an extension asked for comes back here (§17). It's a link from the service, so no sign-in cookie comes
    // with it; the agent accepts only a sign-in it started, by its state.
    if (path === "/x/signin" && request.method === "GET") {
      const agent = (await getAgentByName(env.PersonAgent, OWNER)) as unknown as SenseApi;
      const out = await agent.apiExtSignin(
        url.searchParams.get("state") ?? "",
        url.searchParams.get("code"),
        url.searchParams.get("error"),
      );
      const back = `${url.origin}/#/abilities/services?signin=${out.ok ? "ok" : "failed"}&note=${encodeURIComponent(out.text)}`;
      return Response.redirect(back, 302);
    }

    // Atlas's own address (§16.2): its relay Worker, in the domain's account, posts each mail here, signed.
    if (path === "/mail/in" && request.method === "POST") {
      const agent = (await getAgentByName(env.PersonAgent, OWNER)) as unknown as SenseApi;
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.length > 30_000_000) return json({ error: "That mail is too big: 30 MB at most." }, 413);
      const out = await agent.apiMailIn(request.headers.get("x-atlas-time"), request.headers.get("x-atlas-signature"), body);
      return new Response(out.text, { status: out.status });
    }

    // A phone call's audio (§16.1): the phone service streams to its extension's address. Checked by the address's
    // key, then joined to Atlas's voice as a voice client of its own, through the bridge.
    const stream = /^\/x\/([a-z][a-z0-9-]{1,39})\/([0-9a-f]{36})\/stream\/([0-9a-f]{32})$/.exec(path);
    if (stream && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const agent = await getAgentByName(env.PersonAgent, OWNER);
      const ok = await (
        agent as unknown as { apiCallStream(id: string, key: string, token: string): Promise<{ ok: boolean; rate: number }> }
      ).apiCallStream(stream[1]!, stream[2]!, stream[3]!);
      if (!ok.ok) return new Response("This isn't a phone stream's address.", { status: 401 });
      const call = (url.searchParams.get("call") ?? "in").slice(0, 200);
      const res = await agent.fetch(
        new Request(new URL("/calls/connect", url), { headers: { upgrade: "websocket", [CALL_HEADER]: call } }),
      );
      const voice = res.webSocket;
      if (!voice) return new Response(`Atlas didn't take the call (HTTP ${res.status}).`, { status: 502 });
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      server.accept();
      voice.accept();
      bridge(server as never, voice as never, {
        rate: ok.rate,
        onEnd: (why) => console.log(JSON.stringify({ at: "call.end", call, why })),
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    // An extension's own address (§17): a service posts here, checked by the address's key and the service's signature.
    const ext = /^\/x\/([a-z][a-z0-9-]{1,39})\/([0-9a-f]{36})$/.exec(path);
    if (ext) {
      const agent = (await getAgentByName(env.PersonAgent, OWNER)) as unknown as SenseApi;
      const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      if (text.length > 1_000_000) return json({ error: "That's too big for one post: 1 MB at most." }, 413);
      const headers: Record<string, string> = {};
      for (const [k, v] of request.headers) if (!/^(cookie|cf-|x-forwarded|x-real-ip)/i.test(k)) headers[k.toLowerCase()] = v;
      const out = await agent.apiExtPost(ext[1]!, ext[2]!, {
        method: request.method,
        headers,
        body: text,
        query: Object.fromEntries(url.searchParams),
      });
      return new Response(out.body, { status: out.status, headers: out.headers });
    }

    // Webhook sources (§10.4): any service posts to its own address, checked by its key or its signature.
    const hook = /^\/senses\/(hk_[a-z0-9]+)$/.exec(path);
    if (hook && request.method === "POST") {
      const agent = (await getAgentByName(env.PersonAgent, OWNER)) as unknown as SenseApi;
      const text = await request.text();
      if (text.length > 256_000) return json({ error: "That's too big for one post: 256 KB at most." }, 413);
      const headers: Record<string, string> = {};
      for (const [k, v] of request.headers)
        if (/^(x-github-|linear-|x-hub-|content-type$|user-agent$)/i.test(k)) headers[k.toLowerCase()] = v;
      const out = await agent.apiSenseHook(hook[1]!, url.searchParams.get("key"), headers, text);
      return json(out.body, out.status);
    }

    // Paired devices (§16.3). Pairing is the device flow: the device asks for a code, shows it, and polls;
    // the owner says yes in the app, signed in. Only then does the device get a token, which opens its socket.
    if (path.startsWith("/nodes/")) {
      const agent = (await getAgentByName(env.PersonAgent, OWNER)) as unknown as SenseApi;
      if (path === "/nodes/pair/start" && request.method === "POST") {
        const b = (await request.json().catch(() => ({}))) as { name?: unknown; kind?: unknown; platform?: unknown };
        const kind = NODE_KINDS.find((k) => k === b.kind);
        if (typeof b.name !== "string" || !b.name.trim() || !kind) {
          return json({ error: `Send {"name": "...", "kind": one of ${NODE_KINDS.join(", ")}}.` }, 400);
        }
        try {
          const p = await agent.apiPairStart({
            name: b.name.trim().slice(0, 80),
            kind,
            ...(typeof b.platform === "string" ? { platform: b.platform } : {}),
          });
          return json({ ...p, link: `${url.origin}/#/pair/${p.code}` });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 429);
        }
      }
      if (path === "/nodes/pair/poll" && request.method === "POST") {
        const b = (await request.json().catch(() => ({}))) as { poll?: unknown };
        if (typeof b.poll !== "string" || b.poll.length > 100) return json({ error: 'Send {"poll": "..."}.' }, 400);
        return json(await agent.apiPairPoll(b.poll));
      }
      if (path === "/nodes/connect" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
        const id = token ? await agent.apiNodeAuth(token) : null;
        if (!id) return json({ error: "This device isn't paired with this Atlas any more. Pair it again." }, 401);
        const headers = new Headers(request.headers);
        headers.set(NODE_HEADER, id);
        headers.delete("authorization");
        return (await getAgentByName(env.PersonAgent, OWNER)).fetch(new Request(request, { headers }));
      }
      return json({ error: "Not found." }, 404);
    }

    if (path.startsWith("/api/")) {
      const auth = await handleAuth(request, env, path, () => authStore(env));
      if (auth) return auth;
      const who = await owner(request, env, () => authStore(env));
      if (!who) return json({ error: "Sign in first." }, 401);
      // A member's requests go to their own Atlas (§7.1); the workspace and the log API are the owner's.
      const member = memberOf(who);
      if (member && !(await (await authStore(env)).memberInfo(member))) return json({ error: "Sign in first." }, 401);
      if (member && (path.startsWith("/api/workspace/") || path === "/api/log" || path === "/api/character-check"))
        return json({ error: "That's only for the owner." }, 403);
      const agent = (await getAgentByName(env.PersonAgent, agentNameOf(member))) as unknown as OwnerApi;

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
      // A notification opened or dismissed (§10.3): the service worker says so, with the session cookie.
      if (path === "/api/reaction" && request.method === "POST") {
        if (!sameOrigin(request)) return json({ error: "Wrong origin." }, 403);
        const body = (await request.json().catch(() => ({}))) as { id?: unknown; how?: unknown };
        if (typeof body.id !== "string" || body.id.length > 64 || (body.how !== "opened" && body.how !== "dismissed")) {
          return json({ error: 'Send {"id": "...", "how": "opened" or "dismissed"}.' }, 400);
        }
        await agent.apiReaction(body.id, body.how);
        return json({ ok: true });
      }
      // The workspace's terminal (§9.1): the owner's only, from the app's own page.
      if (path === "/api/workspace/terminal" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!sameOrigin(request)) return json({ error: "Wrong origin." }, 403);
        try {
          const ws = env.WORKSPACE.getByName(OWNER);
          await ws.setGate(await agent.apiWorkspaceGate());
          return await ws.fetch(new Request(`https://workspace/terminal${url.search}`, request));
        } catch (err) {
          const error = `The terminal couldn't open: ${err instanceof Error ? err.message : String(err)}`;
          console.error(JSON.stringify({ at: "workspace.terminal", error }));
          return json({ error }, 502);
        }
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
          if (!sameOrigin(req)) return new Response("Wrong origin", { status: 403 });
          const who = await owner(req, env, () => authStore(env));
          if (!who) return new Response("Sign in first", { status: 401 });
          // Each person's socket goes to their own Atlas only: the owner's, or a member's (§7.1).
          const member = memberOf(who);
          if (route.name !== agentNameOf(member)) return new Response("Not found", { status: 404 });
          if (member && !(await (await authStore(env)).memberInfo(member))) return new Response("Sign in first", { status: 401 });
          // The agent learns which sign-in opened this socket, so ending that sign-in can close it.
          const headers = new Headers(req.headers);
          headers.set(SESSION_HEADER, who.via === "session" ? who.id : "");
          // Only the Worker's own device route says a socket is a paired device.
          headers.delete(NODE_HEADER);
          headers.delete(CALL_HEADER);
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
