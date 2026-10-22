// MCP Apps (§21.6): the page a connected server's tool brings, shown on the
// stage. Atlas is the host in the MCP Apps protocol (JSON-RPC over
// postMessage): the page initializes, then gets the tool's input and result;
// it can call its own server's tools, read its resources, ask for more
// height and open links. It runs in a sandboxed frame with no same-origin
// (so it can't reach Atlas or the owner's sign-in), under a
// Content-Security-Policy that allows only the domains its server declared.

import { useEffect, useMemo, useRef, useState } from "react";
import type { McpAppPage } from "../../core/src/protocol";
import type { Atlas } from "./connection";

/** The MCP Apps version this host speaks. */
const PROTOCOL = "2026-01-26";
const MAX_HEIGHT = 800;

type Answer = { type: string; req: string; page?: McpAppPage; result?: Record<string, unknown>; error?: string };

/**
 * The page's HTML with its policy first in <head>, so it applies before any
 * of its scripts run, and the app's light or dark as its starting color
 * scheme (the page gets the theme in its host context too, and can change it).
 */
function framed(page: McpAppPage): string {
  const meta =
    `<meta http-equiv="Content-Security-Policy" content="${page.csp.replace(/"/g, "&quot;")}">` +
    `<meta name="color-scheme" content="${theme()}">`;
  if (/<head[^>]*>/i.test(page.html)) return page.html.replace(/<head[^>]*>/i, (h) => h + meta);
  if (/<html[^>]*>/i.test(page.html)) return page.html.replace(/<html[^>]*>/i, (h) => `${h}<head>${meta}</head>`);
  return `<!doctype html><html><head>${meta}</head><body>${page.html}</body></html>`;
}

const theme = () => (document.documentElement.dataset.theme === "daylight" ? "light" : "dark");

export function McpAppFrame({ atlas, call, title }: { atlas: Atlas; call: string; title: string }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [page, setPage] = useState<McpAppPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(360);
  const connected = atlas.voice.connected;

  // Ask Atlas for the page and the call it shows.
  useEffect(() => {
    if (!connected || page) return;
    const req = crypto.randomUUID();
    const on = (e: Event) => {
      const m = (e as CustomEvent<Answer>).detail;
      if (m.type !== "atlas.mcp.app.result" || m.req !== req) return;
      if (m.page) setPage(m.page);
      else setError(m.error ?? "Its server didn't send its page.");
    };
    window.addEventListener("atlas:mcp", on);
    atlas.send({ type: "atlas.mcp.app", req, call });
    return () => window.removeEventListener("atlas:mcp", on);
  }, [call, connected, page]);

  // Be the page's host once it's loaded.
  useEffect(() => {
    if (!page) return;
    const win = () => frame.current?.contentWindow ?? null;
    const post = (msg: Record<string, unknown>) => win()?.postMessage({ jsonrpc: "2.0", ...msg }, "*");
    const reply = (id: unknown, result: unknown) => post({ id, result });
    const fail = (id: unknown, message: string, code = -32000) => post({ id, error: { code, message } });
    const pending = new Map<string, (a: Answer) => void>();
    const ask = (type: "atlas.mcp.app.call" | "atlas.mcp.app.read", body: Record<string, unknown>) =>
      new Promise<Answer>((resolve) => {
        const req = crypto.randomUUID();
        pending.set(req, resolve);
        atlas.send({ type, req, call, ...body } as never);
      });
    const onAnswer = (e: Event) => {
      const m = (e as CustomEvent<Answer>).detail;
      const done = pending.get(m.req);
      if (done) {
        pending.delete(m.req);
        done(m);
      }
    };
    const context = () => ({
      theme: theme(),
      platform: window.matchMedia("(max-width: 700px)").matches ? "mobile" : "web",
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: { maxHeight: MAX_HEIGHT },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      toolInfo: { tool: page.tool },
    });
    let ready = false;
    const onMessage = async (e: MessageEvent) => {
      if (e.source !== win()) return;
      const m = e.data as { jsonrpc?: string; id?: unknown; method?: unknown; params?: Record<string, unknown> };
      if (m?.jsonrpc !== "2.0" || typeof m.method !== "string") return;
      const { id, method, params = {} } = m;
      switch (method) {
        case "ui/initialize":
          return reply(id, {
            protocolVersion: PROTOCOL,
            hostInfo: { name: "Atlas", version: "1" },
            hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
            hostContext: context(),
          });
        case "ui/notifications/initialized":
          // Nothing goes to the page before it says it's ready; then its input, then its result.
          if (ready) return;
          ready = true;
          post({ method: "ui/notifications/tool-input", params: { arguments: page.input } });
          post({ method: "ui/notifications/tool-result", params: page.result });
          return;
        case "ui/notifications/size-changed":
          if (typeof params.height === "number") setHeight(Math.max(80, Math.min(MAX_HEIGHT, Math.ceil(params.height))));
          return;
        case "tools/call": {
          const a = await ask("atlas.mcp.app.call", { name: String(params.name ?? ""), arguments: params.arguments ?? {} });
          return a.result ? reply(id, a.result) : fail(id, a.error ?? "It didn't work.");
        }
        case "resources/read": {
          const a = await ask("atlas.mcp.app.read", { uri: String(params.uri ?? "") });
          return a.result ? reply(id, a.result) : fail(id, a.error ?? "It didn't work.");
        }
        case "ui/open-link": {
          const url = String(params.url ?? "");
          if (!/^https?:\/\//i.test(url)) return fail(id, "Only web links open.");
          window.open(url, "_blank", "noopener,noreferrer");
          return reply(id, {});
        }
        case "ui/request-display-mode":
          return reply(id, { mode: "inline" });
        case "ping":
          return reply(id, {});
        case "notifications/message":
          return;
        default:
          if (id !== undefined) fail(id, `Atlas doesn't do ${method} yet.`, -32601);
      }
    };
    // The page follows the app's theme.
    const watch = new MutationObserver(
      () => ready && post({ method: "ui/notifications/host-context-changed", params: { theme: theme() } }),
    );
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("message", onMessage);
    window.addEventListener("atlas:mcp", onAnswer);
    return () => {
      if (ready) post({ id: `teardown-${call}`, method: "ui/resource-teardown", params: { reason: "Closed." } });
      watch.disconnect();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("atlas:mcp", onAnswer);
    };
  }, [page]);

  const doc = useMemo(() => (page ? framed(page) : ""), [page]);
  if (error) return <p className="err small">{error}</p>;
  if (!page) return <p className="muted small">Opening its page…</p>;
  return (
    <>
      <iframe
        ref={frame}
        className={`app-frame ${page.border ? "" : "bare"}`}
        title={title}
        sandbox="allow-scripts allow-forms"
        srcDoc={doc}
        style={{ height }}
      />
      <p className="faint small" style={{ marginTop: 6 }}>
        From {page.server}. It can use only {page.server}'s own tools, and reach only what {page.server} declared.
      </p>
    </>
  );
}
