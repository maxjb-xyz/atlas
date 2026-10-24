// A group of the Abilities map, zoomed in (docs/ui §8): it grows out of its
// card into a tree. Down the left, what the group does; along each line, who
// does it, set up or there to add. A service opens under its line with its
// options, the same ones as on its card in Services, so they live in one place.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Atlas } from "../connection";
import { Icon, logoFor, LogoMark, type Place, StateDot } from "../ui";
import { AtlasEmail, Calendars, ChatLink, Location, Phone, SearchUse, SvcLogo, Webhooks } from "./Services";
import type { Card, Hand } from "./tree";

/** Where a card was on the map when it was opened, so the zoomed view grows out of it. */
let from: DOMRect | null = null;
export const zoomFrom = (r: DOMRect) => {
  from = r;
};
const takeZoomFrom = () => {
  const r = from;
  from = null;
  return r;
};

const still = () => document.documentElement.dataset.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Zoomed({
  atlas,
  card,
  dev,
  go,
  back,
}: {
  atlas: Atlas;
  card: Card;
  dev: boolean;
  go: (p: Place, d?: string) => void;
  back: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  // Grows out of the card it was opened from.
  useLayoutEffect(() => {
    const start = takeZoomFrom();
    const el = box.current;
    if (!start || !el || still()) return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;
    el.animate(
      [
        {
          transformOrigin: "top left",
          transform: `translate(${start.left - to.left}px, ${start.top - to.top}px) scale(${start.width / to.width}, ${Math.min(1, start.height / to.height)})`,
          opacity: 0.35,
        },
        { transformOrigin: "top left", transform: "none", opacity: 1 },
      ],
      { duration: 320, easing: "cubic-bezier(.2,.7,.2,1)" },
    );
  }, [card.id]);
  // Esc goes back to the whole map, unless a service is open; then it closes that first.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement | null)?.closest("input, textarea")) return;
      if (sel) setSel(null);
      else back();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [sel, back]);

  return (
    <div className="sheet-in zoom" ref={box}>
      <button className="back" onClick={back}>
        <Icon name="back" size={14} /> Everything Atlas can do
      </button>
      <div className="zoom-title">
        <span className="zoom-root">
          <Icon name={card.icon} size={18} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="disp" style={{ fontSize: 22 }}>
            {dev ? card.dev[0] : card.name}
          </span>
          <span className="muted small">{card.about}</span>
        </span>
        <span className="grow" />
        <button className="btn sm" onClick={() => go(card.open[0], card.open[1])}>
          {card.open[2]}
        </button>
      </div>
      <div className="tree">
        {card.jobs.map((j) => {
          const open = j.hands.find((h) => h.key === sel);
          return (
            <div className="tree-row" key={j.id}>
              <span className="tree-joint" aria-hidden />
              <div className="tree-job">
                <span className="h">{j.name}</span>
                <span className="aside">{j.about}</span>
              </div>
              <span className="tree-wire" aria-hidden />
              <div className="tree-hands">
                {j.hands.map((h) => (
                  <button
                    key={h.key}
                    className={`hand ${h.added ? "" : "add"} ${sel === h.key ? "on" : ""}`}
                    onClick={() => setSel(sel === h.key ? null : h.key)}
                    aria-expanded={sel === h.key}
                    title={h.added ? h.by : `Add ${h.name}`}
                  >
                    <HandMark h={h} />
                    <span className="hand-name">{h.name}</span>
                    {h.added ? <StateDot state={h.state} /> : <Icon name="plus" size={12} style={{ color: "var(--tx3)" }} />}
                  </button>
                ))}
                {!j.hands.length && j.empty && <span className="aside hand-empty">{j.empty}</span>}
                {j.add && (
                  <button className="hand add" onClick={() => go(j.add!.to[0], j.add!.to[1])}>
                    <Icon name="plus" size={12} />
                    <span className="hand-name">{j.add.label}</span>
                  </button>
                )}
              </div>
              {open && (
                <div className="fan rise">
                  <HandPanel atlas={atlas} h={open} go={go} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HandMark({ h, size = 16 }: { h: Hand; size?: number }) {
  if (h.svc) return <SvcLogo s={h.svc} size={size + 6} />;
  if (h.logo && logoFor(h.logo)) return <LogoMark of={h.logo} size={size} />;
  return <Icon name={h.icon ?? "plug"} size={size} style={{ color: "var(--tx2)" }} />;
}

/** What opens under a hand: its state and what it does, then its options, or how to add it. */
function HandPanel({ atlas, h, go }: { atlas: Atlas; h: Hand; go: (p: Place, d?: string) => void }) {
  const view = atlas.state.view!;
  const p = h.panel;
  const card = h.svc && !h.svc.builtin ? h.svc.key : null;
  return (
    <>
      <div className="fan-head">
        <HandMark h={h} size={22} />
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{h.name}</span>
          <span className="aside">
            {h.added ? (
              <>
                <StateDot state={h.state} /> {h.by}
              </>
            ) : (
              "Not set up"
            )}
          </span>
        </span>
        <span className="grow" />
        {card && (
          <button className="btn sm" onClick={() => go("abilities", `services:${card}`)}>
            {h.added ? "Everything about it" : "Set it up"}
          </button>
        )}
      </div>
      {h.svc && <p className="small fan-about">{h.svc.does}</p>}
      {/* Atlas's own parts (its email, webhooks, search) set up in their panel; a service, on its card. */}
      {(h.added || h.svc?.builtin) && p && (
        <div className="lines fan-body">
          {p.kind === "calendars" && <Calendars atlas={atlas} view={view} />}
          {p.kind === "phone" && <Phone atlas={atlas} view={view} />}
          {p.kind === "chat" && <ChatLink atlas={atlas} view={view} ext={p.ext} />}
          {p.kind === "location" && <Location atlas={atlas} view={view} />}
          {p.kind === "email" && <AtlasEmail atlas={atlas} view={view} />}
          {p.kind === "search" && <SearchUse atlas={atlas} view={view} id={p.id} />}
          {p.kind === "webhooks" && <Webhooks atlas={atlas} view={view} />}
          {p.kind === "note" && (
            <div className="line">
              <span className="grow small">{p.text}</span>
              {p.to && (
                <button className="btn sm" onClick={() => go(p.to![0], p.to![1])}>
                  {p.label ?? "Open"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {!h.added && !card && p?.kind === "note" && <p className="small fan-about">{p.text}</p>}
    </>
  );
}
