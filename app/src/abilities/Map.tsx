// Abilities → Map (§21.2, docs/ui §8): everything Atlas can do, live, built
// from what's installed and its state. Atlas in the middle, eight groups
// wired to it, each item with what fills it, its state and its cost; a group
// opens where it's set up. Simple says it in plain words; Developer names
// models and ids.

import type { ReactNode } from "react";
import type { Atlas } from "../connection";
import { modelName } from "../settings/Brains";
import { useDetail } from "../theme";
import { ago, clock, Diamond, Icon, type IconName, logoFor, LogoMark, type Place, shortDay, StateDot } from "../ui";
import { type Look, services } from "./model";

interface Item {
  name: string;
  by: string;
  /** The meter or note at the right: a cost, a time, a count. */
  m?: string;
  state: Look;
  logo?: string;
  icon?: IconName;
  swatch?: string;
}

interface Group {
  id: string;
  icon: IconName;
  simple: string;
  dev: [name: string, sub: string];
  items: Item[];
  open: [Place, string];
}

const humanize = (name: string) => {
  const t = name.replace(/[-_]+/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : name;
};

function groups(atlas: Atlas, dev: boolean): Group[] {
  const s = atlas.state;
  const view = s.view!;
  const st = view.settings;
  const svcs = services(view, s.mcpServers, s.services);

  // Brains: each provider in the chains, with what it's used for.
  const main = st.brains.main;
  const voice = st.brains.voice;
  const PN = { chatgpt: "ChatGPT", "workers-ai": "Workers AI", anthropic: "Anthropic" } as const;
  const LG = { chatgpt: "openai", "workers-ai": "cloudflare", anthropic: "anthropic" } as const;
  const health = (p: string, m: string) => view.health[`${p}:${m}`];
  const brainState = (p: keyof typeof PN, m?: string): Look =>
    p === "chatgpt" && view.chatgpt.state !== "signed_in" ? "off" : m && health(p, m)?.ok === false ? "needs" : "on";
  const brains: Item[] = dev
    ? [
        ...main.slice(0, 2).map((b, i) => ({
          name: i === 0 ? "Main" : "Fallback",
          by: `${PN[b.provider]} · ${modelName(b)}`,
          m: b.provider === "chatgpt" ? "plan" : b.provider === "anthropic" ? "key" : "free",
          state: brainState(b.provider, b.model),
          logo: LG[b.provider],
        })),
        {
          name: "Voice",
          by: `${PN[voice[0]!.provider]} · ${modelName(voice[0]!)}`,
          m: voice[0]!.provider === "chatgpt" ? "plan" : voice[0]!.provider === "anthropic" ? "key" : "free",
          state: brainState(voice[0]!.provider, voice[0]!.model),
          logo: LG[voice[0]!.provider],
        },
        { name: "Sorting", by: "Workers AI · Clef", m: "free", state: "on", logo: "cloudflare" },
      ]
    : (["chatgpt", "workers-ai"] as const)
        .filter((p) => main.some((b) => b.provider === p) || voice.some((b) => b.provider === p))
        .map((p) => {
          const uses = [
            ...(main[0]!.provider === p
              ? ["most things"]
              : main.some((b) => b.provider === p)
                ? [`when ${PN[main[0]!.provider]} is busy`]
                : []),
            ...(voice[0]!.provider === p ? ["voice"] : []),
          ];
          return {
            name: PN[p],
            by: `${uses.join(", ")}${p === "chatgpt" ? ", on your plan" : ""}`,
            state: brainState(p, main.find((b) => b.provider === p)?.model),
            logo: LG[p],
          };
        });

  // Senses: mail, the calendar, where you are, and your work.
  const on = view.extensions.filter((e) => e.state === "on");
  const when = (e: (typeof on)[number]) => ((e.ok_at ?? e.last_look) ? ago((e.ok_at ?? e.last_look)!) : "on");
  const senses: Item[] = [];
  for (const e of on.filter((e) => e.provides.includes("mail")))
    senses.push({
      name: dev ? "Mail" : "Your mail",
      by: dev ? e.name : when(e),
      m: dev ? when(e) : undefined,
      state: e.error ? "needs" : "on",
      logo: e.id,
    });
  const cal = view.calendar.provider;
  if (cal)
    senses.push({
      name: dev ? "Calendar" : "Your calendar",
      by: dev ? cal.name : view.calendar.refused ? "refused the sign-in" : "on",
      state: view.calendar.refused ? "needs" : "on",
      logo: cal.id,
    });
  const loc = view.location;
  if (loc.set_up)
    senses.push({
      name: dev ? "Location" : "Where you are",
      by: !st.location.on
        ? "turned off"
        : loc.place
          ? `${loc.place.name} since ${clock(loc.place.since)}`
          : loc.fix
            ? ago(loc.fix.at)
            : "waiting for your phone",
      state: st.location.on ? "on" : "off",
      logo: "owntracks",
    });
  const work = on.filter((e) => e.provides.includes("sense") && !e.provides.includes("mail"));
  if (work.length)
    senses.push({
      name: dev ? "Work" : "Your work",
      by: work.map((e) => e.name).join(dev ? ", " : " and "),
      state: work.some((e) => e.error) ? "needs" : "on",
      logo: work[0]!.id,
    });

  // Channels: the app, chats you've linked, Atlas's email.
  const channels: Item[] = [
    {
      name: dev ? "App" : "This app",
      by: view.push.devices.length
        ? `notifications on ${view.push.devices.length} ${view.push.devices.length === 1 ? "device" : "devices"}`
        : "while it's open",
      state: "on",
      icon: "devices",
    },
    ...view.channels.map((c) => ({
      name: c.name,
      by: c.linked ? (dev ? c.linked.name : "linked to you") : "not linked to you yet",
      state: (c.linked ? "on" : "needs") as Look,
      logo: c.ext,
    })),
    ...(view.mail.address
      ? [
          {
            name: dev ? "Email" : "Its own email",
            by: view.mail.address,
            state: (view.mail.sending_ok ? "on" : "needs") as Look,
            icon: "mail" as IconName,
          },
        ]
      : []),
  ];

  // Hands: its own computer, a browser, the web.
  const search =
    st.web.search === "cloudflare" ? "Cloudflare" : (view.extensions.find((e) => e.id === st.web.search)?.name ?? st.web.search);
  const hands: Item[] = [
    { name: dev ? "Workspace" : "Its own computer", by: "asleep until needed", state: "asleep", icon: "terminal" },
    { name: dev ? "Browser" : "A browser", by: dev ? "Browser Run" : "for sites with no app", state: "asleep", icon: "browser" },
    { name: dev ? "Web search" : "The web", by: search, state: "on", icon: "globe" },
  ];

  // Services that act: installed extensions and MCP servers.
  const works: Item[] = svcs
    .filter(
      (x) =>
        x.installed &&
        !x.builtin &&
        (x.mcp || x.ext?.provides.some((p) => ["code", "coding", "search", "maps", "weather", "sending"].includes(p))),
    )
    .map((x) => ({ name: x.name, by: dev ? x.about.toLowerCase() : x.said.toLowerCase(), state: x.state, logo: x.logo }));

  // Skills: the ones used most.
  const skills: Item[] = [...(s.skills ?? [])]
    .filter((k) => k.state === "active")
    .sort((a, b) => b.uses - a.uses)
    .map((k) => ({
      name: dev ? k.name : humanize(k.name),
      by:
        k.checked && !k.checked.ok
          ? "its check fails"
          : k.uses
            ? `used ${k.uses} ${k.uses === 1 ? "time" : "times"}`
            : `learned ${shortDay(k.updated_at)}`,
      state: (k.checked && !k.checked.ok ? "needs" : "on") as Look,
      icon: "skills" as IconName,
    }));

  // Devices: paired ones, and the phone that says where you are.
  const devices: Item[] = view.nodes.map((n) => ({
    name: n.name,
    by: n.online ? (dev ? (n.platform ?? n.kind) : "online") : `offline since ${shortDay(n.last_seen)}`,
    state: n.online ? "on" : "off",
    logo: /mac|ios|iphone|darwin/i.test(n.platform ?? n.kind)
      ? "apple"
      : n.kind === "home" || /raspberry|pi\b/i.test(n.platform ?? "")
        ? "raspberrypi"
        : undefined,
    icon: "devices",
  }));
  if (loc.set_up)
    devices.push({
      name: "Your phone",
      by: dev ? "OwnTracks" : "says where you are",
      state: st.location.on ? "on" : "off",
      logo: "owntracks",
    });

  // Exits: what it checks on the way out.
  const approvals = (s.inbox ?? []).filter((i) => i.kind === "approval");
  const exits: Item[] = [
    approvals.length
      ? {
          name: dev ? "Approvals" : `${approvals.length} to approve`,
          by: dev ? `${approvals.length} waiting on you` : approvals[0]!.title,
          state: "needs",
          icon: "inbox",
        }
      : { name: dev ? "Approvals" : "Nothing to approve", by: "it asks first", state: "on", icon: "inbox" },
    {
      name: dev ? "Vault" : `${view.vault.length} passwords`,
      by: dev ? `${view.vault.length} logins and cards` : "locked away",
      state: "on",
      icon: "key",
    },
    {
      name: dev ? "Permissions" : "Asks first",
      by: dev ? `${view.permissions.trusted.length} trusted` : "before it speaks for you",
      state: "on",
      icon: "shield",
    },
    // TODO(core, stage 4): spending this month against the cap, once the router reports it.
  ];

  return [
    { id: "brains", icon: "brains", simple: "Thinks with", dev: ["Brains", "thinks with"], items: brains, open: ["settings", "brains"] },
    { id: "senses", icon: "senses", simple: "Keeps up with", dev: ["Senses", "hears"], items: senses, open: ["abilities", "services"] },
    {
      id: "channels",
      icon: "chat",
      simple: "Reaches you on",
      dev: ["Channels", "reaches you on"],
      items: channels,
      open: ["settings", "notifications"],
    },
    {
      id: "hands",
      icon: "terminal",
      simple: "Gets things done with",
      dev: ["Hands", "works with"],
      items: hands,
      open: ["abilities", "services"],
    },
    { id: "services", icon: "plug", simple: "Works in", dev: ["Services", "can do"], items: works, open: ["abilities", "services"] },
    { id: "skills", icon: "skills", simple: "Knows how to", dev: ["Skills", "knows how"], items: skills, open: ["abilities", "skills"] },
    { id: "devices", icon: "devices", simple: "Lives on", dev: ["Devices", "is on"], items: devices, open: ["abilities", "devices"] },
    {
      id: "exits",
      icon: "shield",
      simple: "Keeps you safe",
      dev: ["Exits", "checks on the way out"],
      items: exits,
      open: ["settings", "permissions"],
    },
  ];
}

const EMPTY: Record<string, string> = {
  senses: "Nothing yet. Add your mail or calendar in Services.",
  channels: "Just this app.",
  services: "Nothing installed yet.",
  skills: "None yet. Atlas writes one down after a task that took working out.",
  devices: "None paired yet.",
};

export function AbilitiesMap({ atlas, go }: { atlas: Atlas; go: (p: Place, d?: string) => void }) {
  const { at } = useDetail();
  const dev = at("developer");
  const s = atlas.state;
  const gs = groups(atlas, dev);
  const all = gs.flatMap((g) => g.items);
  const onCount = all.filter((i) => i.state === "on").length;
  const needs = all.filter((i) => i.state === "needs").length;
  const running = s.jobs.filter((j) => j.state === "running").length;
  const next = s.agenda.filter((a) => a.state === "scheduled" && a.due_at > Date.now()).sort((a, b) => a.due_at - b.due_at)[0];
  const box = (g: Group) => (
    <button key={g.id} className={`card2 map-box ${g.id}`} onClick={() => go(...g.open)}>
      <span className="row" style={{ flexWrap: "nowrap", gap: 8, width: "100%" }}>
        <Icon name={g.icon} size={14} style={{ color: "var(--tx2)" }} />
        <span style={{ fontWeight: 600 }}>{dev ? g.dev[0] : g.simple}</span>
        {dev && <span className="aside">{g.dev[1]}</span>}
        <span className="grow" />
        {dev && <span className="mono aside">{g.items.length}</span>}
      </span>
      <span className={`map-items ${dev ? "dev" : ""}`}>
        {g.items.slice(0, 4).map((x, i) => (
          <span className="map-item" key={i}>
            {x.logo && logoFor(x.logo) ? (
              <LogoMark of={x.logo} size={15} />
            ) : (
              <Icon name={x.icon ?? "plug"} size={15} style={{ color: "var(--tx2)" }} />
            )}
            <span className="nm">{x.name}</span>
            <span className="by clip">{x.by}</span>
            {x.m && <span className={`m ${dev ? "mono" : ""} ${x.state === "needs" ? "ac" : ""}`}>{x.m}</span>}
            <StateDot state={x.state} />
          </span>
        ))}
        {!g.items.length && <span className="aside map-item">{EMPTY[g.id] ?? "Nothing yet."}</span>}
      </span>
    </button>
  );
  const core: ReactNode = (
    <div className="map-core">
      <span className="node" aria-hidden style={{ left: 0, top: 0 }} />
      <span className="node" aria-hidden style={{ left: "100%", top: 0 }} />
      <span className="node" aria-hidden style={{ left: 0, top: "100%" }} />
      <span className="node" aria-hidden style={{ left: "100%", top: "100%" }} />
      <Diamond size={34} />
      <span className="disp" style={{ fontSize: 20 }}>
        {s.view?.settings.assistant_name ?? "Atlas"}
      </span>
      <span className="small muted">
        {running ? `Working on ${running} ${running === 1 ? "job" : "jobs"}` : "Nothing running"}
        {next ? ` · next look at ${clock(next.due_at)}` : ""}
      </span>
      {dev ? (
        <span className="mono aside">{__ATLAS_VERSION__}</span>
      ) : needs ? (
        <span className="small ac">
          {needs} {needs === 1 ? "thing needs" : "things need"} you
        </span>
      ) : (
        <span className="small ok">✓ All good today</span>
      )}
    </div>
  );
  return (
    <div className="sheet-in">
      <div className="map-title">
        <span className="disp">Everything Atlas can do</span>
        <span className="muted">
          {onCount} on · {needs} {needs === 1 ? "needs" : "need"} you
        </span>
        <span className="grow" />
        <span className="legend">
          <span>
            <StateDot state="on" />
            On
          </span>
          <span>
            <StateDot state="asleep" />
            Asleep
          </span>
          <span>
            <StateDot state="needs" />
            Needs you
          </span>
          <span>
            <StateDot state="off" />
            Off
          </span>
        </span>
      </div>
      <div className="map-board">
        {box(gs[0]!)}
        {box(gs[1]!)}
        {box(gs[2]!)}
        {box(gs[3]!)}
        {core}
        {box(gs[4]!)}
        {box(gs[5]!)}
        {box(gs[6]!)}
        {box(gs[7]!)}
        <span className="bus l" aria-hidden />
        <span className="bus r" aria-hidden />
      </div>
    </div>
  );
}
