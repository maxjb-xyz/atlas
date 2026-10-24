// Atlas settings → Notifications (§14, docs/ui §8): how Atlas reaches you
// when you aren't already talking. By urgency in plain sentences, quiet hours,
// the day's budget; speaking up, focus and each device in the details.

import { useEffect, useState } from "react";
import type { SettingsView } from "../../../core/src/protocol";
import type { Settings as SettingsT } from "../../../core/src/store/settings";
import type { Atlas } from "../connection";
import { deviceId, type PushState, pushState, subscribe, unsubscribe } from "../notify";
import { deviceName } from "../passkey";
import { useDetail } from "../theme";
import { Diamond, Icon, LogoMark, Picker, shortDay, Toggle } from "../ui";
import type { Edit } from "./index";
import { Head, TestRow, Words } from "./parts";

const PUSH_NOTE: Record<PushState, string> = {
  on: "Notifications are on for this device.",
  off: "Notifications are off on this device.",
  blocked: "This browser blocks notifications for Atlas. Allow them in the browser's settings, then come back.",
  install: "On iPhone and iPad, notifications need Atlas on the Home Screen: Share, then Add to Home Screen.",
  unsupported: "This browser can't take notifications.",
};

/** HH:mm as "10 pm". */
const hour = (hm: string) => {
  const [h = 0, m = 0] = hm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", ...(m ? { minute: "2-digit" } : {}) }).toLowerCase();
};
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

