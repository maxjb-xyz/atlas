// The shell (§21.1): the sidebar of Today, what needs you, threads at work,
// spaces and recent threads, with Calendar, Library and Settings at its foot
// (§21.2), and the message box. Today and every thread are conversations;
// every other page has the message box at its foot. No toolbar, no side panes.

import { stillMotion, useDetail } from "./theme";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AreaView, InboxItem, LogRow, SearchHit, ThreadView } from "../../core/src/protocol";
import type { Atlas } from "./connection";
import { jobNow, liveJobs } from "./jobs";
import { topJobs } from "./JobViews";
import { Markdown } from "./Markdown";
import { openOnStage, type Shown, shownFrom, StageCard } from "./StageViews";
import {
  AREA_ICON_PATHS,
  AreaChip,
  areaColor,
  Avatar,
  AsciiDiamond,
  Diamond,
  hostOf,
  Icon,
  LiveMark,
  type IconName,
  initials,
  type Place,
  shortDay,
  SiteMark,
  stepIcon,
  undoneIds,
  useNow,
} from "./ui";

/**
 * The places at the sidebar's foot (§21.2): Calendar, Library and Settings. The rest live inside them: People in
 * Library; Routines, Connections and Activity in Settings. Their old links still open them.
 */
export const PLACES: Array<{ id: Place; label: string; icon: IconName; also?: Place[] }> = [
  { id: "agenda", label: "Calendar", icon: "agenda" },
  { id: "library", label: "Library", icon: "library", also: ["people"] },
  { id: "settings", label: "Settings", icon: "settings", also: ["automations", "abilities", "history", "pair"] },
];

/** Every place ⌘K can go to, by the names people know them by. */
const GO_TO: Array<{ id: Place; label: string; icon: IconName }> = [
  { id: "home", label: "Today", icon: "chat" },
  { id: "agenda", label: "Calendar", icon: "agenda" },
  { id: "library", label: "Library", icon: "library" },
  { id: "people", label: "People", icon: "people" },
  { id: "automations", label: "Routines", icon: "automations" },
  { id: "abilities", label: "Connections", icon: "abilities" },
  { id: "history", label: "Activity", icon: "history" },
  { id: "inbox", label: "Needs you", icon: "inbox" },
  { id: "settings", label: "Settings", icon: "settings" },
];

/** How long ago, in a word: "now", "4m", "2h", "Tue". */
export function ago(at: number, now = Date.now()): string {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return new Date(at).toLocaleDateString([], { weekday: "short" });
}

/** A space's mark (§21.3): a rounded square in its color, with its icon or its first letter. */
export function SpaceMark({ area, size = 18 }: { area?: AreaView; size?: number }) {
  if (!area) return <span className="space-mark none" style={{ width: size, height: size }} aria-hidden />;
  const icon = area.icon;
  return (
    <span
      className="space-mark"
      aria-hidden
      style={{ width: size, height: size, "--c": areaColor(area), fontSize: Math.round(size * 0.55) } as React.CSSProperties}
    >
      {icon?.startsWith("file:") ? (
        <img src={`/api/files/${icon.slice(5)}?inline=1`} alt="" />
      ) : icon && AREA_ICON_PATHS[icon] ? (
        <svg className="ic" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} viewBox="0 0 24 24">
          <path d={AREA_ICON_PATHS[icon]} />
        </svg>
      ) : (
        (area.name.trim()[0] ?? "·").toUpperCase()
      )}
    </span>
  );
}

/**
 * Rows that slide to where they now are when the list changes (§21.8): a thread moving from Working to Recent, a new
 * one arriving at the top. Positions are read relative to the list, so scrolling it doesn't move anything.
 */
function useFlip(ref: React.RefObject<HTMLElement | null>) {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const still = stillMotion();
    const next = new Map<string, number>();
    for (const el of box.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = el.dataset.flip!;
      const top = el.offsetTop;
      next.set(key, top);
      if (still || last.current.size === 0) continue;
      const was = last.current.get(key);
      if (was === undefined) {
        el.animate(
          [
            { opacity: 0, transform: "translateX(-8px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 420, easing: SPRING },
        );
      } else if (Math.abs(was - top) > 1) {
        el.animate([{ transform: `translateY(${was - top}px)` }, { transform: "none" }], { duration: 520, easing: SPRING });
      }
    }
    last.current = next;
  });
}

/** The app's one spring (§21.8): what moves settles with a little overshoot. */
export const SPRING = "cubic-bezier(0.34, 1.32, 0.64, 1)";

/** What needs the owner, as the sidebar and Tab show it: decisions first, then the rest, newest last. */
export function needsYou(atlas: Atlas): InboxItem[] {
  const all = (atlas.state.inbox ?? []).filter((i) => !atlas.state.answered[i.id]);
  const deciding = all.filter((i) => i.kind === "approval" || i.kind === "question" || i.job);
  return [...deciding, ...all.filter((i) => !deciding.includes(i))];
}

