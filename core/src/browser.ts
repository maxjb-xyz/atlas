// The browser (§9.1): Browser Run, behind a small interface so a preview
// can change under it (§19.3). One browser per person, kept for ten minutes
// without use. Atlas drives it with a few narrow tools (open, look, click,
// type, submit), so the rule for what asks stays code, by kind (§12): a
// submit is an action that waits for the owner's OK, never a click. The
// owner watches it live on the stage and can take it over for a login or a
// captcha. Its pages are someone else's words (§20).

import { readable } from "./web";
import type { BrowserState } from "./stage";

export type { BrowserState };

/** Something on the page Atlas can act on, by its number. */
export interface PageElement {
  ref: string;
  kind: "link" | "button" | "field" | "select" | "check";
  text: string;
  href?: string;
  /** For a field: its type ("text", "email", "password", "search", "textarea"). */
  field?: string;
  /** What's in a field now. Passwords and card details only say whether they're filled. */
  value?: string;
  checked?: boolean;
  options?: string[];
  /** A button that sends its form: only browser_submit presses it. */
  submits?: boolean;
}

export interface BrowserPage {
  url: string;
  title: string;
  /** The page's readable text, from `start`, at most PAGE_CHARS. */
  text: string;
  length: number;
  elements: PageElement[];
}

export type BrowserAction =
  | { act: "click"; ref: string }
  | { act: "type"; ref: string; text: string }
  | { act: "select"; ref: string; option: string }
  | { act: "scroll"; down: boolean }
  | { act: "back" }
  /** Sends a form: presses a submit button, or Enter in a field. */
  | { act: "submit"; ref: string };

/** Atlas's browser. Every method throws an Error in plain words, with Browser Run's own when it said something. */
export interface BrowserDriver {
  open(url: string, o?: { start?: number }): Promise<BrowserPage>;
  look(o?: { start?: number }): Promise<BrowserPage>;
  act(a: BrowserAction): Promise<BrowserPage>;
  /**
   * Puts values into fields, then presses `press` if given: the vault's
   * last step (§15). Nothing about the values comes back but the page.
   */
  fill(fields: Array<{ ref: string; value: string }>, press?: string): Promise<BrowserPage>;
  /** The element `ref` as it is now on the page at `url`, or null when the page changed. */
  find(ref: string): Promise<PageElement | null>;
  /** A live-view link: read-only, or one the owner can drive. */
  live(control: boolean): Promise<string>;
  close(): Promise<void>;
  /** Whether a browser is open now, and on what. */
  where(): { open: boolean; url: string; title: string };
  /**
   * A file as the browser gets it, with the page's cookies (a site's check it already passed, a sign-in): `url`, or
   * the page open now. At most `max` bytes.
   */
  download(url: string | null, max: number): Promise<Download>;
}

/** A file the browser got. */
export interface Download {
  url: string;
  /** Its name from the site (Content-Disposition), else from its address. */
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** A file's name from its headers, else the last part of its address. */
export function downloadName(url: string, headers: Record<string, string>): string {
  const cd = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-disposition")?.[1] ?? "";
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(cd)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd)?.[1];
  const fromCd = star ? decodeURIComponent(star) : plain;
  let fromUrl = "";
  try {
    fromUrl = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    // Not an address: no name from it.
  }
  return (
    (fromCd || fromUrl || "download")
      .replace(/[\/\\\0]/g, "_")
      .trim()
      .slice(0, 120) || "download"
  );
}

/** The most of a page's text Atlas reads at once. */
export const PAGE_CHARS = 12_000;

/** How long the browser stays open without use. Browser Run's longest. */
export const KEEP_ALIVE_MS = 10 * 60_000;

// --- a small Chrome DevTools Protocol client ----------------------------------------------