export function Notifications({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const { at } = useDetail();
  const [more, setMore] = useState(false);
  const details = more || at("detailed");
  const me = deviceId();
  const mine = view.push.devices.find((d) => d.id === me);
  const [browser, setBrowser] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void pushState().then(setBrowser);
  }, [view.push.devices.length]);
  // Subscribed in the browser but forgotten by Atlas (it was removed, or the push service dropped it) reads as off.
  const state: PushState | null = browser === "on" && !mine ? "off" : browser;
  const n = draft.notifications;
  const setN = (p: Partial<SettingsT["notifications"]>) => edit({ notifications: { ...n, ...p } });
  const quiet = n.quiet;
  const linked = view.channels.filter((c) => c.linked);
  const reach = n.reach === "push" ? null : linked.find((c) => c.ext === n.reach);
  const reachChip = (
    <Picker
      label="Where it reaches you"
      value={n.reach}
      options={[
        { value: "push", label: "a notification", sub: "On the device you used last", lead: <Icon name="bell" size={13} /> },
        ...linked.map((c) => ({
          value: c.ext,
          label: c.name,
          sub: `As ${c.linked!.name || "you"}`,
          lead: <LogoMark of={c.ext} size={13} />,
        })),
      ]}
      onPick={(r) => setN({ reach: r })}
      foot={linked.length ? undefined : "Link a chat in Abilities → Services, and it can reach you there too."}
    />
  );

  async function turnOn() {
    if (!view.push.public_key) return;
    setBusy(true);
    setError(null);
    const out = await subscribe(view.push.public_key);
    if ("error" in out) setError(out.error);
    else {
      atlas.send({
        type: "atlas.push.subscribe",
        device: me,
        name: deviceName(),
        origin: location.origin,
        subscription: out.sub as { endpoint: string; keys: { p256dh: string; auth: string } },
      });
    }
    setBrowser(await pushState());
    setBusy(false);
  }

  // Quiet hours as 24 cells from midnight, with the hour now marked.
  const [qf, qt] = [Number(quiet.from.slice(0, 2)), Number(quiet.to.slice(0, 2))];
  const inQuiet = (h: number) => quiet.on && (qf <= qt ? h >= qf && h < qt : h >= qf || h < qt);
  const nowH = new Date().getHours();
  const budget = n.budget;

  return (
    <>
      <Head
        title="Notifications"
        sub="How Atlas reaches you when you aren't already talking."
        right={
          state === "on" ? (
            <TestRow
              label="Send a test"
              k="push"
              atlas={atlas}
              run={() => atlas.test("push", { type: "atlas.test", what: "push", device: me })}
            />
          ) : undefined
        }
      />
      {/* TODO(core, stage 7): Atlas's suggestions from how you react ("You open Telegram faster than notifications"). */}
      {state && state !== "on" && (
        <div className="card2 suggest">
          <Diamond size={14} />
          <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontWeight: 500 }}>{PUSH_NOTE[state]}</span>
            <span className="aside">{state === "off" ? "Turn them on and Atlas can reach you here when it isn't open." : ""}</span>
          </div>
          {state === "off" && (
            <button className="btnp s" disabled={busy || !view.push.public_key} onClick={() => void turnOn()}>
              {busy ? "Waiting for the browser" : "Turn on here"}
            </button>
          )}
        </div>
      )}
      {error && <p className="err small">{error}</p>}

      {/* TODO(core, stage 7): a list of channels per urgency, tried in order, with escalation. Today one place serves both. */}
      <div className="lines solid urgency">
        <div className="urg">
          <div className="urg-name">
            <span className="disp">Now</span>
            <span className="aside">Reminders and answers</span>
          </div>
          <p className="say">
            When something can't wait, like a reminder you set or an answer to what you asked, Atlas sends {reachChip} at once, even in
            quiet hours.
          </p>
        </div>
        <div className="urg">
          <div className="urg-name">
            <span className="disp">Soon</span>
            <span className="aside">{view.push.today} today</span>
          </div>
          <p className="say">
            Job reports, approvals and what Atlas notices go to {reach ? reach.name : "a notification"} too, unless quiet hours, focus or
            the day's budget hold them.
          </p>
        </div>
        <div className="urg">
          <div className="urg-name">
            <span className="disp">Later</span>
            <span className="aside">In Inbox</span>
          </div>
          <p className="say">Everything else waits in Inbox and History until you next open Atlas.</p>
        </div>
      </div>
      <p className="aside" style={{ margin: "10px 0 16px" }}>
        With Atlas open in front of you, or in a voice call, messages just arrive there.
      </p>

      <div className="two">
        <div className="card2 pad">
          <div className="row">
            <span className="h2 grow">Quiet hours</span>
            <Toggle on={quiet.on} label="Quiet hours" onChange={(on) => setN({ quiet: { ...quiet, on } })} />
          </div>
          <div className="row" style={{ gap: 6, margin: "10px 0 4px" }}>
            <span>From</span>
            <Picker
              label="Quiet from"
              width={140}
              value={quiet.from}
              options={HOURS.map((h) => ({ value: h, label: hour(h) }))}
              onPick={(from) => setN({ quiet: { ...quiet, from } })}
            />
            <span>to</span>
            <Picker
              label="Quiet until"
              width={140}
              value={quiet.to}
              options={HOURS.map((h) => ({ value: h, label: hour(h) }))}
              onPick={(to) => setN({ quiet: { ...quiet, to } })}
            />
          </div>
          <span className="small muted">{quiet.on ? "Only what can't wait gets through." : "Off: things reach you at any hour."}</span>
          <div className="hours" aria-hidden>
            {Array.from({ length: 24 }, (_, h) => (
              <i key={h} className={h === nowH ? "n" : inQuiet(h) ? "f" : ""} />
            ))}
          </div>
          <div className="row aside" style={{ justifyContent: "space-between" }}>
            <span>Midnight</span>
            <span>Noon</span>
            <span>Midnight</span>
          </div>
        </div>
        <div className="card2 pad">
          <div className="row">
            <span className="h2 grow">Interruptions</span>
            <span className="stepper">
              <button aria-label="Fewer" disabled={budget <= 1} onClick={() => setN({ budget: Math.max(1, (budget || 11) - 1) })}>
                <Icon name="minus" size={12} />
              </button>
              <span>{budget ? `${budget} a day` : "No limit"}</span>
              <button aria-label="More" disabled={budget === 0} onClick={() => setN({ budget: budget >= 50 ? 0 : budget + 1 })}>
                <Icon name="plus" size={12} />
              </button>
            </span>
          </div>
          <div className="row" style={{ alignItems: "baseline", margin: "8px 0 6px" }}>
            <span className="disp" style={{ fontSize: 22 }}>
              {view.push.today}
            </span>
            <span className="muted">{budget ? `of ${budget} so far today` : "so far today"}</span>
          </div>
          {budget > 0 && (
            <div className="mtr" aria-hidden>
              {Array.from({ length: budget }, (_, i) => (
                <i key={i} className={i < view.push.today ? "f" : ""} />
              ))}
            </div>
          )}
          <span className="aside" style={{ marginTop: 8, display: "block" }}>
            Past it, things that could wait stay in the app. Reminders and answers don't count.
          </span>
        </div>
      </div>

      {!details && (
        <div className="row" style={{ marginTop: 16 }}>
          <span className="muted small">Speaking up, focus, and each device are in the details.</span>
          <button className="btn s" onClick={() => setMore(true)}>
            Show details
          </button>
        </div>
      )}
      {details && (
        <>
          <div className="set-sub">
            <span className="h2">Speaking up</span>
            <span className="aside">What Atlas tells you on its own.</span>
          </div>
          <div className="lines">
            <div className="line">
              <span className="grow">What it notices: where you're heading, your calendar, traffic, the weather, your devices</span>
              <Toggle
                on={draft.speaking.noticing}
                label="What it notices"
                onChange={(noticing) => edit({ speaking: { ...draft.speaking, noticing } })}
              />
            </div>
            <div className="line">
              <span className="grow">When to leave for events with a place</span>
              <Toggle
                on={draft.speaking.leave}
                label="When to leave"
                onChange={(leave) => edit({ speaking: { ...draft.speaking, leave } })}
              />
            </div>
          </div>
          <div className="two" style={{ marginTop: 12 }}>
            <Words
              label="Always bring up"
              empty={'Nothing yet. Asking "why didn\'t you tell me?" adds what you meant.'}
              placeholder="Like: anything from my landlord"
              list={draft.speaking.tell_about}
              set={(tell_about) => edit({ speaking: { ...draft.speaking, tell_about } })}
            />
            <Words
              label="Don't bring up"
              empty={'Nothing yet. Saying "stop" to a nudge adds what you meant.'}
              placeholder="Like: the weather unless it's severe"
              list={draft.speaking.quiet_about}
              set={(quiet_about) => edit({ speaking: { ...draft.speaking, quiet_about } })}
            />
          </div>

          <div className="set-sub">
            <span className="h2">Focus</span>
            <span className="aside">Like quiet hours, for a while.</span>
          </div>
          {view.focus ? (
            <div className="row">
              <span>
                Focusing{view.focus.about ? ` on ${view.focus.about}` : ""} until {shortDay(view.focus.until)}.
              </span>
              <button className="btn s" onClick={() => atlas.send({ type: "atlas.focus", minutes: 0 })}>
                End focus
              </button>
            </div>
          ) : (
            <div className="row">
              {[30, 60, 120, 240].map((m) => (
                <button key={m} className="btn s" onClick={() => atlas.send({ type: "atlas.focus", minutes: m })}>
                  {m < 60 ? `${m} min` : `${m / 60} h`}
                </button>
              ))}
            </div>
          )}

          <div className="set-sub">
            <span className="h2">Devices that take notifications</span>
          </div>
          <div className="lines">
            {view.push.devices.map((d) => (
              <div className="line" key={d.id}>
                <span className="grow">
                  {d.name}
                  {d.id === me && <span className="muted"> · this one</span>}
                </span>
                <span className="aside">Used {shortDay(d.last_seen)}</span>
                {d.id === me ? (
                  <button
                    className="tbtn"
                    onClick={() => {
                      void unsubscribe().then(async () => setBrowser(await pushState()));
                      atlas.send({ type: "atlas.push.remove", device: me });
                    }}
                  >
                    Turn off here
                  </button>
                ) : (
                  <button className="tbtn" onClick={() => atlas.send({ type: "atlas.push.remove", device: d.id })}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            {!view.push.devices.length && <p className="aside line">No device takes notifications yet.</p>}
          </div>
          <div className="line">
            <span className="grow">When Atlas isn't open, send a notification to the device you used last</span>
            <Toggle on={n.push} label="Send notifications" onChange={(push) => setN({ push })} />
          </div>
        </>
      )}
    </>
  );
}