/** Where a thing that needs the owner was asked (§21.2): its job, its thread, or Today; else the list. */
export function needHref(atlas: Atlas, i: InboxItem): string {
  if (i.job) return `#/home/${encodeURIComponent(`job:${i.job.id}`)}`;
  const t = i.thread ?? (i.run_id ? atlas.state.runThread[i.run_id] : undefined);
  if (t) return `#/thread/${encodeURIComponent(t)}`;
  if (i.kind === "approval" && i.run_id && atlas.state.rows.some((r) => r.run_id === i.run_id))
    return `#/home/${encodeURIComponent(`at:${i.id}`)}`;
  return "#/inbox";
}

const NEED_ACT: Record<InboxItem["kind"], string> = {
  approval: "Your OK",
  question: "Answer",
  face: "Answer",
  review: "Review",
  failed: "Look",
  service: "Fix",
};

/**
 * The sidebar (§21.1): Today, what needs you, what Atlas is working on, the spaces, and recent threads, so all the
 * work can be seen at once; Calendar, Library and Settings at its foot.
 */
export function Sidebar({
  atlas,
  place,
  detail,
  onSearch,
  onNew,
}: {
  atlas: Atlas;
  place: Place;
  detail: string;
  onSearch: () => void;
  onNew: () => void;
}) {
  const s = atlas.state;
  const settings = s.view?.settings;
  const owner = settings?.owner_name || "You";
  const now = useNow(30_000);
  const [older, setOlder] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useFlip(list);

  const here = place === "thread" ? detail.split("|")[0] : null;
  const job = place === "home" && detail.startsWith("job:") ? detail.slice(4) : null;
  const space = place === "space" ? detail : null;
  const needs = needsYou(atlas);
  const jobs = topJobs(s.jobs);
  const working = [
    ...liveJobs(jobs, now).map((j) => ({ kind: "job" as const, j, at: j.moved_at ?? j.started_at })),
    ...s.threads.filter((t) => t.state === "working").map((t) => ({ kind: "thread" as const, t, at: t.last_at })),
  ].sort((a, b) => b.at - a.at);
  const recentThreads = s.threads
    .filter((t) => t.state !== "working" && (older || t.state !== "quiet" || t.pinned))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.last_at - a.last_at);
  // Jobs that aren't at work and aren't waiting on an answer are recent threads too, for three days.
  const asking = new Set(needs.map((i) => i.job?.id).filter(Boolean));
  const recentJobs = jobs.filter((j) => !jobNow(j, now).live && !asking.has(j.id) && now - (j.moved_at ?? j.started_at) < 3 * 86_400_000);
  const quiet = s.threads.filter((t) => t.state === "quiet" && !t.pinned).length;
  const spaces = s.areas
    .filter((a) => a.state !== "archived")
    .sort((a, b) => Number(a.state === "dormant") - Number(b.state === "dormant"));
  const lastToday = [...s.rows].reverse().find((r) => r.kind === "message.in" || r.kind === "message.out");
  const name = settings?.assistant_name ?? "Atlas";
  const area = (ids?: string[]) => s.areas.find((a) => ids?.includes(a.id));

  return (
    <nav className="side" aria-label="Sidebar">
      <div className="brand">
        <Diamond size={17} />
        <span className="disp">{name}</span>
        <span className="grow" />
        <button className="icon side-new" onClick={onNew} aria-label="New thread" title="New thread  ⌘N">
          <Icon name="pencil" size={14} />
        </button>
      </div>
      <button className="side-search" onClick={onSearch}>
        <Icon name="search" size={14} />
        <span className="grow">Search</span>
        <span className="kbd-soft">⌘K</span>
      </button>
      <div className="side-list" ref={list}>
        <a
          href="#/home"
          data-nav
          data-flip="today"
          className={`srow today ${place === "home" && !job ? "on" : ""}`}
          aria-current={place === "home" && !job ? "page" : undefined}
        >
          <span className="lead">
            <LiveMark
              size={15}
              state={Object.values(s.live).some((l) => !l.job && !l.thread && l.surface !== "voice") ? "thinking" : "still"}
            />
          </span>
          <span className="t">
            <span className="t1">Today</span>
            {lastToday && <span className="t2 clip">{str(lastToday.body.text).slice(0, 80)}</span>}
          </span>
          {lastToday && <span className="meta">{ago(lastToday.at, now)}</span>}
        </a>

        {needs.length > 0 && (
          <>
            <div className="sgroup need" data-flip="g:needs">
              <span className="sq-ac" aria-hidden />
              Needs you
              <span className="grow" />
              <span className="n">{needs.length}</span>
            </div>
            {needs.map((i) => (
              <a key={`need:${i.id}`} href={needHref(atlas, i)} data-nav data-flip={`need:${i.id}`} className="srow need" title={i.text}>
                <span className="lead">{area(i.areas) ? <SpaceMark area={area(i.areas)} size={16} /> : <span className="dot-ac" />}</span>
                <span className="t">
                  <span className="t1 clip">{i.job ? i.job.title : i.title}</span>
                </span>
                <span className="meta ac">{NEED_ACT[i.kind]}</span>
              </a>
            ))}
          </>
        )}

        {working.length > 0 && (
          <>
            <div className="sgroup" data-flip="g:working">
              Working
              <span className="grow" />
              <span className="n">{working.length}</span>
            </div>
            {working.map((w) =>
              w.kind === "job" ? (
                <a
                  key={`job:${w.j.id}`}
                  href={`#/home/${encodeURIComponent(`job:${w.j.id}`)}`}
                  data-nav
                  data-flip={`job:${w.j.id}`}
                  className={`srow ${job === w.j.id ? "on" : ""}`}
                  title={w.j.owned?.now ?? jobNow(w.j, now).status}
                >
                  <span className="lead">
                    <span className="live-dot" />
                  </span>
                  <span className="t">
                    <span className="t1 clip">{w.j.title}</span>
                  </span>
                  <span className="meta">{ago(w.j.started_at, now)}</span>
                </a>
              ) : (
                <ThreadRow key={`th:${w.t.id}`} atlas={atlas} t={w.t} on={here === w.t.id} now={now} />
              ),
            )}
          </>
        )}

        {spaces.length > 0 && (
          <>
            <div className="sgroup" data-flip="g:spaces">
              Spaces
            </div>
            {spaces.map((a) => {
              const open = s.threads.filter((t) => t.areas.includes(a.id) && t.state !== "quiet").length;
              return (
                <a
                  key={`space:${a.id}`}
                  href={`#/space/${encodeURIComponent(a.id)}`}
                  data-nav
                  data-flip={`space:${a.id}`}
                  className={`srow ${space === a.id ? "on" : ""} ${a.state === "dormant" ? "dim" : ""}`}
                  aria-current={space === a.id ? "page" : undefined}
                >
                  <span className="lead">
                    <SpaceMark area={a} size={18} />
                  </span>
                  <span className="t">
                    <span className="t1 clip">{a.name}</span>
                  </span>
                  {s.scope === a.id && <span className="meta ac">Focus</span>}
                  {s.scope !== a.id && open > 0 && <span className="meta">{open}</span>}
                </a>
              );
            })}
          </>
        )}

        {(recentThreads.length > 0 || recentJobs.length > 0 || quiet > 0) && (
          <>
            <div className="sgroup" data-flip="g:recent">
              Recent
            </div>
            {recentThreads.map((t) => (
              <ThreadRow key={`th:${t.id}`} atlas={atlas} t={t} on={here === t.id} now={now} />
            ))}
            {recentJobs.map((j) => (
              <a
                key={`job:${j.id}`}
                href={`#/home/${encodeURIComponent(`job:${j.id}`)}`}
                data-nav
                data-flip={`job:${j.id}`}
                className={`srow ${job === j.id ? "on" : ""}`}
              >
                <span className="lead">
                  {j.state === "done" ? <Icon name="check" size={13} style={{ color: "var(--ok)" }} /> : <span className="dot-quiet" />}
                </span>
                <span className="t">
                  <span className="t1 clip">{j.title}</span>
                </span>
                <span className="meta">{jobNow(j, now).label === "Done" ? "Done" : jobNow(j, now).label}</span>
              </a>
            ))}
            {quiet > 0 && (
              <button className="srow more" onClick={() => setOlder(!older)}>
                <span className="lead" />
                <span className="t">
                  <span className="t1">{older ? "Show fewer" : `Show older · ${quiet}`}</span>
                </span>
              </button>
            )}
          </>
        )}
      </div>
      <div className="side-foot">
        {PLACES.map((n) => {
          const on = place === n.id || (n.also ?? []).includes(place);
          return (
            <a key={n.id} href={`#/${n.id}`} className={`srow ${on ? "on" : ""}`} aria-current={on ? "page" : undefined}>
              <span className="lead">
                <Icon name={n.icon} size={15} />
              </span>
              <span className="t">
                <span className="t1">{n.label}</span>
              </span>
            </a>
          );
        })}
        <div className="me">
          <span className="avatar">{owner === "You" ? "Me" : initials(owner)}</span>
          <span className="clip">{owner}</span>
          <span className="grow" />
          {!atlas.voice.connected && <span className="conn small">Reconnecting</span>}
        </div>
      </div>
    </nav>
  );
}