class Cdp {
  #id = 0;
  #waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  #closed: string | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string; data?: string };
      };
      const w = m.id != null ? this.#waiting.get(m.id) : undefined;
      if (!w) return;
      this.#waiting.delete(m.id!);
      clearTimeout(w.timer);
      if (m.error) w.reject(new Error(`${m.error.message ?? "The browser refused"}${m.error.data ? `: ${m.error.data}` : ""}`));
      else w.resolve(m.result);
    });
    ws.addEventListener("close", (e) => this.#fail(`The browser connection closed (${e.code}${e.reason ? `: ${e.reason}` : ""}).`));
    ws.addEventListener("error", () => this.#fail("The browser connection failed."));
  }

  #fail(why: string) {
    this.#closed ??= why;
    for (const w of this.#waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(why));
    }
    this.#waiting.clear();
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, session?: string, ms = 20_000): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(this.#closed));
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`The browser didn't answer ${method} within ${Math.round(ms / 1000)} s.`));
      }, ms);
      this.#waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }

  close() {
    this.#fail("Closed.");
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

// --- what runs in the page ---------------------------------------------------------------

/** Numbers what can be acted on, and reads the page. Values of passwords and card fields never leave the page. */
const SNAPSHOT = `(() => {
  document.querySelectorAll('[data-atlas-ref]').forEach((e) => e.removeAttribute('data-atlas-ref'));
  const sel = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [contenteditable="true"], [contenteditable=""]';
  const hidden = /password|card|cc-|cvc|cvv|ssn|pin|one-time-code/i;
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 150) break;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden') continue;
    const role = el.getAttribute('role');
    const words = (s) => (s || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
    const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder');
    const text = words(label || (tag === 'select' ? el.getAttribute('name') || el.getAttribute('title') : '') || el.innerText || (tag === 'input' && ['submit', 'button'].includes(type) ? el.value : '') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('alt'));
    const kind = tag === 'a' || role === 'link' ? 'link'
      : tag === 'select' ? 'select'
      : (tag === 'input' && (type === 'checkbox' || type === 'radio')) || role === 'checkbox' ? 'check'
      : (tag === 'input' && !['submit', 'button', 'reset', 'image'].includes(type)) || tag === 'textarea' || el.isContentEditable ? 'field'
      : 'button';
    const ref = String(++n);
    el.setAttribute('data-atlas-ref', ref);
    const item = { ref, kind, text };
    if (kind === 'link' && el.href) item.href = el.href;
    if (kind === 'field') {
      item.field = tag === 'textarea' ? 'textarea' : type || 'text';
      const secret = type === 'password' || hidden.test((el.getAttribute('autocomplete') || '') + ' ' + (el.name || '') + ' ' + (el.id || ''));
      const v = el.isContentEditable ? el.innerText : el.value;
      item.value = secret ? (v ? '(filled)' : '') : words(v);
    }
    if (kind === 'check') item.checked = !!el.checked || el.getAttribute('aria-checked') === 'true';
    if (kind === 'select') item.options = [...el.options].slice(0, 30).map((o) => words(o.text));
    if (kind === 'button' && el.form && (tag === 'input' ? ['submit', 'image'].includes(type) : tag === 'button' && type !== 'button' && type !== 'reset')) item.submits = true;
    out.push(item);
  }
  return { url: location.href, title: document.title, html: document.documentElement.outerHTML.slice(0, 3000000), elements: out };
})()`;

const byRef = (ref: string) => `document.querySelector('[data-atlas-ref="${ref.replace(/[^0-9]/g, "")}"]')`;

/** Where an element is, scrolled into view, so a click lands where a person's would. */
const POINT = (ref: string) => `(() => {
  const el = ${byRef(ref)};
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

// --- Browser Run --------------------------------------------------------------------------

interface Saved {
  session: string;
  target: string | null;
  url: string;
  title: string;
  at: number;
}

/** Where the driver keeps its session between calls: the agent's own storage. */
export interface BrowserStore {
  get(): Saved | null;
  set(s: Saved | null): void;
}

/** The Browser Run binding's typed methods Atlas uses. */
type Binding = Pick<BrowserRun, "fetch" | "acquire" | "getLiveView" | "closeSession">;

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Atlas's browser on Browser Run. Each call connects to the session, does
 * its work over CDP, reads the page, and lets go; the session stays open
 * for ten minutes without use. A session that's gone is replaced, and the
 * call says the page has to be opened again.
 */
export class BrowserRunDriver implements BrowserDriver {
  constructor(
    private readonly binding: Binding,
    private readonly store: BrowserStore,
  ) {}

  where() {
    const s = this.store.get();
    return s && Date.now() - s.at < KEEP_ALIVE_MS ? { open: true, url: s.url, title: s.title } : { open: false, url: "", title: "" };
  }

  async open(url: string, o: { start?: number } = {}): Promise<BrowserPage> {
    return this.#with(true, async (cdp, page) => {
      const nav = await cdp.send<{ errorText?: string }>("Page.navigate", { url }, page, 30_000);
      if (nav.errorText) throw new Error(`The browser couldn't open ${url}: ${nav.errorText}.`);
      await this.#settle(cdp, page);
      return this.#read(cdp, page, o.start);
    });
  }

  async look(o: { start?: number } = {}): Promise<BrowserPage> {
    return this.#with(false, (cdp, page) => this.#read(cdp, page, o.start));
  }

  async find(ref: string): Promise<PageElement | null> {
    return this.#with(false, async (cdp, page) => (await this.#read(cdp, page)).elements.find((e) => e.ref === ref) ?? null);
  }

  async act(a: BrowserAction): Promise<BrowserPage> {
    return this.#with(false, async (cdp, page) => {
      const evalIn = async <T>(expression: string): Promise<T> => {
        const r = await cdp.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          page,
        );
        if (r.exceptionDetails) throw new Error(`The page refused: ${r.exceptionDetails.text ?? "an error"}.`);
        return r.result?.value as T;
      };
      const click = async (ref: string) => {
        const at = await evalIn<{ x: number; y: number } | null>(POINT(ref));
        if (!at) throw new Error(`There's no element ${ref} on the page any more. Look again for the new numbers.`);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
          await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, page);
      };
      switch (a.act) {
        case "click":
        case "submit": {
          if (a.act === "submit") {
            const isField = await evalIn<boolean | null>(
              `(() => { const el = ${byRef(a.ref)}; return el ? el.matches('input, textarea') && !['submit','image','button'].includes((el.type || '').toLowerCase()) : null; })()`,
            );
            if (isField === null) throw new Error(`There's no element ${a.ref} on the page any more. Look again for the new numbers.`);
            if (isField) {
              await evalIn(`${byRef(a.ref)}.focus()`);
              for (const type of ["keyDown", "keyUp"])
                await cdp.send(
                  "Input.dispatchKeyEvent",
                  { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) },
                  page,
                );
              break;
            }
          }
          await click(a.ref);
          break;
        }
        case "type": {
          const ok = await evalIn<boolean>(
            `(() => { const el = ${byRef(a.ref)}; if (!el) return false; el.focus(); if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } else if (el.isContentEditable) el.innerText = ''; return true; })()`,
          );
          if (!ok) throw new Error(`There's no element ${a.ref} on the page any more. Look again for the new numbers.`);
          await cdp.send("Input.insertText", { text: a.text }, page);
          break;
        }
        case "select": {
          const picked = await evalIn<string | null>(
            `(() => { const el = ${byRef(a.ref)}; if (!el || !el.options) return null; const want = ${JSON.stringify(a.option.toLowerCase())}; const o = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) || [...el.options].find((o) => o.text.toLowerCase().includes(want)); if (!o) return ''; el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return o.text.trim(); })()`,
          );
          if (picked === null) throw new Error(`Element ${a.ref} isn't a list to choose from.`);
          if (picked === "") throw new Error(`Element ${a.ref} has no option "${a.option}".`);
          break;
        }
        case "scroll":
          await evalIn(`window.scrollBy(0, ${a.down ? "" : "-"}Math.round(innerHeight * 0.8))`);
          break;
        case "back":
          await evalIn("history.back()");
          break;
      }
      await this.#settle(cdp, page, a.act === "type" || a.act === "scroll" ? 300 : 1_000);
      return this.#read(cdp, page);
    });
  }

  async fill(fields: Array<{ ref: string; value: string }>, press?: string): Promise<BrowserPage> {
    for (const f of fields) await this.act({ act: "type", ref: f.ref, text: f.value });
    return press ? this.act({ act: "submit", ref: press }) : this.look();
  }

  async live(control: boolean): Promise<string> {
    const s = this.store.get();
    if (!s || Date.now() - s.at >= KEEP_ALIVE_MS) throw new Error("The browser isn't open.");
    try {
      const v = await this.binding.getLiveView(s.session, {
        mode: "tab",
        ...(s.target ? { targetId: s.target } : {}),
        ...(control ? {} : { guardrails: { mode: "readonly" as const } }),
      });
      return v.devtoolsFrontendUrl;
    } catch (err) {
      throw new Error(`Browser Run wouldn't give a live view: ${why(err)}`);
    }
  }

  async close(): Promise<void> {
    const s = this.store.get();
    this.store.set(null);
    if (s) await this.binding.closeSession(s.session).catch(() => {});
  }

  /**
   * Connects to the browser (opening one when `fresh` is allowed), finds its
   * tab, runs `fn`, and remembers where the tab is. A session Browser Run has
   * let go is replaced only by `open`; anything else says so.
   */
  async #with<T>(fresh: boolean, fn: (cdp: Cdp, page: string) => Promise<T>): Promise<T> {
    let s = this.store.get();
    let cdp = s && Date.now() - s.at < KEEP_ALIVE_MS ? await this.#connect(s.session).catch(() => null) : null;
    if (!cdp) {
      if (!fresh) {
        this.store.set(null);
        throw new Error("The browser isn't open (it closes after ten minutes without use). Open the page again with browser_open.");
      }
      let session: string;
      try {
        session = (await this.binding.acquire({ keepAlive: KEEP_ALIVE_MS })).sessionId;
      } catch (err) {
        throw new Error(`Browser Run wouldn't start a browser: ${why(err)}`);
      }
      s = { session, target: null, url: "", title: "", at: Date.now() };
      cdp = await this.#connect(session);
    }
    try {
      const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>("Target.getTargets");
      const pages = targets.targetInfos.filter((t) => t.type === "page");
      const target =
        pages.find((t) => t.targetId === s!.target)?.targetId ??
        pages[0]?.targetId ??
        (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
      const { sessionId: page } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target, flatten: true });
      const out = await fn(cdp, page);
      const page2 = out as { url?: unknown; title?: unknown } | null;
      const where =
        page2 && typeof page2 === "object" && typeof page2.url === "string" && typeof page2.title === "string" && !("bytes" in page2)
          ? { url: page2.url, title: page2.title }
          : { url: s!.url, title: s!.title };
      this.store.set({ session: s!.session, target, ...where, at: Date.now() });
      return out;
    } finally {
      cdp.close();
    }
  }

  /**
   * Gets a file the way the page would (its cookies, past a check it cleared), and not blocked by the page's own
   * rules on other sites: Chrome's own loader (Network.loadNetworkResource), read in pieces.
   */
  async download(url: string | null, max: number): Promise<Download> {
    return this.#with(false, async (cdp, page) => {
      const tree = await cdp.send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree", {}, page);
      const here = tree.frameTree.frame.url;
      let target: string;
      try {
        target = new URL(url ?? here, here).toString();
      } catch {
        throw new Error(`"${url}" isn't an address the browser can get.`);
      }
      const got = await cdp.send<{
        resource: { success: boolean; netErrorName?: string; httpStatusCode?: number; stream?: string; headers?: Record<string, string> };
      }>(
        "Network.loadNetworkResource",
        { frameId: tree.frameTree.frame.id, url: target, options: { disableCache: false, includeCredentials: true } },
        page,
        60_000,
      );
      const r = got.resource;
      if (!r.success || !r.stream)
        throw new Error(
          `The browser couldn't get ${target}: ${r.httpStatusCode ? `the site answered ${r.httpStatusCode}` : (r.netErrorName ?? "it failed")}.`,
        );
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await cdp.send<{ data: string; eof: boolean; base64Encoded?: boolean }>(
            "IO.read",
            { handle: r.stream, size: 4 * 1024 * 1024 },
            page,
            60_000,
          );
          const bytes = chunk.base64Encoded
            ? Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(chunk.data);
          size += bytes.length;
          if (size > max) throw new Error(`${target} is over the ${Math.round(max / 1e6)} MB the browser saves.`);
          parts.push(bytes);
          if (chunk.eof) break;
        }
      } finally {
        await cdp.send("IO.close", { handle: r.stream }, page).catch(() => {});
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.length;
      }
      const headers = r.headers ?? {};
      const type = (Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "application/octet-stream")
        .split(";")[0]!
        .trim();
      return { url: target, name: downloadName(target, headers), type, bytes };
    });
  }

  async #connect(session: string): Promise<Cdp> {
    const res = await this.binding.fetch(`https://localhost/v1/devtools/browser/${session}`, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) throw new Error(`Browser Run answered ${res.status}${res.ok ? "" : `: ${(await res.text().catch(() => "")).slice(0, 200)}`}`);
    ws.accept();
    return new Cdp(ws);
  }

  /** Waits for the page to finish loading (at most 15 s), then a moment for scripts to draw it. */
  async #settle(cdp: Cdp, page: string, extra = 500): Promise<void> {
    const until = Date.now() + 15_000;
    await new Promise((r) => setTimeout(r, 250));
    while (Date.now() < until) {
      const r = await cdp
        .send<{ result?: { value?: string } }>("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, page, 5_000)
        .catch(() => null);
      if (r?.result?.value === "complete") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, extra));
  }

  async #read(cdp: Cdp, page: string, start = 0): Promise<BrowserPage> {
    const r = await cdp.send<{
      result?: { value?: { url: string; title: string; html: string; elements: PageElement[] } };
      exceptionDetails?: { text?: string };
    }>("Runtime.evaluate", { expression: SNAPSHOT, returnByValue: true }, page);
    const v = r.result?.value;
    if (!v) throw new Error(`Couldn't read the page: ${r.exceptionDetails?.text ?? "it gave nothing back"}.`);
    const all = readable(v.html);
    const from = Math.max(0, Math.min(start, all.length));
    return { url: v.url, title: v.title, text: all.slice(from, from + PAGE_CHARS), length: all.length, elements: v.elements };
  }
}
