// Automations (§13, §21.2; docs/ui screens 11 and 12): what Atlas does on
// its own or when asked. Cards with their trigger, steps and recent runs,
// Run or an on/off switch; each opens as a When → Do → Report flow with its
// runs. Atlas's own start paused until you've seen a test run; the form
// makes one by hand, which starts on.

import { useEffect, useState } from "react";
import type { AutomationInput, Step, Trigger } from "../../../core/src/automations";
import type { AutomationView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Composer } from "../Shell";
import { AreaChip, Empty, Icon, type ICONS, Picker, Seg, Sheet, shortDay, Stage, startOfDay } from "../ui";

type Filter = "all" | "request" | "schedule" | "event" | "watch";

/** The automations, asked for once and kept current by the agent's broadcasts. */
export function useAutomations(atlas: Atlas): AutomationView[] | null {
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.automations" });
  }, [atlas.voice.connected]);
  return atlas.state.automations;
}

const kindOf = (t: Trigger): Filter => (t.kind === "absence" ? "event" : t.kind);

const ICON: Record<Trigger["kind"], keyof typeof ICONS> = {
  request: "mic",
  schedule: "agenda",
  watch: "search",
  absence: "history",
  event: "automations",
};

/** The card's mono line: SAY "GOODNIGHT", WEEKDAYS · 08:00, WATCHING SHOP.EXAMPLE.COM. */
function headLine(a: AutomationView): string {
  const t = a.when;
  if (t.kind === "request") return t.phrase ? `Say "${t.phrase}"` : "On request";
  if (t.kind === "schedule") return a.when_text.replace(/^At (\S+), (.*)$/, "$2 · $1");
  if (t.kind === "watch") return `Watching ${new URL(t.url).host}`;
  if (t.kind === "absence") return `No "${t.nothing_about}" in ${t.for_days} days`;
  if (t.on === "calendar") return t.about ? `Calendar · "${t.about}"` : "Calendar changes";
  return "After another automation";
}

const inputsOf = (a: AutomationView) =>
  a.when.kind === "request" && a.when.phrase ? [...a.when.phrase.matchAll(/\$(\w+)/g)].map((m) => m[1]!) : [];

