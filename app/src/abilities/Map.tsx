// Abilities → Map (§21.2, docs/ui §8): everything Atlas can do, live, built
// from what's installed and its state. Atlas in the middle, eight groups
// wired to it, each listing what it does and who does it (abilities/tree.ts).
// A group zooms into its tree, where each service opens with its options.
// Simple says it in plain words; Developer names models and ids.

import type { ReactNode } from "react";
import type { Atlas } from "../connection";
import { liveJobs } from "../jobs";
import { useDetail } from "../theme";
import { clock, Diamond, Icon, logoFor, LogoMark, type Place, StateDot } from "../ui";
import { type Card, type CardId, cards, jobState } from "./tree";
import { Zoomed, zoomFrom } from "./Zoom";

const EMPTY: Partial<Record<CardId, string>> = {
  skills: "None yet. Atlas writes one down after a task that took working out.",
};

export function AbilitiesMap({
  atlas,
  go,
  zoom,
  open,
}: {
  atlas: Atlas;
  go: (p: Place, d?: string) => void;
  /** The group zoomed into, if any. */
  zoom: string | null;
  /** Opens a group (or the map, with null) in the address, so back works. */
  open: (id: string | null) => void;
}) {
  const { at } = useDetail();
  const dev = at("developer");
  const s = atlas.state;
  const gs = cards(atlas, dev);
  const zoomed = gs.find((g) => g.id === zoom);
  if (zoomed) return <Zoomed atlas={atlas} card={zoomed} dev={dev} go={go} back={() => open(null)} />;
  const all = gs.flatMap((g) => g.jobs.map(jobState));
  const onCount = all.filter((x) => x === "on").length;
  const needs = all.filter((x) => x === "needs").length;
  const running = liveJobs(s.jobs).length;
  const next = s.agenda.filter((a) => a.state === "scheduled" && a.due_at > Date.now()).sort((a, b) => a.due_at - b.due_at)[0];
  const box = (g: Card) => (
    <button
      key={g.id}
      className={`card2 map-box ${g.id}`}
      onClick={(e) => {
        zoomFrom(e.currentTarget.getBoundingClientRect());
        open(g.id);
      }}
      aria-label={`${g.name}: open`}
    >
      <span className="row" style={{ flexWrap: "nowrap", gap: 8, width: "100%" }}>
        <Icon name={g.icon} size={14} style={{ color: "var(--tx2)" }} />
        <span style={{ fontWeight: 600 }}>{dev ? g.dev[0] : g.name}</span>
        {dev && <span className="aside">{g.dev[1]}</span>}
        <span className="grow" />
        <Icon name="right" size={12} style={{ color: "var(--tx3)" }} />
      </span>
      <span className={`map-items ${dev ? "dev" : ""}`}>
        {g.jobs.slice(0, 4).map((j) => {
          const on = j.hands.filter((h) => h.added);
          const first = on[0];
          return (
            <span className="map-item" key={j.id}>
              {first?.logo && logoFor(first.logo) ? (
                <LogoMark of={first.logo} size={15} />
              ) : (
                <Icon name={j.icon ?? first?.icon ?? g.icon} size={15} style={{ color: "var(--tx2)" }} />
              )}
              <span className="nm">{j.name}</span>
              <span className="by clip">
                {/* One part of Atlas's own says how it is; services and brains say who. */}
                {on.length === 1 && !first!.svc && !first!.logo ? first!.by : on.length ? on.map((h) => h.name).join(", ") : "nothing yet"}
              </span>
              <StateDot state={jobState(j)} />
            </span>
          );
        })}
        {g.jobs.length > 4 && <span className="aside map-item">and {g.jobs.length - 4} more</span>}
        {!g.jobs.length && <span className="aside map-item">{EMPTY[g.id] ?? "Nothing yet."}</span>}
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
