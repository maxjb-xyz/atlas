// What each group on the Abilities map does, and who does it (§21.2, docs/ui §8):
// the map's eight groups, each a short list of jobs ("Your mail", "Its own
// phone number"), each job with the services or parts that fill it. Services
// the catalog has but aren't set up are there too, as ones to add. The map
// shows the jobs; zooming into a group shows the tree, and a service opens
// with its options in place.

import type { Atlas } from "../connection";
import { modelName } from "../settings/Brains";
import type { IconName, Place } from "../ui";
import { ago, clock, shortDay } from "../ui";
import { type Look, type Service, services } from "./model";

export type CardId = "brains" | "senses" | "channels" | "others" | "hands" | "services" | "skills" | "exits";

/** What opens under a hand: one of Services' own panels, a line with where it's set up, or the service's card. */
export type Panel =
  | { kind: "calendars" }
  | { kind: "phone" }
  | { kind: "chat"; ext: string }
  | { kind: "location" }
  | { kind: "email" }
  | { kind: "sender"; id: string }
  | { kind: "search"; id: string }
  | { kind: "webhooks" }
  | { kind: "note"; text: string; to?: [Place, string]; label?: string };

/** Something that does a job: a service, a brain, a part of Atlas, a device, a skill. */
export interface Hand {
  key: string;
  name: string;
  /** Its state in words. */
  by: string;
  state: Look;
  /** Set up and in use, or one the catalog has to add. */
  added: boolean;
  logo?: string;
  icon?: IconName;
  svc?: Service;
  panel?: Panel;
}

export interface Job {
  id: string;
  /** Shown on the map when what does it has no logo of its own. */
  icon?: IconName;
  name: string;
  about: string;
  hands: Hand[];
  /** Said when nothing does it yet. */
  empty: string;
  /** A way to add one that isn't a service: a face, a device, a skill. */
  add?: { label: string; to: [Place, string] };
}

export interface Card {
  id: CardId;
  icon: IconName;
  name: string;
  dev: [name: string, sub: string];
  about: string;
  jobs: Job[];
  /** Where the group is set up, for the zoomed view's link. */
  open: [Place, string, string];
}