/** One thread in the sidebar: its name, its space, and how long since it moved, or that it's working or waiting. */
function ThreadRow({ atlas, t, on, now }: { atlas: Atlas; t: ThreadView; on: boolean; now: number }) {
  const area = atlas.state.areas.find((a) => t.areas.includes(a.id));
  return (
    <a
      href={`#/thread/${encodeURIComponent(t.id)}`}
      data-nav
      data-flip={`th:${t.id}`}
      className={`srow ${on ? "on" : ""} ${t.state === "quiet" ? "dim" : ""}`}
      aria-current={on ? "page" : undefined}
      title={t.last?.text}
    >
      <span className="lead">
        {t.state === "working" ? (
          <span className="live-dot" />
        ) : area ? (
          <SpaceMark area={area} size={14} />
        ) : (
          <span className="dot-quiet" />
        )}
      </span>
      <span className="t">
        <span className="t1 clip" key={t.title}>
          {t.title}
        </span>
      </span>
      <span className="meta">
        {t.waiting ? "Waiting" : t.state === "working" ? "now" : t.pinned ? <Icon name="pin" size={11} /> : ago(t.last_at, now)}
      </span>
    </a>
  );
}

/** The phone's tab bar (§21.10): Threads, Calendar, Library and Settings. Threads is the sidebar itself. */
export function TabBar({ atlas, place }: { atlas: Atlas; place: Place }) {
  const needs = needsYou(atlas).length;
  const threads = ["threads", "home", "thread", "space", "new", "inbox"].includes(place);
  const tabs: Array<{ href: string; label: string; icon: IconName; on: boolean; badge?: number }> = [
    { href: "#/threads", label: "Threads", icon: "chat", on: threads, badge: needs },
    { href: "#/agenda", label: "Calendar", icon: "agenda", on: place === "agenda" },
    { href: "#/library", label: "Library", icon: "library", on: place === "library" || place === "people" },
    {
      href: "#/settings",
      label: "Settings",
      icon: "settings",
      on: ["settings", "automations", "abilities", "history", "pair"].includes(place),
    },
  ];
  return (
    <nav className="tabbar" aria-label="Places">
      {tabs.map((t) => (
        <a key={t.href} href={t.href} className={t.on ? "on" : ""}>
          <Icon name={t.icon} size={19} />
          {t.label}
          {t.badge ? <span className="badge">{t.badge}</span> : null}
        </a>
      ))}
    </nav>
  );
}

