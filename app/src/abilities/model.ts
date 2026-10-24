// What Abilities shows, built from what's installed and its state (§17, docs/ui §8):
// one service per extension, MCP server and built-in, whatever is underneath.

import type { ExtensionView, McpServerView, ServiceView, SettingsView } from "../../../core/src/protocol";
import { ago } from "../ui";

export type Look = "on" | "asleep" | "needs" | "off";

export interface Service {
  key: string;
  name: string;
  /** What it is, in a few words: "Your mail", "Chat with Atlas". */
  about: string;
  /** What Atlas does with it, in a sentence. */
  does: string;
  state: Look;
  /** Its state in words: "Worked 4 min ago", "Waiting for you to sign in". */
  said: string;
  cost: string;
  /** The logo to wear, by extension id or name. */
  logo: string;
  installed: boolean;
  /** Which filter chips it falls under. */
  groups: string[];
  ext?: ExtensionView;
  mcp?: McpServerView;
  /** The catalog's card, when the catalog has come: its parts, its one setup, its error. */
  svc?: ServiceView;
  /** Its own logo from the catalog, as a data URI, when the app has none of its own. */
  icon?: string | null;
  builtin?: "email" | "search" | "webhooks";
}

/** What each thing an extension gives is, in plain words. */
export const GIVES: Record<string, { about: string; hears?: string; does?: string; group: string }> = {
  mail: { about: "Your mail", hears: "New mail, and replies you wait for", does: "Sends mail as you, after you say yes", group: "mail" },
  sense: { about: "What happens there", hears: "What changes there that matters to you", group: "work" },
  calendar: { about: "Your calendar", hears: "Your events as they change", does: "Reads, adds and moves events", group: "mail" },
  contacts: { about: "Your contacts", does: "Brings in the people you know", group: "mail" },
  channel: { about: "Chat with Atlas", hears: "Messages to Atlas", does: "Messages you, and people who reach a face", group: "chat" },
  sending: { about: "Sends Atlas's mail", does: "Sends mail from Atlas's own address", group: "mail" },
  location: { about: "Where you are", hears: "Where you are, from your phone", group: "maps" },
  maps: { about: "Maps and routes", does: "Works out routes, travel times and places", group: "maps" },
  weather: { about: "The weather", does: "Looks up the weather near you", group: "maps" },
  search: { about: "Web search", does: "Searches the web", group: "work" },
  coding: { about: "Coding jobs", does: "Runs a coding agent for coding jobs", group: "coding" },
  code: { about: "Code and reviews", does: "Opens pull requests for coding jobs", group: "coding" },
};

export const CHIPS: Array<[id: string, name: string]> = [
  ["all", "All"],
  ["on", "On"],
  ["mail", "Mail and calendar"],
  ["chat", "Chat and calls"],
  ["work", "Work"],
  ["coding", "Coding"],
  ["maps", "Maps and weather"],
];

/** An extension's state in words, and as a dot. */
export function extState(e: ExtensionView): { state: Look; said: string } {
  if (e.state === "available") return { state: "off", said: "Not set up" };
  if (e.state === "draft") return { state: "needs", said: "Written by Atlas, waiting for you to read it" };
  if (e.state === "off") return { state: "off", said: "Turned off" };
  if (e.error && (!e.ok_at || (e.error_at ?? 0) >= e.ok_at)) return { state: "needs", said: "Failing, see why" };
  const needs = e.secrets.filter((x) => !x.optional && !x.set).length + (e.signin && !e.signin.signed_in ? 1 : 0);
  if (needs) return { state: "needs", said: e.signin && !e.signin.signed_in ? "Waiting for you to sign in" : "Needs its key" };
  if (e.ok_at) return { state: "on", said: `Worked ${ago(e.ok_at)}` };
  if (e.last_look) return { state: "on", said: `Looked ${ago(e.last_look)}` };
  return { state: "on", said: "On" };
}

export function mcpState(m: McpServerView): { state: Look; said: string } {
  if (m.state === "ready") return { state: "on", said: `${m.tools.length} ${m.tools.length === 1 ? "tool" : "tools"} ready` };
  if (m.state === "authenticating") return { state: "needs", said: "Waiting for you to sign in" };
  if (m.state === "failed") return { state: "needs", said: "Failing, see why" };
  return { state: "asleep", said: "Connecting" };
}