const humanize = (name: string) => {
  const t = name.replace(/[-_]+/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : name;
};

const fromService = (x: Service, panel?: Panel): Hand => ({
  key: x.key,
  name: x.name,
  by: x.said,
  state: x.state,
  added: x.installed,
  logo: x.logo,
  svc: x,
  ...(panel ? { panel } : {}),
});

/** Set up first, then the ones to add. */
const order = (hs: Hand[]) => [...hs.filter((h) => h.added), ...hs.filter((h) => !h.added)];

/** A job's state on the map: what's set up says it; nothing set up is off. */
export function jobState(j: Job): Look {
  const on = j.hands.filter((h) => h.added);
  if (on.some((h) => h.state === "needs")) return "needs";
  if (on.some((h) => h.state === "on")) return "on";
  if (on.some((h) => h.state === "asleep")) return "asleep";
  return "off";
}

export function cards(atlas: Atlas, dev: boolean): Card[] {
  const s = atlas.state;
  const view = s.view!;
  const st = view.settings;
  const all = services(view, s.mcpServers, s.services);
  const gives = (p: string) => all.filter((x) => x.ext?.provides.includes(p));
  const builtin = (b: Service["builtin"]) => all.find((x) => x.builtin === b);

  // --- thinks with ---
  const PN = { chatgpt: "ChatGPT", "workers-ai": "Workers AI", anthropic: "Anthropic" } as const;
  const LG = { chatgpt: "openai", "workers-ai": "cloudflare", anthropic: "anthropic" } as const;
  const brainState = (p: keyof typeof PN, m?: string): Look =>
    p === "chatgpt" && view.chatgpt.state !== "signed_in" ? "needs" : m && view.health[`${p}:${m}`]?.ok === false ? "needs" : "on";
  const brainNote: Panel = {
    kind: "note",
    text: "Which brain does this, and which takes over when it's busy, is set in Atlas settings → Brains.",
    to: ["settings", "brains"],
    label: "Open Brains",
  };
  const chain = (role: "main" | "voice", list: typeof st.brains.main): Hand[] =>
    list.map((b, i) => ({
      key: `brain:${role}:${i}`,
      name: dev ? `${PN[b.provider]} · ${modelName(b)}` : PN[b.provider],
      by: i === 0 ? (b.provider === "chatgpt" ? "first, on your plan" : "first") : `when ${PN[list[i - 1]!.provider]} is busy`,
      state: brainState(b.provider, b.model),
      added: true,
      logo: LG[b.provider],
      panel: brainNote,
    }));

  // --- keeps up with ---
  const located = view.location;
  const where = (h: Hand): Hand =>
    h.added && located.set_up
      ? {
          ...h,
          by: !st.location.on
            ? "turned off"
            : located.place
              ? `${located.place.name} since ${clock(located.place.since)}`
              : located.fix
                ? `last heard ${ago(located.fix.at)}`
                : "waiting for your phone",
          state: st.location.on ? h.state : "off",
        }
      : h;
  const hooks = builtin("webhooks");

  // --- reaches you on, talks to others with ---
  const linked = (h: Hand): Hand => {
    const c = view.channels.find((x) => x.ext === h.key || x.ext === h.svc?.ext?.id);
    return h.added && c ? { ...h, by: c.linked ? "linked to you" : "not linked to you yet", state: c.linked ? h.state : "needs" } : h;
  };
  const callsOff = st.permissions.calls !== "urgent";
  const number = s.calls?.number ?? null;
  const email = builtin("email");

  // --- gets things done with ---
  const search = builtin("search");
  const nodes = view.nodes.map((n): Hand => ({
    key: `node:${n.id}`,
    name: n.name,
    by: n.online ? (dev ? (n.platform ?? n.kind) : "online") : `offline since ${shortDay(n.last_seen)}`,
    state: n.online ? "on" : "off",
    added: true,
    icon: "devices",
    panel: {
      kind: "note",
      text: "What it lets Atlas do, and what it asks first, is in Abilities → Devices.",
      to: ["abilities", "devices"],
      label: "Open Devices",
    },
  }));

  // --- works in: what isn't one of the jobs above, by what it's for ---
  const elsewhere = ["mail", "calendar", "contacts", "location", "channel", "calls", "sending", "search", "coding"];
  const rest = all.filter((x) => !x.builtin && !(x.ext?.provides ?? []).some((p) => elsewhere.includes(p)));
  const taken = new Set<string>();
  const pick = (f: (x: Service) => boolean) =>
    order(
      rest
        .filter((x) => !taken.has(x.key) && f(x))
        .map((x) => {
          taken.add(x.key);
          return fromService(x);
        }),
    );
  const code = pick((x) => !!x.ext?.provides.includes("code") || x.svc?.category === "coding");
  const tasks = pick((x) => x.svc?.category === "work" || (!x.svc && !!x.ext?.provides.includes("sense")));
  const notes = pick((x) => x.svc?.category === "notes");
  const money = pick((x) => x.svc?.category === "money");
  const maps = pick((x) => !!x.ext?.provides.some((p) => p === "maps" || p === "weather"));
  const home = pick((x) => x.svc?.category === "home");
  const other = pick(() => true);

  // --- knows how to ---
  const skills = (s.skills ?? []).filter((k) => k.state === "active").sort((a, b) => b.uses - a.uses);
  const skill = (k: (typeof skills)[number]): Hand => ({
    key: `skill:${k.name}`,
    name: dev ? k.name : humanize(k.name),
    by:
      k.checked && !k.checked.ok
        ? "its check fails"
        : k.uses
          ? `used ${k.uses} ${k.uses === 1 ? "time" : "times"}`
          : `learned ${shortDay(k.updated_at)}`,
    state: k.checked && !k.checked.ok ? "needs" : "on",
    added: true,
    icon: "skills",
    panel: {
      kind: "note",
      text: "Read it, change it or put it away in Abilities → Skills.",
      to: ["abilities", "skills"],
      label: "Open Skills",
    },
  });

  // --- keeps you safe ---
  const approvals = (s.inbox ?? []).filter((i) => i.kind === "approval");

  return [
    {
      id: "brains",
      icon: "brains",
      name: "Thinks with",
      dev: ["Brains", "thinks with"],
      about: "Who does Atlas's thinking, for each kind of work.",
      open: ["settings", "brains", "Brains"],
      jobs: [
        {
          id: "main",
          icon: "chat",
          name: "Chats and jobs",
          about: "What you ask, and what Atlas does on its own.",
          hands: chain("main", st.brains.main),
          empty: "",
        },
        {
          id: "voice",
          icon: "mic",
          name: "Thinking while it talks",
          about: "Voice, where the first word matters.",
          hands: chain("voice", st.brains.voice),
          empty: "",
        },
        {
          id: "sorting",
          icon: "layers",
          name: "Sorting and remembering",
          about: "Which area things belong to, and what they mean.",
          hands: [
            {
              key: "brain:sorting",
              name: dev ? "Workers AI · Clef" : "Workers AI",
              by: "free allowance each day",
              state: "on",
              added: true,
              logo: "cloudflare",
              panel: brainNote,
            },
          ],
          empty: "",
        },
      ],
    },
    {
      id: "senses",
      icon: "senses",
      name: "Keeps up with",
      dev: ["Senses", "hears"],
      about: "What Atlas hears about without being asked.",
      open: ["abilities", "services", "Services"],
      jobs: [
        {
          id: "mail",
          icon: "mail",
          name: "Your mail",
          about: "New mail, and replies you wait for.",
          hands: order(gives("mail").map((x) => fromService(x))),
          empty: "Nothing reads your mail yet.",
        },
        {
          id: "calendar",
          icon: "calendar",
          name: "Your calendar",
          about: "Your events as they change.",
          hands: order(gives("calendar").map((x) => fromService(x, { kind: "calendars" }))),
          empty: "No calendar yet.",
        },
        {
          id: "contacts",
          icon: "people",
          name: "Your contacts",
          about: "The people you know, kept in step.",
          hands: order(gives("contacts").map((x) => fromService(x))),
          empty: "No address book yet.",
        },
        {
          id: "location",
          icon: "place",
          name: "Where you are",
          about: "From your phone, so it knows when you arrive and leave.",
          hands: order(gives("location").map((x) => where(fromService(x, { kind: "location" })))),
          empty: "Nothing says where you are yet.",
        },
        {
          id: "work",
          icon: "plug",
          name: "What happens in your tools",
          about: "What changes there that matters to you.",
          hands: order(
            gives("sense")
              .filter((x) => !x.ext?.provides.includes("mail"))
              .map((x) => fromService(x)),
          ),
          empty: "None of your tools yet.",
        },
        ...(hooks
          ? [
              {
                id: "hooks",
                icon: "globe" as IconName,
                name: "Anything that posts to it",
                about: "Your own services and devices, by webhook.",
                hands: [fromService(hooks, { kind: "webhooks" })],
                empty: "",
              },
            ]
          : []),
      ],
    },
    {
      id: "channels",
      icon: "chat",
      name: "Reaches you on",
      dev: ["Channels", "reaches you on"],
      about: "How Atlas gets hold of you, and how you get hold of it.",
      open: ["settings", "notifications", "Notifications"],
      jobs: [
        {
          id: "app",
          icon: "devices",
          name: "This app",
          about: "Here, and notifications on your devices.",
          hands: [
            {
              key: "app",
              name: "Atlas",
              by: view.push.devices.length
                ? `notifications on ${view.push.devices.length} ${view.push.devices.length === 1 ? "device" : "devices"}`
                : "while it's open",
              state: "on",
              added: true,
              icon: "devices",
              panel: {
                kind: "note",
                text: "Which devices get notifications, what goes first, and quiet hours are in Atlas settings → Notifications.",
                to: ["settings", "notifications"],
                label: "Open Notifications",
              },
            },
          ],
          empty: "",
        },
        {
          id: "chat",
          icon: "chat",
          name: "Chats",
          about: "Message Atlas there, and it messages you back.",
          hands: order(gives("channel").map((x) => linked(fromService(x, { kind: "chat", ext: x.ext!.id })))),
          empty: "No chat apps yet.",
        },
        {
          id: "calls",
          icon: "phone",
          name: "A call, when it can't wait",
          about: "Only for what can't wait, and only once you allow it.",
          hands: order(
            gives("calls").map((x) => {
              const h = fromService(x, { kind: "phone" });
              return h.added && x.state === "on" && callsOff ? { ...h, by: "allowed in Permissions first", state: "off" as Look } : h;
            }),
          ),
          empty: "No phone service yet.",
        },
      ],
    },
    {
      id: "hands",
      icon: "terminal",
      name: "Gets things done with",
      dev: ["Hands", "works with"],
      about: "What Atlas uses to do things, rather than just say them.",
      open: ["abilities", "devices", "Devices"],
      jobs: [
        {
          id: "workspace",
          icon: "terminal",
          name: dev ? "Workspace" : "Its own computer",
          about: "Runs commands, keeps files, runs coding agents.",
          hands: [
            {
              key: "workspace",
              name: dev ? "Sandbox" : "A computer of its own",
              by: "asleep until needed",
              state: "asleep",
              added: true,
              icon: "terminal",
              panel: {
                kind: "note",
                text: "A Linux computer of Atlas's own, in a container that sleeps until a job needs it, and costs only while it's awake. It reaches only the sites you've allowed.",
              },
            },
          ],
          empty: "",
        },
        {
          id: "browser",
          icon: "browser",
          name: "A browser",
          about: "For sites with no app.",
          hands: [
            {
              key: "browser",
              name: dev ? "Browser Run" : "Cloudflare's browser",
              by: "asleep until needed",
              state: "asleep",
              added: true,
              icon: "browser",
              panel: {
                kind: "note",
                text: "A browser Atlas drives for sites with no app. It asks before filling in a form, and a vault login's first time on a site always asks.",
              },
            },
          ],
          empty: "",
        },
        {
          id: "search",
          icon: "search",
          name: "Searching the web",
          about: "One at a time does Atlas's searches.",
          hands: order([
            ...(search ? [{ ...fromService(search, { kind: "search", id: "cloudflare" }), added: true }] : []),
            ...gives("search").map((x) => fromService(x, { kind: "search", id: x.ext!.id })),
          ]).map((h) => ({
            ...h,
            state: (h.panel?.kind === "search" && st.web.search === h.panel.id ? "on" : h.added ? "off" : h.state) as Look,
            by: h.panel?.kind === "search" && st.web.search === h.panel.id ? "searches for Atlas" : h.added ? "not in use" : h.by,
          })),
          empty: "",
        },
        {
          id: "coding",
          icon: "terminal",
          name: "Coding agents",
          about: "Do coding jobs in its computer, with Atlas checking their work.",
          hands: order(gives("coding").map((x) => fromService(x))),
          empty: "No coding agent yet.",
        },
        {
          id: "devices",
          icon: "devices",
          name: "Your devices",
          about: "Your computers, for what only they can do.",
          hands: nodes,
          empty: "None paired yet.",
          add: { label: "Pair a device", to: ["abilities", "devices"] },
        },
      ],
    },
    {
      id: "services",
      icon: "plug",
      name: "Works in",
      dev: ["Services", "can do"],
      about: "Services Atlas works in for you, by what they're for.",
      open: ["abilities", "services", "Services"],
      jobs: (
        [
          { id: "code", icon: "terminal", name: "Code", about: "Repositories, pull requests and reviews.", hands: code, empty: "" },
          {
            id: "tasks",
            icon: "check",
            name: "Tasks and projects",
            about: "Issues, projects and what's assigned to you.",
            hands: tasks,
            empty: "",
          },
          { id: "notes", icon: "file", name: "Notes and docs", about: "Pages and notes you keep.", hands: notes, empty: "" },
          { id: "money", icon: "money", name: "Money", about: "Payments, invoices and customers.", hands: money, empty: "" },
          { id: "maps", icon: "place", name: "Maps and weather", about: "Routes, places and the weather.", hands: maps, empty: "" },
          { id: "home", icon: "home", name: "Your home", about: "Lights, scenes and the rest.", hands: home, empty: "" },
          {
            id: "other",
            icon: "plug",
            name: "Other tools",
            about: "Anything else, added by its address.",
            hands: other,
            empty: "Nothing else yet.",
            add: { label: "Add by address", to: ["abilities", "services"] },
          },
        ] as Job[]
      ).filter((j) => j.hands.length || j.id === "other"),
    },
    {
      id: "skills",
      icon: "skills",
      name: "Knows how to",
      dev: ["Skills", "knows how"],
      about: "What Atlas has written down about how to do things.",
      open: ["abilities", "skills", "Skills"],
      jobs: [
        {
          id: "learned",
          icon: "skills",
          name: "Learned by Atlas",
          about: "After a task that took working out, it writes down how.",
          hands: skills.filter((k) => k.made_by === "atlas").map(skill),
          empty: "None yet.",
        },
        {
          id: "yours",
          icon: "pencil",
          name: "Yours",
          about: "Ones you gave it.",
          hands: skills.filter((k) => k.made_by === "owner").map(skill),
          empty: "None yet.",
          add: { label: "Paste a SKILL.md", to: ["abilities", "skills"] },
        },
      ],
    },
    {
      id: "others",
      icon: "people",
      name: "Talks to others with",
      dev: ["Voices", "speaks to others with"],
      about: "How people who aren't you reach Atlas, and how it writes to them.",
      open: ["people", "faces", "Faces"],
      jobs: [
        {
          id: "receive",
          icon: "mail",
          name: "Mail to it",
          about: "An address of its own, on your domain, that people can write to.",
          hands: email
            ? [
                {
                  ...fromService(email, { kind: "email" }),
                  name: dev ? "Cloudflare Email Routing" : "Cloudflare",
                  by: view.mail.address ?? "no address yet",
                  state: (view.mail.address ? "on" : "off") as Look,
                  added: true,
                },
              ]
            : [],
          empty: "Only the owner can set up Atlas's address.",
        },
        {
          id: "send",
          icon: "send",
          name: "Mail from it",
          about: "What it writes, sent as itself, from its own address.",
          hands: order([
            ...(email
              ? [
                  {
                    ...fromService(email, { kind: "sender", id: "cloudflare" }),
                    key: "send:cloudflare",
                    name: dev ? "Cloudflare Email Service" : "Cloudflare",
                    added: true,
                  },
                ]
              : []),
            ...gives("sending").map((x) => fromService(x, { kind: "sender", id: x.ext!.id })),
          ]).map((h) => {
            const id = h.panel?.kind === "sender" ? h.panel.id : "";
            if (!h.added) return h;
            if (!view.mail.address) return { ...h, by: "needs Atlas's address first", state: "off" as Look };
            if (view.mail.sending !== id) return { ...h, by: "not in use", state: "off" as Look };
            return view.mail.sending_ok
              ? { ...h, by: `sends as ${view.mail.address}`, state: "on" as Look }
              : { ...h, by: "can't send yet", state: "needs" as Look };
          }),
          empty: "",
        },
        {
          id: "number",
          icon: "phone",
          name: "Its own phone number",
          about: "You call it, and it calls you.",
          hands: order(
            gives("calls").map((x) => {
              const h = fromService(x, { kind: "phone" });
              return h.added && x.state === "on" ? { ...h, by: number ?? "no number yet", state: (number ? "on" : "needs") as Look } : h;
            }),
          ),
          empty: "No phone service yet.",
        },
        {
          id: "faces",
          icon: "people",
          name: "Faces",
          about: "Atlas, for people who aren't you. Every face says it's an AI.",
          hands: view.faces.map((f) => ({
            key: `face:${f.id}`,
            name: f.name,
            by: f.on ? (f.addresses.length ? `on ${f.addresses.join(", ")}` : "on") : "off",
            state: (f.on ? "on" : "off") as Look,
            added: true,
            icon: "people" as IconName,
            panel: {
              kind: "note" as const,
              text: "Who it answers, what it shares and when it pulls you in are on its page in People → Faces.",
              to: ["people", "faces"] as [Place, string],
              label: "Open Faces",
            },
          })),
          empty: "No faces yet: Atlas tells people whose assistant it is, and nothing more.",
          add: { label: "New face", to: ["people", "faces"] },
        },
      ],
    },
    {
      id: "exits",
      icon: "shield",
      name: "Keeps you safe",
      dev: ["Exits", "checks on the way out"],
      about: "What it checks before anything leaves.",
      open: ["settings", "permissions", "Permissions"],
      jobs: [
        {
          id: "asks",
          icon: "inbox",
          name: "Asks before it acts",
          about: "Anything that reaches outside, until you trust it.",
          hands: [
            {
              key: "approvals",
              name: approvals.length ? `${approvals.length} to approve` : "Nothing to approve",
              by: approvals.length ? approvals[0]!.title : "it asks first",
              state: approvals.length ? "needs" : "on",
              added: true,
              icon: "inbox",
              panel: { kind: "note", text: "What's waiting for your OK is in Inbox.", to: ["inbox", ""], label: "Open Inbox" },
            },
          ],
          empty: "",
        },
        {
          id: "vault",
          icon: "key",
          name: "Passwords and cards",
          about: "Filled in at the last step; Atlas never sees them.",
          hands: [
            {
              key: "vault",
              name: `${view.vault.length} kept safe`,
              by: "locked away",
              state: "on",
              added: true,
              icon: "key",
              panel: {
                kind: "note",
                text: "Passwords and cards are in Atlas settings → Account.",
                to: ["settings", "account"],
                label: "Open Account",
              },
            },
          ],
          empty: "",
        },
        {
          id: "rules",
          icon: "shield",
          name: "Your rules",
          about: "When it asks, in code, not its judgment.",
          hands: [
            {
              key: "rules",
              name: dev ? "Permissions" : "Asks first",
              by: `${view.permissions.trusted.length} trusted`,
              state: "on",
              added: true,
              icon: "shield",
              panel: {
                kind: "note",
                text: "Each rule, and what you've come to trust, is in Atlas settings → Permissions.",
                to: ["settings", "permissions"],
                label: "Open Permissions",
              },
            },
          ],
          empty: "",
        },
      ],
    },
  ];
}