// --- talking to Atlas -----------------------------------------------------------------

/** Goes to Today, from anywhere (⌘J does the same), ready to type. */
export const openConversation = () => {
  location.hash = "/home";
  setTimeout(() => document.getElementById("say")?.focus(), 50);
};

/** A space named at the start of a message ("@Keyframes draft the invoice"), and the words after it (§21.1). */
export function mentioned(text: string, areas: AreaView[]): { area: AreaView; rest: string } | null {
  if (!text.startsWith("@")) return null;
  const lower = text.slice(1).toLowerCase();
  const hit = [...areas]
    .filter((a) => a.state !== "archived")
    .sort((a, b) => b.name.length - a.name.length)
    .find((a) => lower.startsWith(a.name.toLowerCase()) && /^(\s|$|[,:])/.test(lower.slice(a.name.length)));
  if (!hit) return null;
  const rest = text
    .slice(1 + hit.name.length)
    .replace(/^[\s,:]+/, "")
    .trim();
  return rest ? { area: hit, rest } : null;
}

/**
 * The message box (§21.1). In Today or a thread, what's typed is said there. `fresh` is a thread not started yet
 * (⌘N): its first message starts it. `space` starts a new thread in that space. Starting with "@Space" starts one
 * there from anywhere. Off a conversation, it shows the exchange sent from it (`reply`), so what you asked and
 * Atlas's answer stay in view on the page you asked from.
 */