/** Which filter chip each catalog category falls under. */
const GROUP: Record<string, string> = {
  mail: "mail",
  calendar: "mail",
  chat: "chat",
  work: "work",
  notes: "work",
  money: "work",
  search: "work",
  home: "work",
  custom: "work",
  coding: "coding",
  maps: "maps",
  weather: "maps",
  location: "maps",
};

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** A catalog card's state in words: what's wrong says why, in the service's own words, not just that something is. */
function svcState(v: ServiceView, ext?: ExtensionView): { state: Look; said: string } {
  if (v.state === "error" && v.error) return { state: "needs", said: `Failing: ${clip(v.error.text, 90)}` };
  if (v.state === "error") return { state: "needs", said: "Failing, and it didn't say why" };
  // Its extension works with its key, and only its tools wait to be connected with it.
  if (v.state === "setup" && v.setup.kind === "key" && ext?.secrets.some((x) => x.set) && v.parts.mcp)
    return { state: "needs", said: "Works; its tools aren't connected" };
  if (v.state === "setup")
    return {
      state: "needs",
      said: v.setup.kind === "key" ? "Needs its key" : "Waiting for you to sign in",
    };
  if (v.state === "draft") return { state: "needs", said: "Waiting for you to read it" };
  if (v.state === "off") return { state: "off", said: "Turned off" };
  if (v.state === "available") return { state: "off", said: "Not set up" };
  if (ext) return extState(ext);
  if (v.last_heard) return { state: "on", said: `Worked ${ago(v.last_heard)}` };
  return { state: "on", said: "On" };
}

export function services(view: SettingsView, mcp: McpServerView[] | null, catalog?: ServiceView[] | null): Service[] {
  const out: Service[] = [];
  if (catalog) {
    for (const v of catalog) {
      const ext = v.parts.extension ? view.extensions.find((e) => e.id === v.parts.extension!.id) : undefined;
      const server = v.parts.mcp?.id ? (mcp ?? []).find((m) => m.id === v.parts.mcp!.id) : undefined;
      const gives = (ext?.provides ?? []).map((p) => GIVES[p]).filter((g) => g != null);
      out.push({
        key: v.id,
        name: v.name,
        about: gives.length
          ? gives
              .slice(0, 2)
              .map((g, i) => (i ? g.about[0]!.toLowerCase() + g.about.slice(1) : g.about))
              .join(" and ")
          : clip(v.hears.summary ?? v.does.summary ?? "", 40) || "A service",
        does: v.about,
        ...svcState(v, ext),
        cost: v.cost ? "costs" : "free",
        logo: v.parts.extension?.id ?? v.id,
        icon: v.icon,
        installed: v.state !== "available",
        groups: [GROUP[v.category] ?? "work"],
        ...(ext ? { ext } : {}),
        ...(server ? { mcp: server } : {}),
        svc: v,
      });
    }
  }
  for (const e of catalog ? [] : view.extensions) {
    const gives = e.provides.map((p) => GIVES[p]).filter((g) => g != null);
    const s = extState(e);
    out.push({
      key: `ext:${e.id}`,
      name: e.name,
      about: gives.length
        ? gives
            .slice(0, 2)
            .map((g, i) => (i ? g.about[0]!.toLowerCase() + g.about.slice(1) : g.about))
            .join(" and ")
        : "A service",
      does: e.about,
      ...s,
      cost: e.costs ? "costs" : "free",
      // TODO(stage 5): the extension's own icon, once its manifest carries one; until then the logo by its id.
      logo: e.id,
      installed: e.state !== "available",
      groups: [...new Set(gives.map((g) => g.group))],
      ext: e,
    });
  }
  for (const m of catalog ? [] : (mcp ?? [])) {
    out.push({
      key: `mcp:${m.id}`,
      name: m.name,
      about: "Its own tools, over MCP",
      does: m.tools.length
        ? m.tools
            .map((t) => t.title ?? t.name)
            .slice(0, 3)
            .join(", ")
        : "Its tools show once it connects",
      ...mcpState(m),
      cost: "free",
      logo: m.name,
      installed: true,
      groups: ["work"],
      mcp: m,
    });
  }
  if (!view.me) {
    const m = view.mail;
    out.push({
      key: "builtin:email",
      name: "Atlas's email",
      about: "An address of its own",
      does: m.address ? `Sends and receives as ${m.address}` : "Mail Atlas sends and receives as itself, on your domain",
      state: m.address ? (m.sending_ok ? "on" : "needs") : "off",
      said: m.address ? (m.sending_ok ? m.address : "Can't send yet") : "Not set up",
      cost: "free",
      logo: "cloudflare",
      installed: !!m.address,
      groups: ["mail", "chat"],
      builtin: "email",
    });
  }
  const cfSearch = view.settings.web.search === "cloudflare";
  out.push({
    key: "builtin:search",
    name: "Cloudflare search",
    about: "Web search, built in",
    does: "Searches the web through AI Gateway",
    state: cfSearch ? "on" : "off",
    said: cfSearch ? "Searches for Atlas" : "Not in use",
    cost: "$0.25/1k",
    logo: "cloudflare",
    installed: cfSearch,
    groups: ["work"],
    builtin: "search",
  });
  const hooks = view.webhooks.length + view.senses.hooks.length;
  out.push({
    key: "builtin:webhooks",
    name: "Webhooks",
    about: "Anything with a web address",
    does: "Lights, scenes and your own services: Atlas calls them, and they can post to it",
    state: hooks ? "on" : "off",
    said: hooks ? `${hooks} set up` : "None yet",
    cost: "free",
    logo: "webhooks",
    installed: hooks > 0,
    groups: ["work"],
    builtin: "webhooks",
  });
  return out;
}
