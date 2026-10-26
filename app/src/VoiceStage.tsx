// Voice, full screen (VISION §11.5 and §21.8, M7 W19, docs/ui/source/wow-pass.html move 3): while a call is on,
// the conversation gives way to the diamond, large and moving with the audio; the owner's words faint above;
// Atlas's words set large as they come; and what it looked up for this answer rising beneath them. "Show the
// conversation" goes back to the thread with the voice strip; the choice is kept on this device.

import { useEffect, useState } from "react";
import type { LogRow } from "../../core/src/protocol";
import type { Atlas } from "./connection";
import { type Shown, shownFrom, StageCard } from "./StageViews";
import { AsciiDiamond, type DiamondState, Icon } from "./ui";

const KEY = "atlas.voice.full";

/** Whether voice opens full screen on this device: yes on a wide screen until the owner says otherwise. */
export function voiceFullNow(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v != null) return v === "1";
  } catch {
    // Storage can be off; the default holds.
  }
  return window.matchMedia("(min-width: 900px)").matches;
}

export function useVoiceFull(): [boolean, (on: boolean) => void] {
  const [full, setFull] = useState<boolean>(voiceFullNow);
  return [
    full,
    (on) => {
      setFull(on);
      try {
        localStorage.setItem(KEY, on ? "1" : "0");
      } catch {
        // Not kept, but it still applies now.
      }
    },
  ];
}

const LABEL: Record<string, string> = {
  idle: "Starting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

export function VoiceStage({ atlas, onShrink, onOpen }: { atlas: Atlas; onShrink: () => void; onOpen: (s: Shown) => void }) {
  const s = atlas.state;
  const { status, interim, level } = atlas.voice;
  // The answer being spoken now, or the last one said aloud a moment ago.
  const live = Object.entries(s.live).find(([, l]) => l.surface === "voice" && !l.job);
  const lastOut = [...s.rows].reverse().find((r) => r.kind === "message.out" && r.surface === "voice");
  const lastIn = [...s.rows].reverse().find((r) => r.kind === "message.in" && r.surface === "voice");
  const run = live?.[0] ?? lastOut?.run_id ?? null;
  const spoken = live ? live[1].text : lastOut && Date.now() - lastOut.at < 60_000 ? String(lastOut.body.text ?? "") : "";
  const heard =
    status === "listening" && interim
      ? interim
      : lastIn && (!lastOut || lastIn.seq > lastOut.seq || live)
        ? String(lastIn.body.text ?? "")
        : "";
  // What it showed for this answer, as it arrives.
  const cards: Array<[LogRow, Shown]> = run
    ? s.rows
        .filter((r) => r.run_id === run && r.kind === "tool.result")
        .map((r) => [r, shownFrom(r)] as const)
        .filter((x): x is [LogRow, Shown] => x[1] != null)
    : [];
  // Words in, the newest few rising into place.
  const words = spoken
    .replace(/[*_`#>]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const [seen, setSeen] = useState(0);
  useEffect(() => setSeen(words.length), [words.length]);
  const state: DiamondState = status === "listening" || status === "thinking" || status === "speaking" ? status : "idle";

  return (
    <section className="voice-stage" aria-label="Voice">
      <div className="vs-top">
        <button className="btn sm" onClick={onShrink}>
          <Icon name="left" size={13} /> Show the conversation
        </button>
        <span className="grow" />
        <button className="btn sm" onClick={() => void atlas.toggleCall()}>
          End
        </button>
      </div>
      <div className="vs-mark">
        <AsciiDiamond height={260} level={level} state={state} />
      </div>
      <p className="vs-state lab">
        <i className={`vs-dot ${state}`} aria-hidden /> {LABEL[status] ?? "Listening"}
      </p>
      <p className="vs-heard">{heard}</p>
      <p className="vs-spoken disp" aria-live="polite">
        {words.map((w, i) => (
          <span key={i} className={i >= seen - 4 ? "fresh" : ""}>
            {w}{" "}
          </span>
        ))}
      </p>
      {cards.length > 0 && (
        <div className="vs-cards">
          {cards.slice(-3).map(([r, v]) => (
            <div key={r.id} className="vs-card">
              <StageCard atlas={atlas} shown={v} row={r} onOpen={() => onOpen(v)} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