export function Composer({
  atlas,
  placeholder,
  chip = true,
  reply = true,
  thread = null,
  fresh = false,
  space,
}: {
  atlas: Atlas;
  placeholder: string;
  chip?: boolean;
  reply?: boolean;
  thread?: string | null;
  fresh?: boolean;
  space?: string;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const s = atlas.state;
  const [sent, setSent] = useState<{ client_id: string; text: string; at: number; run_id: string | null } | null>(null);
  // A thread being started from here: once its id comes back, it opens.
  const [starting, setStarting] = useState<string | null>(null);
  useEffect(() => {
    const id = starting ? s.made[starting] : undefined;
    if (!id) return;
    setStarting(null);
    location.hash = `/thread/${encodeURIComponent(id)}`;
    setTimeout(() => document.getElementById("say")?.focus(), 60);
  }, [starting, s.made]);

  // Learn the sent message's run as soon as Atlas takes it; failing that, find its row in the thread.
  const fromPending = sent && !sent.run_id ? s.pending.find((p) => p.client_id === sent.client_id)?.run_id : undefined;
  const fromRows =
    sent && !sent.run_id && !fromPending
      ? [...s.rows].reverse().find((r) => r.kind === "message.in" && r.body.text === sent.text && r.at >= sent.at - 5_000)?.run_id
      : undefined;
  useEffect(() => {
    const run = fromPending ?? fromRows;
    if (sent && !sent.run_id && run) setSent({ ...sent, run_id: run });
  }, [fromPending, fromRows]);

  useEffect(() => {
    // Other parts of the app can put words in the composer ("Ask about this").
    const on = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      ref.current?.focus();
    };
    window.addEventListener("atlas:compose", on);
    return () => window.removeEventListener("atlas:compose", on);
  }, []);

  const { busy, mine, stop } = useTurn(atlas, thread);
  const at = text.startsWith("@") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const suggest = at != null ? s.areas.filter((a) => a.state !== "archived" && a.name.toLowerCase().startsWith(at)).slice(0, 5) : [];

  function submit() {
    const t = text.trim();
    // While the socket is down the words stay here, rather than going nowhere.
    if (!t || !atlas.voice.connected) return;
    const named = mentioned(t, s.areas);
    if (named || fresh || space) {
      const client_id = atlas.startThread({
        text: named ? named.rest : t,
        ...(named ? { areas: [named.area.id] } : space ? { areas: [space] } : {}),
      });
      setStarting(client_id);
    } else {
      const client_id = atlas.say(t, thread);
      if (reply) setSent({ client_id, text: t, at: Date.now(), run_id: null });
    }
    setText("");
    ref.current?.focus();
  }

  const form = (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* On its own, the field is the box; with an exchange above it, the console's edge shows it. */}
      {busy && !sent && <BusyEdge />}
      {suggest.length > 0 && (
        <div className="mention-pop rise" role="listbox" aria-label="Spaces">
          {suggest.map((a) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                setText(`@${a.name} `);
                ref.current?.focus();
              }}
            >
              <SpaceMark area={a} size={16} />
              <span className="grow">{a.name}</span>
              <span className="faint small">New thread here</span>
            </button>
          ))}
        </div>
      )}
      <span className="lead mark-lead">
        <LiveMark
          size={18}
          state={
            atlas.inCall
              ? atlas.voice.status === "listening" || atlas.voice.status === "thinking" || atlas.voice.status === "speaking"
                ? atlas.voice.status
                : "idle"
              : busy || starting
                ? "thinking"
                : "idle"
          }
        />
      </span>
      <label className="sr" htmlFor="say">
        Message {s.view?.settings.assistant_name ?? "Atlas"}
      </label>
      <textarea
        id="say"
        ref={ref}
        rows={1}
        value={text}
        placeholder={atlas.voice.connected ? placeholder : "Reconnecting to Atlas. What you type waits here."}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Tab" && suggest[0]) {
            e.preventDefault();
            setText(`@${suggest[0].name} `);
          }
        }}
      />
      {chip && s.scope && !thread && !space && (
        <span className="lead hide-phone">
          <AreaChip ids={[s.scope]} areas={s.areas} />
        </span>
      )}
      <button
        type="button"
        className={`talk ${atlas.inCall ? "live" : ""}`}
        aria-label={atlas.inCall ? "End voice" : "Talk"}
        title={atlas.inCall ? "End voice" : "Talk  Space"}
        onClick={() => void atlas.toggleCall()}
      >
        <Icon name="mic" size={14} />
        <span className="hide-phone">{atlas.inCall ? "End" : "Talk"}</span>
      </button>
      {busy && !text.trim() && mine.length > 0 ? (
        // Typing while Atlas works shows Send again: the message waits its turn.
        <button type="button" className="send stop" aria-label="Stop" title="Stop" onClick={stop}>
          <span className="stop-square" />
        </button>
      ) : (
        <button className="send" aria-label="Send" disabled={!text.trim()}>
          <Icon name="up" size={15} style={{ strokeWidth: 2.1 }} />
        </button>
      )}
    </form>
  );
  if (!sent) return form;
  return (
    <div className="console">
      {busy && <BusyEdge />}
      <Exchange atlas={atlas} runId={sent.run_id} asked={sent.text} onClose={() => setSent(null)} />
      {form}
    </div>
  );
}

/**
 * A turn under way in this conversation (Today, or one thread): any run that isn't a voice call. The owner's own
 * text runs are the ones Stop ends.
 */
function useTurn(atlas: Atlas, thread: string | null = null) {
  const s = atlas.state;
  // A job's turns work in its own thread, and each thread's turns in that thread, so they show on its message box.
  const runs = Object.entries(s.live).filter(([, l]) => l.surface !== "voice" && !l.job && (l.thread ?? null) === thread);
  const mine = runs.filter(([, l]) => l.surface === "app").map(([id]) => id);
  const busy = runs.length > 0 || s.pending.some((p) => !p.run_id && (p.thread ?? null) === thread);
  const stop = () => {
    for (const run_id of mine) atlas.send({ type: "atlas.run.stop", run_id });
  };
  return { busy, mine, stop };
}

/** The ticks' size in px: on, off, and how many travel together. */
const TICK = { on: 3, off: 2, count: 18 };
/** How fast the ticks travel, in px a second, so a big box isn't a fast one. */
const TRAVEL = 220;

/**
 * Work in progress, drawn on the box's edge (§21.1): a dotted track, and a
 * short run of sharp ticks travelling all the way round. Without motion,
 * only the track shows.
 */
export function BusyEdge() {
  const box = useRef<HTMLDivElement | null>(null);
  const comet = useRef<SVGRectElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const o = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    o.observe(el);
    return () => o.disconnect();
  }, []);
  const r = 11.5;
  const w = Math.max(0, size.w - 1);
  const h = Math.max(0, size.h - 1);
  const perimeter = Math.max(1, 2 * (w + h - 4 * r) + 2 * Math.PI * r);
  const run = (TICK.on + TICK.off) * TICK.count;
  const dashes = [
    ...Array.from({ length: TICK.count }, () => [TICK.on, TICK.off])
      .flat()
      .slice(0, -1),
    TICK.off + Math.max(0, perimeter - run),
  ];
  useEffect(() => {
    const el = comet.current;
    const still = document.documentElement.dataset.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!el || still || perimeter <= 1) return;
    const duration = (perimeter / TRAVEL) * 1000;
    const a = el.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -perimeter }], { duration, iterations: Infinity });
    // Where the ticks are follows the clock, not when this started: the box growing as a tool's
    // status or receipt arrives (or the edge being drawn again) doesn't send them back to the start.
    a.currentTime = performance.now() % duration;
    return () => a.cancel();
  }, [perimeter]);
  return (
    <div className="busy-edge" ref={box} aria-hidden="true">
      {size.w > 0 && (
        <svg width={size.w} height={size.h}>
          <rect className="track" x={0.5} y={0.5} width={w} height={h} rx={r} />
          <rect ref={comet} className="comet" x={0.5} y={0.5} width={w} height={h} rx={r} strokeDasharray={dashes.join(" ")} />
        </svg>
      )}
    </div>
  );
}