export function Automations({ atlas, detail, go }: { atlas: Atlas; detail: string; go: (d: string) => void }) {
  const list = useAutomations(atlas);
  const [filter, setFilter] = useState<Filter>("all");
  const all = list ?? [];
  const open = detail.startsWith("a:") ? all.find((a) => a.id === detail.slice(2)) : undefined;
  const editing = detail === "new" ? "new" : detail.startsWith("edit:") ? all.find((a) => a.id === detail.slice(5)) : undefined;
  const today = startOfDay(new Date()).getTime();
  const runsToday = all.flatMap((a) => a.runs).filter((r) => r.at >= today && !r.test && !r.quiet);
  const count = (f: Filter) => all.filter((a) => kindOf(a.when) === f).length || null;
  const shown = all.filter((a) => filter === "all" || kindOf(a.when) === filter);
  // Make it on a suggestion opens the form filled in from what the owner asked.
  const [draft, setDraft] = useState<{ from: string; input: AutomationInput } | null>(null);
  const [moreIdeas, setMoreIdeas] = useState(false);
  const suggestions = atlas.state.suggestions;

  return (
    <Stage
      label="Automations"
      tabs={[
        { id: "all", label: "All", badge: all.length || null },
        { id: "request", label: "On request", badge: count("request") },
        { id: "schedule", label: "Scheduled", badge: count("schedule") },
        { id: "event", label: "Events", badge: count("event") },
        { id: "watch", label: "Watches", badge: count("watch") },
      ]}
      tab={filter}
      onTab={(t) => {
        setFilter(t);
        go("");
      }}
      meta={`${runsToday.length} ${runsToday.length === 1 ? "run" : "runs"} today · ${runsToday.filter((r) => !r.ok).length} failed`}
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder={`Describe an automation${all[0] ? `, or say run ${all[0].name}` : ""}`} />
        </div>
      }
    >
      <Sheet>
        <div className="sheet-in">
          {editing ? (
            <AutomationForm
              atlas={atlas}
              a={editing === "new" ? null : editing}
              start={editing === "new" ? draft?.input : undefined}
              done={(id, saved) => {
                if (saved && editing === "new" && draft) atlas.send({ type: "atlas.suggestion.set", id: draft.from, state: "made" });
                setDraft(null);
                go(id ? `a:${id}` : "");
              }}
            />
          ) : open ? (
            <>
              <button className="link small" onClick={() => go("")} style={{ marginBottom: 14 }}>
                ← All automations
              </button>
              <AutomationFlow atlas={atlas} a={open} onEdit={() => go(`edit:${open.id}`)} onDeleted={() => go("")} />
            </>
          ) : list == null ? (
            <p className="lab">Looking</p>
          ) : (
            <>
              {filter === "all" &&
                (moreIdeas ? suggestions : suggestions.slice(0, 1)).map((sg, i) => (
                  <div key={sg.id} className="panel suggest">
                    <p style={{ margin: "0 0 10px" }}>
                      You've asked for "{sg.said}" on {sg.times} different days. Make it an automation, so it's one word or a time away?
                    </p>
                    <div className="row">
                      <button
                        className="btn primary sm"
                        onClick={() => {
                          setDraft({ from: sg.id, input: fromSuggestion(sg.said) });
                          go("new");
                        }}
                      >
                        Make it
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => atlas.send({ type: "atlas.suggestion.set", id: sg.id, state: "dismissed" })}
                      >
                        Not this one
                      </button>
                      <span className="grow" />
                      {i === 0 && suggestions.length > 1 && (
                        <button className="link small" onClick={() => setMoreIdeas(!moreIdeas)}>
                          {moreIdeas ? "Fewer ideas" : `${suggestions.length - 1} more ${suggestions.length === 2 ? "idea" : "ideas"}`}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              <div className="auto-grid">
                {shown.map((a) => (
                  <AutomationCard key={a.id} atlas={atlas} a={a} open={() => go(`a:${a.id}`)} />
                ))}
                <button className="auto-card new" onClick={() => go("new")}>
                  <span className="icon" aria-hidden>
                    <Icon name="plus" />
                  </span>
                  <span className="disp" style={{ fontSize: 18 }}>
                    New automation
                  </span>
                  <span className="muted small">Describe it to Atlas below, or build it here.</span>
                </button>
                {!all.length && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <Empty title="No automations yet">
                      Say "every weekday at 8, give me a short brief", or "when I say goodnight, turn off the lights". Atlas fills it in,
                      and you see a test run before it runs on its own.
                    </Empty>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </Sheet>
    </Stage>
  );
}

/** The last twelve runs as squares: done, failed (ember), a test (hollow), a quiet look (small). */
function RunStrip({ a }: { a: AutomationView }) {
  const runs = [...a.runs].reverse().slice(-12);
  return (
    <span className="run-strip" aria-label={`${a.runs.length} recent runs`}>
      {Array.from({ length: 12 - runs.length }, (_, i) => (
        <i key={`e${i}`} className="none" />
      ))}
      {runs.map((r) => (
        <i
          key={r.id}
          className={r.quiet ? "quiet" : r.test ? "test" : r.ok ? "ok" : "bad"}
          title={`${shortDay(r.at)}: ${r.error ?? r.text}`}
        />
      ))}
    </span>
  );
}

function AutomationCard({ atlas, a, open }: { atlas: Atlas; a: AutomationView; open: () => void }) {
  const last = a.runs.find((r) => !r.quiet);
  const powers = new Set(a.steps.filter((s) => s.step.kind === "webhook").map((s) => (s.step as { webhook: string }).webhook)).size;
  const asks = !a.can_turn_on;
  return (
    <div className="auto-card">
      <button className="body" onClick={open}>
        <span className="lab row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <Icon name={ICON[a.when.kind]} size={13} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{headLine(a)}</span>
        </span>
        <span className="disp" style={{ fontSize: 18 }}>
          {a.name}
        </span>
        <span className="muted small clamp">{a.about || a.steps.map((s) => s.text).join(" · ")}</span>
        <span className="lab faint">
          {a.steps.length} {a.steps.length === 1 ? "step" : "steps"} · {powers} {powers === 1 ? "power" : "powers"}
          {asks ? " · needs a test run" : a.paused_why ? " · paused itself" : ""}
        </span>
        {a.cost && <span className="faint small">{a.cost}</span>}
      </button>
      <div className="foot">
        <RunStrip a={a} />
        {atlas.state.areas.length > 0 && (
          <AreaChip
            ids={a.areas}
            areas={atlas.state.areas}
            onMove={(ids) => atlas.send({ type: "atlas.areas.set", ref: `aut:${a.id}`, areas: ids })}
          />
        )}
        <span className="muted small grow">{last ? shortDay(last.at) : a.next_at ? `Next ${shortDay(a.next_at)}` : "Not run yet"}</span>
        {a.when.kind === "request" ? (
          <button className="btn sm" onClick={() => (inputsOf(a).length ? open() : atlas.send({ type: "atlas.automation.run", id: a.id }))}>
            <Icon name="play" size={11} /> Run
          </button>
        ) : (
          <Switch
            on={a.state === "on"}
            disabled={!a.can_turn_on && a.state !== "on"}
            onChange={(on) => atlas.send({ type: "atlas.automation.set", id: a.id, on })}
          />
        )}
      </div>
    </div>
  );
}

export function Switch({ on, onChange, disabled }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      className={`switch ${on ? "on" : ""}`}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      title={disabled ? "Needs a test run first" : on ? "On" : "Paused"}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}

const REPORT: Record<AutomationView["report"], [string, string]> = {
  thread: ["Tells you", "Every time it runs"],
  worth: ["Tells you, when it's worth it", "Only when there's something worth saying, after quiet hours"],
  inbox: ["Inbox", "Waits in Inbox for you to look over"],
  silent: ["History", "Only in History"],
};

/**
 * Where an automation can tell the owner, only what's really there: wherever
 * they are (in Atlas when it's open, else their Notifications lists), a chat
 * they've linked, or a notification once a device takes them.
 */
function places(atlas: Atlas, keep?: string): Array<{ value: string; label: string; sub?: string; phrase: string }> {
  const v = atlas.state.view;
  const chats = (v?.channels ?? []).filter((c) => c.linked);
  const devices = v?.settings.notifications.push ? (v?.push.devices ?? []) : [];
  const word = (p: string) => (p === "push" ? (devices.length ? "a notification" : null) : (chats.find((c) => c.ext === p)?.name ?? null));
  const usual = (v?.settings.notifications.lists.soon ?? []).map(word).filter((w): w is string => !!w);
  const out = [
    {
      value: "you",
      label: "Where you are",
      sub: usual.length ? `In Atlas when it's open, otherwise ${usual.join(", then ")}` : "In Atlas, for when you next open it",
      phrase: "wherever you are",
    },
    ...chats.map((c) => ({ value: c.ext, label: c.name, sub: `Always in your ${c.name} chat with Atlas`, phrase: `in ${c.name}` })),
    ...(devices.length
      ? [
          {
            value: "push",
            label: "A notification",
            sub: `Always, on ${devices.length === 1 ? devices[0]!.name : "the device you used last"}`,
            phrase: "as a notification",
          },
        ]
      : []),
  ];
  // A place saved before it went away (a chat unlinked) still shows, so it can be changed.
  if (keep && !out.some((p) => p.value === keep))
    out.push({
      value: keep,
      label: keep === "push" ? "A notification" : keep,
      sub: "Not set up now, so it goes where you are",
      phrase: "where you are",
    });
  return out;
}
const placePhrase = (atlas: Atlas, to: string) => places(atlas, to).find((p) => p.value === to)?.phrase ?? "wherever you are";

/** One automation as a When → Do → Report flow, with what it may do and its runs (docs/ui screen 12). Also its stage view. */
export function AutomationFlow({
  atlas,
  a,
  onEdit,
  onDeleted,
}: {
  atlas: Atlas;
  a: AutomationView;
  onEdit?: () => void;
  onDeleted?: () => void;
}) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const names = inputsOf(a);
  const webhooksUsed = [...new Set(a.steps.filter((s) => s.step.kind === "webhook").map((s) => (s.step as { webhook: string }).webhook))];
  const test = a.runs.find((r) => r.test);
  const real = a.runs.filter((r) => !r.test);
  const needsTest = !a.can_turn_on;
  return (
    <div className="flow-view">
      <div className="row" style={{ gap: 10, marginBottom: 6 }}>
        <span className="icon" aria-hidden style={{ border: "1px solid var(--sep2)", borderRadius: 8, width: 32, height: 32 }}>
          <Icon name={ICON[a.when.kind]} />
        </span>
        <h1 className="disp" style={{ fontSize: 26 }}>
          {a.name}
        </h1>
        <span className={`tag ${a.state === "on" ? "ok" : needsTest || a.paused_why ? "ac" : ""}`}>
          {a.state === "on" ? "■ On" : needsTest ? "Needs a test run" : "Paused"}
        </span>
        <span className="grow" />
        <div className="row" style={{ gap: 6 }}>
          {names.map((n) => (
            <input
              key={n}
              placeholder={`$${n}`}
              value={inputs[n] ?? ""}
              onChange={(e) => setInputs({ ...inputs, [n]: e.target.value })}
              style={{ width: 110 }}
            />
          ))}
          <button
            className="btn primary"
            disabled={names.some((n) => !inputs[n]?.trim())}
            onClick={() => atlas.send({ type: "atlas.automation.run", id: a.id, ...(names.length ? { inputs } : {}) })}
          >
            <Icon name="play" size={11} /> Run now
          </button>
          <button
            className={`btn ${needsTest ? "primary" : ""}`}
            onClick={() => atlas.send({ type: "atlas.automation.run", id: a.id, test: true })}
          >
            Test run
          </button>
          {onEdit && (
            <button className="btn" onClick={onEdit}>
              Edit
            </button>
          )}
          {a.state === "on" ? (
            <button className="btn" onClick={() => atlas.send({ type: "atlas.automation.set", id: a.id, on: false })}>
              Pause
            </button>
          ) : (
            <button
              className="btn"
              disabled={!a.can_turn_on}
              title={a.can_turn_on ? undefined : "See a test run first"}
              onClick={() => atlas.send({ type: "atlas.automation.set", id: a.id, on: true })}
            >
              Turn on
            </button>
          )}
        </div>
      </div>
      {a.about && (
        <p className="muted" style={{ marginBottom: 6 }}>
          {a.about}
        </p>
      )}
      {a.paused_why && <p className="err small">Paused itself. {a.paused_why}</p>}
      {needsTest && (
        <p className="small" style={{ color: "var(--ac)" }}>
          Atlas {a.made_by === "atlas" ? "made" : "changed"} this, so it stays paused until you've seen a test run. A test run uses real
          data and sends nothing.
        </p>
      )}

      <div className="flow">
        <div className="flow-box">
          <span className="lab">When</span>
          <div className="flow-item">
            <span className="lab faint">
              {
                {
                  request: "On request",
                  schedule: "Schedule",
                  watch: "Watch",
                  absence: "Absence",
                  event: a.when.kind === "event" && a.when.on === "calendar" ? "Calendar" : "Event",
                }[a.when.kind]
              }
            </span>
            <span>{a.when_text}</span>
          </div>
          {a.next_at && a.state === "on" && <span className="lab faint">Next: {shortDay(a.next_at)}</span>}
        </div>
        <span className="flow-dash" aria-hidden />
        <div className="flow-box grow">
          <span className="lab">
            Do · {a.steps.length} {a.steps.length === 1 ? "step" : "steps, in order"}
          </span>
          {a.steps.map((s, i) => (
            <div className="flow-item" key={i} style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
              <span className="mono faint">{String(i + 1).padStart(2, "0")}</span>
              <span className="grow" style={{ minWidth: 0 }}>
                {s.step.kind === "say"
                  ? `"${s.step.text}"`
                  : s.step.kind === "webhook"
                    ? `Call ${s.step.webhook}${s.step.message ? `: "${s.step.message}"` : ""}`
                    : s.step.instructions}
              </span>
              <span className="lab faint">{s.step.kind === "atlas" ? "Atlas" : s.step.kind === "webhook" ? "Webhook" : "Say"}</span>
            </div>
          ))}
        </div>
        <span className="flow-dash" aria-hidden />
        <div className="flow-box">
          <span className="lab">Report</span>
          <div className="flow-item">
            <span className="lab faint">{REPORT[a.report][0]}</span>
            <span>
              {a.report === "thread" || a.report === "worth" ? `${REPORT[a.report][1]}, ${placePhrase(atlas, a.to)}.` : REPORT[a.report][1]}
            </span>
          </div>
        </div>
      </div>

      {test && (
        <div className="panel" style={{ marginTop: 16 }}>
          <span className="lab">Test run · {shortDay(test.at)} · sent nothing</span>
          <p style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{test.ok ? test.text : `Didn't work: ${test.error}`}</p>
          {test.results.map((r, i) => (
            <p key={i} className="faint small">
              {r.ok ? "✓" : "×"} {r.step}: {r.text.slice(0, 200)}
            </p>
          ))}
        </div>
      )}

      <div className="flow-foot">
        <div>
          <span className="lab">Allowed</span>
          <div className="row" style={{ gap: 6, margin: "8px 0" }}>
            {webhooksUsed.map((w) => (
              <span key={w} className={`tag ${a.state === "on" ? "ok" : ""}`}>
                {a.state === "on" ? "✓ " : ""}
                {w}
              </span>
            ))}
            {!webhooksUsed.length && <span className="faint small">Nothing beyond Atlas.</span>}
          </div>
          <p className="faint small">
            {webhooksUsed.length
              ? a.state === "on"
                ? "While it's on, it calls these without asking: you saw them when you turned it on."
                : "When you turn it on, it may call these without asking."
              : "Anything an Atlas step wants to send asks you first, as usual."}
          </p>
          <span className="lab" style={{ display: "block", marginTop: 14 }}>
            Made
          </span>
          <p className="small" style={{ marginTop: 6 }}>
            {a.made_by === "owner"
              ? "By you, in the form."
              : a.made_by === "default"
                ? "One of Atlas's default routines. Change it, pause it or delete it as you like."
                : "By Atlas, from what you said."}
          </p>
          {onDeleted && (
            <p className="small" style={{ marginTop: 14 }}>
              {deleting ? (
                <>
                  Delete {a.name}? Its runs stay in History.{" "}
                  <button
                    className="link err"
                    onClick={() => {
                      atlas.send({ type: "atlas.automation.delete", id: a.id });
                      onDeleted();
                    }}
                  >
                    Delete
                  </button>{" "}
                  <button className="link" onClick={() => setDeleting(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="link" onClick={() => setDeleting(true)}>
                  Delete this automation
                </button>
              )}
            </p>
          )}
        </div>
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="lab">Runs</span>
            <RunStrip a={a} />
            <span className="grow" />
            <span className="lab faint">{real.length ? `Last ${Math.min(12, real.length)}` : ""}</span>
          </div>
          <div className="rows">
            {real.map((r) => (
              <div key={r.id} className="r small" style={{ alignItems: "flex-start" }}>
                <span className="mono" style={{ width: 92, flex: "none" }}>
                  {shortDay(r.at)}
                </span>
                <span className="mono faint" style={{ width: 44, flex: "none" }}>
                  {r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : ""}
                </span>
                <span className={`grow ${r.ok ? "" : "err"}`} style={{ minWidth: 0 }}>
                  {r.quiet ? `Looked: ${r.text}` : r.ok ? `✓ ${r.text.split("\n")[0]!.slice(0, 120)}` : `× ${r.error}`}
                </span>
                <span className="mono faint" style={{ flex: "none" }}>
                  {r.quiet ? "" : r.brain ? `${r.tokens} tok` : "no brain"}
                </span>
              </div>
            ))}
            {!real.length && <p className="faint small">No runs yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- the form (§13.4: build it by hand) ------------------------------------------------------

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** The form's trigger choices: the five kinds, with events split into another automation and the calendar. */
type Choice = Exclude<Trigger["kind"], "event"> | "after" | "calendar";
const choiceOf = (t: Trigger): Choice => (t.kind === "event" ? (t.on === "calendar" ? "calendar" : "after") : t.kind);

const blankTrigger = (kind: Choice): Trigger =>
  kind === "calendar"
    ? { kind: "event", on: "calendar", about: "" }
    : kind === "after"
      ? { kind: "event", on: "automation", after: "" }
      : kind === "request"
        ? { kind, phrase: "" }
        : kind === "schedule"
          ? { kind, at: "08:00", days: [1, 2, 3, 4, 5] }
          : kind === "watch"
            ? { kind, url: "https://", every_hours: 6, matters: "" }
            : { kind, nothing_about: "", for_days: 3, at: "20:00" };

/** A suggestion as a first draft: on request, with the owner's own words as its phrase and as Atlas's note. */
function fromSuggestion(said: string): AutomationInput {
  const words = said.replace(/[?.!]+$/, "").trim();
  return {
    name: (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 60),
    about: "",
    when: { kind: "request", phrase: words.toLowerCase().slice(0, 80) },
    do: [{ kind: "atlas", instructions: `The owner asked: "${words}". Do that, the way you have before.` }],
    report: "thread",
  };
}

function AutomationForm({
  atlas,
  a,
  start,
  done,
}: {
  atlas: Atlas;
  a: AutomationView | null;
  start?: AutomationInput;
  done: (id?: string, saved?: boolean) => void;
}) {
  const others = (atlas.state.automations ?? []).filter((x) => x.id !== a?.id);
  const webhooks = atlas.state.view?.webhooks ?? [];
  const [f, setF] = useState<AutomationInput>(() =>
    a
      ? { name: a.name, about: a.about, when: a.when, do: a.steps.map((s) => s.step), report: a.report, to: a.to }
      : (start ?? { name: "", about: "", when: blankTrigger("request"), do: [{ kind: "say", text: "" }], report: "thread" }),
  );
  const t = f.when;
  const setT = (p: Partial<Trigger>) => setF({ ...f, when: { ...t, ...p } as Trigger });
  const setStep = (i: number, s: Step) => setF({ ...f, do: f.do.map((x, j) => (j === i ? s : x)) });
  const problem = !f.name.trim()
    ? "Give it a name."
    : f.do.some((s) => (s.kind === "say" ? !s.text.trim() : s.kind === "webhook" ? !s.webhook : !s.instructions.trim()))
      ? "Every step needs its words, webhook or instructions."
      : t.kind === "watch" && (!/^https:\/\/./.test(t.url) || !t.matters.trim())
        ? "A watch needs an https address and what change matters."
        : t.kind === "absence" && !t.nothing_about.trim()
          ? "Say what words would show it happened."
          : t.kind === "event" && t.on === "automation" && !t.after
            ? "Pick the automation it runs after."
            : null;
  const clean = (): AutomationInput => ({
    ...f,
    name: f.name.trim(),
    when:
      t.kind === "request"
        ? { kind: "request", ...(t.phrase?.trim() ? { phrase: t.phrase.trim() } : {}) }
        : t.kind === "event" && t.on === "calendar"
          ? { kind: "event", on: "calendar", ...(t.about?.trim() ? { about: t.about.trim() } : {}) }
          : t,
  });
  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (problem) return;
        atlas.send({ type: "atlas.automation.save", ...(a ? { id: a.id } : {}), automation: clean() });
        done(a?.id, true);
      }}
    >
      <div className="sheet-title">
        <h1 className="disp">{a ? `Edit ${a.name}` : "New automation"}</h1>
        <span className="muted">Made here, it starts on.</span>
      </div>
      <label className="field">
        <span>Name</span>
        <input value={f.name} maxLength={60} placeholder="Goodnight" onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label className="field">
        <span>What it's for</span>
        <input
          value={f.about}
          maxLength={300}
          placeholder="Lights off and a goodnight"
          onChange={(e) => setF({ ...f, about: e.target.value })}
        />
      </label>

      <span className="lab">When</span>
      <div className="row" style={{ gap: 6 }}>
        {(["request", "schedule", "watch", "absence", "calendar", "after"] as const).map((k) => (
          <button
            type="button"
            key={k}
            className={`btn sm ${choiceOf(t) === k ? "on" : ""}`}
            onClick={() => setF({ ...f, when: blankTrigger(k) })}
          >
            {
              {
                request: "On request",
                schedule: "On a schedule",
                watch: "Watch a page",
                absence: "When something doesn't happen",
                calendar: "When the calendar changes",
                after: "After another",
              }[k]
            }
          </button>
        ))}
      </div>
      {t.kind === "request" && (
        <label className="field">
          <span>Phrase (optional; words starting with $ are inputs)</span>
          <input
            value={t.phrase ?? ""}
            maxLength={80}
            placeholder="goodnight, or focus for $duration"
            onChange={(e) => setT({ phrase: e.target.value })}
          />
        </label>
      )}
      {t.kind === "schedule" && (
        <div className="row">
          <input type="time" value={t.at} onChange={(e) => e.target.value && setT({ at: e.target.value })} style={{ width: 130 }} />
          <select
            value={t.every_hours ?? 0}
            aria-label="How often in a day"
            onChange={(e) => {
              const every = Number(e.target.value);
              setT(every ? { every_hours: every, until: t.until ?? "20:00" } : { every_hours: undefined, until: undefined });
            }}
          >
            <option value={0}>Once</option>
            {[1, 2, 3, 4, 6].map((h) => (
              <option key={h} value={h}>
                Every {h} h
              </option>
            ))}
          </select>
          {t.every_hours ? (
            <label className="row small" style={{ gap: 6 }}>
              until
              <input type="time" value={t.until ?? "20:00"} onChange={(e) => e.target.value && setT({ until: e.target.value })} />
            </label>
          ) : null}
          {DAYS.map((d, i) => (
            <button
              type="button"
              key={i}
              className={`btn sm ${t.days.includes(i) ? "on" : ""}`}
              aria-label={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i]}
              onClick={() => setT({ days: t.days.includes(i) ? t.days.filter((x) => x !== i) : [...t.days, i].sort() })}
            >
              {d}
            </button>
          ))}
          <span className="faint small">No days picked means every day.</span>
        </div>
      )}
      {t.kind === "watch" && (
        <>
          <label className="field">
            <span>Page</span>
            <input value={t.url} className="mono" onChange={(e) => setT({ url: e.target.value })} />
          </label>
          <label className="field">
            <span>What change matters</span>
            <input
              value={t.matters}
              maxLength={300}
              placeholder="The price drops below $300"
              onChange={(e) => setT({ matters: e.target.value })}
            />
          </label>
          <label className="field" style={{ width: 200 }}>
            <span>Look every (hours)</span>
            <input
              type="number"
              min={1}
              max={168}
              value={t.every_hours}
              onChange={(e) => setT({ every_hours: Math.max(1, Number(e.target.value) || 6) })}
            />
          </label>
        </>
      )}
      {t.kind === "absence" && (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field grow">
            <span>Nothing about</span>
            <input
              value={t.nothing_about}
              maxLength={120}
              placeholder="workout"
              onChange={(e) => setT({ nothing_about: e.target.value })}
            />
          </label>
          <label className="field" style={{ width: 120 }}>
            <span>For (days)</span>
            <input
              type="number"
              min={1}
              max={60}
              value={t.for_days}
              onChange={(e) => setT({ for_days: Math.max(1, Number(e.target.value) || 1) })}
            />
          </label>
          <label className="field" style={{ width: 130 }}>
            <span>Check at</span>
            <input type="time" value={t.at} onChange={(e) => e.target.value && setT({ at: e.target.value })} />
          </label>
        </div>
      )}
      {t.kind === "event" && t.on === "calendar" && (
        <label className="field">
          <span>Only events about (optional)</span>
          <input
            value={t.about ?? ""}
            maxLength={120}
            placeholder="Riverside, or leave empty for any change"
            onChange={(e) => setT({ about: e.target.value })}
          />
          <span className="faint small">Atlas reads the next two weeks every half hour, and runs this once for each change it finds.</span>
        </label>
      )}
      {t.kind === "event" && t.on === "automation" && (
        <Picker
          label="After which automation"
          value={t.after ?? ""}
          options={[{ value: "", label: "After which automation?" }, ...others.map((o) => ({ value: o.id, label: o.name }))]}
          onPick={(after) => setT({ after })}
        />
      )}

      <span className="lab">Do</span>
      {f.do.map((s, i) => (
        <div key={i} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
          <span className="mono faint" style={{ paddingTop: 8 }}>
            {String(i + 1).padStart(2, "0")}
          </span>
          <Seg
            small
            label="What this step does"
            value={s.kind}
            options={[["say", "Say"], ...(webhooks.length ? [["webhook", "Webhook"] as const] : []), ["atlas", "Atlas does"]]}
            onChange={(k) =>
              setStep(
                i,
                k === "say"
                  ? { kind: k, text: "" }
                  : k === "webhook"
                    ? { kind: k, webhook: webhooks[0]?.name ?? "" }
                    : { kind: k, instructions: "" },
              )
            }
          />
          {s.kind === "say" && (
            <input
              className="grow"
              value={s.text}
              maxLength={1000}
              placeholder="Lights are off. Sleep well."
              onChange={(e) => setStep(i, { ...s, text: e.target.value })}
            />
          )}
          {s.kind === "webhook" && (
            <>
              <Picker
                label="Which webhook"
                value={s.webhook}
                options={webhooks.map((w) => ({ value: w.name, label: w.name }))}
                onPick={(webhook) => setStep(i, { ...s, webhook })}
              />
              <input
                className="grow"
                value={s.message ?? ""}
                placeholder="Message (optional)"
                onChange={(e) => setStep(i, { ...s, message: e.target.value || undefined })}
              />
            </>
          )}
          {s.kind === "atlas" && (
            <textarea
              className="grow"
              rows={2}
              maxLength={2000}
              value={s.instructions}
              placeholder="Look at today's calendar and reminders and give me a three-line brief."
              onChange={(e) => setStep(i, { ...s, instructions: e.target.value })}
            />
          )}
          <button
            type="button"
            className="icon"
            aria-label="Remove step"
            disabled={f.do.length === 1}
            onClick={() => setF({ ...f, do: f.do.filter((_, j) => j !== i) })}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
      <div className="row">
        <button
          type="button"
          className="btn sm"
          disabled={f.do.length >= 12}
          onClick={() => setF({ ...f, do: [...f.do, { kind: "say", text: "" }] })}
        >
          <Icon name="plus" size={12} /> Add a step
        </button>
        <span className="faint small">Say and webhook steps run as written, with no model. An Atlas step uses judgment.</span>
      </div>

      <div className="field">
        <span>Report</span>
        <Picker
          label="Report"
          width={380}
          value={f.report}
          options={[
            { value: "thread", label: "Tell me", sub: "Every time it runs" },
            { value: "worth", label: "Tell me when it's worth it", sub: "It may stay quiet" },
            { value: "inbox", label: "Leave it in Inbox" },
            { value: "silent", label: "Only keep it in History" },
          ]}
          onPick={(report) => setF({ ...f, report: report as AutomationInput["report"] })}
        />
      </div>
      {/* Where only shows when there's more than one place to pick: a linked chat, or a device that takes notifications. */}
      {(f.report === "thread" || f.report === "worth") && places(atlas, f.to).length > 1 && (
        <div className="field">
          <span>Where</span>
          <Picker
            label="Where it tells you"
            width={380}
            value={f.to ?? "you"}
            options={places(atlas, f.to)}
            onPick={(to) => setF({ ...f, to })}
          />
        </div>
      )}

      <div className="row">
        <button className="btn primary" disabled={!!problem}>
          {a ? "Save" : "Make it"}
        </button>
        <button type="button" className="btn" onClick={() => done(a?.id)}>
          Cancel
        </button>
        {problem && <span className="faint small">{problem}</span>}
      </div>
    </form>
  );
}