/** Puts words in the composer from anywhere ("Ask about this"). */
export const compose = (text: string) => window.dispatchEvent(new CustomEvent("atlas:compose", { detail: text }));

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * One exchange: what the owner asked, Atlas's answer as it streams, and the
 * receipts for what it did. Pages other than Home show the one sent from
 * their composer, so a message never just disappears.
 */
function Exchange({ atlas, runId, asked, onClose }: { atlas: Atlas; runId: string | null; asked: string; onClose?: () => void }) {
  const s = atlas.state;
  const name = s.view?.settings.assistant_name ?? "Atlas";
  const liveRun = runId ? ([runId, s.live[runId]] as const) : undefined;
  const out = runId ? s.rows.find((r) => r.kind === "message.out" && r.run_id === runId) : undefined;
  const receipts = runId ? s.rows.filter((r) => r.run_id === runId && r.kind === "tool.result" && r.body.receipt) : [];
  const undone = undoneIds(s.rows);
  const shown = receipts.map(shownFrom).filter((v): v is Shown => v != null);
  const live = liveRun?.[1];
  const failed = !live && !out && runId ? s.rows.find((r) => r.kind === "run.end" && r.run_id === runId) : undefined;
  const said = live ? live.text : str(out?.body.text);
  const at = out?.at;
  // Sent, and nothing back yet: say Atlas is on it.
  const waiting = !said && !failed;

  if (!(asked || said || live)) return null;
  return (
    <div className="exchange rise" key={runId ?? "none"}>
      <div className="head">
        <span className="lab">
          {name}
          {at ? ` · ${shortDay(at)}` : ""}
        </span>
        <span className="grow" />
        <button className="chip" onClick={openConversation}>
          In the conversation <span className="kbd">⌘J</span>
        </button>
        {onClose && (
          <button className="icon" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {asked && <p className="asked">You: {asked}</p>}
      {said && <Markdown className="said" text={said} />}
      {((live && (live.status || !live.text)) || (waiting && !live)) && (
        <p className="lab" style={{ marginTop: 6 }}>
          {live?.status ?? "Thinking"}
        </p>
      )}
      {failed &&
        (failed.body.interrupted ? (
          <p className="lab" style={{ marginTop: 6 }}>
            Stopped
          </p>
        ) : (
          <p className="err small" style={{ marginTop: 4 }}>
            Didn't finish. {str(failed.body.error) || "The run failed."}
          </p>
        ))}
      {receipts.length > 0 && (
        <div className="receipts">
          {receipts.map((r) => (
            <Receipt key={r.id} row={r} atlas={atlas} undone={undone.has(r.id)} />
          ))}
        </div>
      )}
      {/* Away from Home, a view Atlas showed arrives as a card that opens it on the stage there (§21.6). */}
      {shown.map((v) => (
        <StageCard key={v.id} atlas={atlas} shown={v} onOpen={() => openOnStage(v.id)} />
      ))}
    </div>
  );
}

/**
 * A receipt for one thing Atlas did (§21.1): a mono chip whose check ticks in,
 * with Undo or Review inline. Tapped, it unfolds into its full view on the stage.
 */
export function Receipt({
  row,
  atlas,
  undone,
  onOpen,
}: {
  row: LogRow;
  atlas: Atlas;
  undone: boolean;
  onOpen?: (e?: React.MouseEvent<HTMLElement>) => void;
}) {
  const receipt = row.body.receipt as { text: string; undo?: unknown; approval?: string; link?: string } | undefined;
  if (!receipt) return null;
  const bad = row.body.ok === false;
  const waiting = receipt.approval != null && atlas.state.inbox?.some((i) => i.id === receipt.approval);
  return (
    <span className={`receipt ${bad ? "bad" : ""} ${waiting ? "waiting" : ""} ${undone ? "undone" : ""}`}>
      <span className="tick" aria-hidden>
        {bad ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M2 2l6 6M8 2l-6 6" />
          </svg>
        ) : waiting ? (
          <i className="sq-ac" />
        ) : receipt.link && hostOf(receipt.link) ? (
          <SiteMark host={hostOf(receipt.link)} size={14} />
        ) : (
          <Icon name={stepIcon(String(row.body.name ?? ""))} size={11} />
        )}
      </span>
      {onOpen ? (
        <button className="open" onClick={(e) => onOpen(e)} title={receipt.text}>
          {receipt.text}
        </button>
      ) : (
        <span className="open" title={receipt.text}>
          {receipt.text}
        </span>
      )}
      {undone && <span className="r-act off">Undone</span>}
      {waiting &&
        (onOpen ? (
          <button className="r-act" onClick={(e) => onOpen(e)}>
            Review
          </button>
        ) : (
          <a className="r-act" href="#/inbox">
            Review
          </a>
        ))}
      {receipt.undo != null && !undone && (
        <button className="r-act" onClick={() => atlas.send({ type: "atlas.undo", log_id: row.id })}>
          Undo
        </button>
      )}
    </span>
  );
}

// --- voice --------------------------------------------------------------------------------

export function VoiceStrip({ atlas, onExpand }: { atlas: Atlas; onExpand?: () => void }) {
  const { status, interim, level, latencyMs } = atlas.voice;
  const dev = useDetail().at("developer");
  const label = status === "idle" ? "Starting" : status[0]!.toUpperCase() + status.slice(1);
  const live = Object.values(atlas.state.live)
    .filter((l) => !l.job)
    .at(-1);
  const bars = Array.from({ length: 28 }, (_, i) =>
    Math.max(0.12, Math.min(1, level * 6 * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + level * 9))))),
  );
  return (
    <div className="voice rise">
      <AsciiDiamond height={48} level={level} state={status} />
      <div className="vbody">
        <span className={`lab ${status === "speaking" ? "ac" : ""}`}>{label}</span>
        <p className="vtext">
          {status === "speaking" && live?.text ? live.text.slice(-160) : interim || (status === "listening" ? "Go ahead." : "")}
        </p>
        <div className="wave" aria-hidden>
          {bars.map((h, i) => (
            <i key={i} style={{ transform: `scaleY(${h})` }} />
          ))}
        </div>
      </div>
      <span className="lab">{latencyMs != null && dev ? `${Math.round(latencyMs)} ms` : ""}</span>
      {onExpand && (
        <button className="icon" onClick={onExpand} aria-label="Full screen" title="Full screen">
          <Icon name="expand" size={14} />
        </button>
      )}
    </div>
  );
}

// --- ⌘K ------------------------------------------------------------------------------

/** What ⌘K offers to do, in words: each one is asked of Atlas, and matches when the owner types any of its words. */
const ACTIONS: Array<{ say: string; words: string[] }> = [
  { say: "Quiet until 9 AM", words: ["quiet", "focus", "dnd", "silence", "mute"] },
  { say: "Quiet for the rest of the day", words: ["quiet", "focus", "dnd", "silence"] },
  { say: "What does today look like?", words: ["today", "day", "schedule", "agenda"] },
  { say: "What does tomorrow look like?", words: ["tomorrow", "schedule"] },
  { say: "Remind me ", words: ["remind", "reminder"] },
  { say: "Make an automation that ", words: ["automation", "routine", "auto", "every"] },
];

const GROUPS: Record<SearchHit["group"], string> = {
  files: "Files",
  pages: "Pages",
  jobs: "Jobs",
  skills: "Skills",
  automations: "Automations",
  people: "People",
  places: "Places",
  memory: "Memory",
  conversation: "In the conversation",
};

/** A hit's picture: a video's frame, an image, a person's face, a job at work, or its kind's icon. */
function HitMark({ h }: { h: SearchHit }) {
  if (h.group === "files" && h.type?.startsWith("video/"))
    return (
      <span className="hit-mark media">
        <video src={`/api/files/${h.id}?inline=1#t=0.5`} preload="metadata" muted playsInline />
      </span>
    );
  if (h.group === "files" && h.type?.startsWith("image/"))
    return (
      <span className="hit-mark media">
        <img src={`/api/files/${h.id}?inline=1`} alt="" loading="lazy" />
      </span>
    );
  if (h.group === "files")
    return <span className="hit-mark mono">{(h.title.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE"}</span>;
  if (h.group === "people") return <Avatar name={h.title} photo={h.photo} size={30} />;
  if (h.group === "jobs" && h.live)
    return (
      <span className="hit-mark">
        <span className="mono spin" aria-hidden style={{ color: "var(--ac)" }} />
      </span>
    );
  const icon: IconName =
    h.group === "pages"
      ? "file"
      : h.group === "jobs"
        ? "jobs"
        : h.group === "skills"
          ? "skills"
          : h.group === "automations"
            ? "automations"
            : h.group === "places"
              ? "place"
              : h.group === "conversation"
                ? "chat"
                : "memory";
  return (
    <span className="hit-mark">
      <Icon name={icon} size={14} />
    </span>
  );
}

/** ⌘K (M7 W20): find anything Atlas keeps, go to a place, do something in words, or ask Atlas. */
export function Palette({ atlas, go, onClose }: { atlas: Atlas; go: (p: Place, d?: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const text = q.trim();
  useEffect(() => {
    if (text.length < 2) return;
    const t = setTimeout(() => atlas.send({ type: "atlas.search", text }), 120);
    return () => clearTimeout(t);
  }, [text]);
  const hits = text.length >= 2 && atlas.state.search?.text === text ? atlas.state.search.hits : [];
  const lower = text.toLowerCase();
  const places: Array<[Place, string]> = GO_TO.map((p) => [p.id, p.label]);
  const ask = (words: string) => {
    atlas.say(words);
    openConversation();
  };
  // ⌘K finds threads by their names too (§21.1).
  const lowerQ = text.toLowerCase();
  const threadHits = lowerQ.length >= 2 ? atlas.state.threads.filter((t) => t.title.toLowerCase().includes(lowerQ)).slice(0, 6) : [];
  const open = (h: SearchHit) => {
    if (h.group === "files") go("library", `file:${h.id}`);
    else if (h.group === "pages") go("library", `page:${h.id}`);
    else if (h.group === "jobs") go("home", `job:${h.id}`);
    else if (h.group === "skills") go("abilities", "skills");
    else if (h.group === "automations") go("automations", h.id);
    else if (h.group === "people") go("people", `person:${h.id}`);
    else if (h.group === "places") go("library", `place:${h.id}`);
    else if (h.group === "memory") go("library", `memory:${h.id}`);
    else go("home", `at:${h.id}`);
  };
  type Row = { key: string; group?: string; mark: ReactNode; title: ReactNode; sub?: string; act: string; run: () => void };
  const rows: Row[] = [
    ...(lower
      ? places
          .filter(([, l]) => l.toLowerCase().startsWith(lower))
          .map(([p, l]) => ({
            key: `place:${p}`,
            group: "Go to",
            mark: (
              <span className="hit-mark">
                <Icon name={GO_TO.find((x) => x.id === p)?.icon ?? "settings"} size={14} />
              </span>
            ),
            title: l,
            act: "Go",
            run: () => go(p),
          }))
      : []),
    ...threadHits.map((t) => ({
      key: `thread:${t.id}`,
      group: "Threads",
      mark: (
        <span className="hit-mark">
          <Icon name="chat" size={14} />
        </span>
      ),
      title: t.title,
      sub: t.last?.text ?? "",
      act: "Open",
      run: () => go("thread", t.id),
    })),
    ...hits.map((h) => ({
      key: `${h.group}:${h.id}`,
      group: GROUPS[h.group],
      mark: <HitMark h={h} />,
      title: h.group === "conversation" ? `“${h.title}”` : h.title,
      sub: h.group === "conversation" ? `${h.sub}, ${shortDay(h.at)}` : h.sub || shortDay(h.at),
      act: h.group === "conversation" ? "Jump" : "Open",
      run: () => open(h),
    })),
    ...(lower
      ? ACTIONS.filter((a) => a.words.some((w) => w.startsWith(lower) || lower.startsWith(w))).map((a) => ({
          key: `do:${a.say}`,
          group: "Do",
          mark: (
            <span className="hit-mark">
              <Diamond size={12} />
            </span>
          ),
          title: a.say.trim(),
          act: "Ask",
          run: () => (a.say.endsWith(" ") ? (setQ(a.say), setSel(0)) : ask(a.say)),
        }))
      : []),
    ...(text
      ? [
          {
            key: "ask",
            group: "",
            mark: (
              <span className="hit-mark">
                <Diamond size={12} />
              </span>
            ),
            title: <>Ask Atlas “{text}”</>,
            sub: "The answer opens in the conversation",
            act: "⌘↵",
            run: () => ask(text),
          },
        ]
      : []),
  ];
  const pick = (i: number) => {
    const r = rows[i];
    if (!r) return;
    r.run();
    if (!r.key.startsWith("do:") || !ACTIONS.find((a) => `do:${a.say}` === r.key)?.say.endsWith(" ")) onClose();
  };
  let last = "";
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet rise palette" style={{ height: "auto", maxHeight: "72vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <Icon name="search" />
          <input
            autoFocus
            value={q}
            placeholder="Find anything, go somewhere, or ask Atlas"
            style={{ flex: 1, border: 0, boxShadow: "none", background: "transparent" }}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setSel((i) => Math.min(rows.length - 1, i + 1));
              else if (e.key === "ArrowUp") setSel((i) => Math.max(0, i - 1));
              else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text) {
                ask(text);
                onClose();
              } else if (e.key === "Enter") pick(sel);
              else if (e.key === "Escape") onClose();
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="hits" role="listbox" aria-label="Results">
          {!text && (
            <p className="hits-empty faint small">Files, pages, jobs, skills, people, places and anything said in the conversation.</p>
          )}
          {rows.map((r, i) => {
            const head = r.group != null && r.group !== last ? r.group : null;
            if (r.group != null) last = r.group;
            return (
              <div key={r.key}>
                {head && <p className="lab hits-group">{head}</p>}
                <button
                  role="option"
                  aria-selected={i === sel}
                  className={`hit ${i === sel ? "on" : ""}`}
                  style={{ "--i": i } as React.CSSProperties}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => pick(i)}
                >
                  {r.mark}
                  <span className="hit-words">
                    <span className="hit-title clip">{r.title}</span>
                    {r.sub && <span className="hit-sub clip">{r.sub}</span>}
                  </span>
                  <span className="hit-act mono">{r.act}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="hits-foot faint small">
          <span>
            <span className="kbd">↑↓</span> move
          </span>
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span>
            <span className="kbd">⌘↵</span> ask Atlas
          </span>
        </div>
      </div>
    </div>
  );
}
