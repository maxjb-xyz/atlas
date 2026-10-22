// The stage's views (§21.6): area, person, list and table, each drawn from
// the contract the agent saved (core/src/stage.ts). Expanded is the view on
// a sheet; compact is the card an exchange or the transcript shows, which
// opens it on Home's stage. Library's area and person pages are these same
// views (§21.2).

import { useEffect } from "react";
import type { LogRow, RecordView } from "../../core/src/protocol";
import type { AreaPage, PersonPage, StageMessage, StageView } from "../../core/src/stage";
import type { Atlas } from "./connection";
import { AreaChip, AreaDot, Diamond, Empty, Icon, pressable, Sheet, shortDay } from "./ui";

/** A view on the stage: the receipt it came from (or a local id), the view, and its title. */
export interface Shown {
  id: string;
  view: StageView;
  title: string;
}

/** The view a receipt opens, when Atlas showed one. */
export function shownFrom(row: LogRow): Shown | null {
  const r = row.body.receipt as { text?: string; view?: StageView } | undefined;
  if (!r?.view || row.body.ok === false) return null;
  return { id: row.id, view: r.view, title: String(r.text ?? "").replace(/^Showing · /, "") };
}

/** The ref an area or person view asks for its page under, so every copy of one view shares it. */
export const pageRef = (v: StageView) => (v.kind === "area" ? `area:${v.area}` : v.kind === "person" ? `person:${v.person}` : null);

/** The live page behind an area or person view: undefined while it loads. Asked again when what it's built from changes. */
function usePage(atlas: Atlas, view: StageView) {
  const s = atlas.state;
  const ref = pageRef(view);
  useEffect(() => {
    if (ref && atlas.voice.connected) atlas.send({ type: "atlas.stage", ref, view });
  }, [ref, atlas.voice.connected, s.recordsVersion, s.areas, s.rows.length]);
  return ref ? s.stage[ref] : null;
}

/** The title a view goes by right now: an area keeps up with its renames. */
export function titleOf(atlas: Atlas, shown: Shown): string {
  if (shown.view.kind === "area") {
    const id = shown.view.area;
    return atlas.state.areas.find((a) => a.id === id)?.name ?? shown.title;
  }
  return shown.title;
}

// --- expanded: the view on a sheet ---------------------------------------------------------

export function StageSheet({
  atlas,
  shown,
  onOpen,
  onClose,
}: {
  atlas: Atlas;
  shown: Shown;
  /** Opens another view in place, such as a person from an area. */
  onOpen: (v: StageView, title: string) => void;
  onClose?: () => void;
}) {
  const v = shown.view;
  return (
    <Sheet className="pick" key={shown.id}>
      <div className={`sheet-in ${onClose ? "closable" : ""}`}>
        {v.kind === "area" && <AreaView atlas={atlas} view={v} onOpen={onOpen} onClose={onClose} />}
        {v.kind === "person" && <PersonView atlas={atlas} view={v} onOpen={onOpen} onClose={onClose} />}
        {v.kind === "list" && <ListView view={v} onClose={onClose} />}
        {v.kind === "table" && <TableView view={v} onClose={onClose} />}
      </div>
    </Sheet>
  );
}

function Close({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null;
  return (
    <button className="icon view-close" aria-label="Close this view" title="Close" onClick={onClose}>
      <Icon name="x" />
    </button>
  );
}

function Missing({ why, onClose }: { why: string; onClose?: () => void }) {
  return (
    <>
      <div className="sheet-title">
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      <Empty title="Not here any more">{why}</Empty>
    </>
  );
}

const Loading = () => <p className="lab">Looking</p>;

function AreaView({
  atlas,
  view,
  onOpen,
  onClose,
}: {
  atlas: Atlas;
  view: Extract<StageView, { kind: "area" }>;
  onOpen: (v: StageView, title: string) => void;
  onClose?: () => void;
}) {
  const page = usePage(atlas, view);
  if (page === undefined) return <Loading />;
  if (!page || page.kind === "missing") return <Missing why={page?.why ?? "That area isn't there any more."} onClose={onClose} />;
  if (page.kind !== "area") return null;
  const p: AreaPage = page;
  const area = atlas.state.areas.find((a) => a.id === p.area.id);
  const person = (r: RecordView) => onOpen({ kind: "person", person: r.id }, r.name);
  return (
    <>
      <div className="sheet-title">
        <AreaDot area={area} square />
        <h1 className="disp">{p.area.name}</h1>
        {p.area.state === "dormant" && <span className="tag">Quiet</span>}
        {p.area.state === "archived" && <span className="tag">Archived</span>}
        <span className="mono faint small">
          {p.counts.messages} {p.counts.messages === 1 ? "message" : "messages"} · {p.counts.records}{" "}
          {p.counts.records === 1 ? "record" : "records"}
        </span>
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      <p className={p.area.about ? "" : "muted"} style={{ marginBottom: 16, fontSize: 15 }}>
        {p.area.about || "Nothing written yet about what this area is. Add a line in Library → Areas."}
      </p>
      {p.area.tone && (
        <div className="kv" style={{ marginBottom: 16 }}>
          <span className="lab">Tone here</span>
          <span>{p.area.tone}</span>
        </div>
      )}
      <div className="cells">
        <Group icon="people" label="People" list={p.people} onPick={person} empty="No one yet." />
        <Group icon="grid" label="Plans and tasks" list={p.plans} empty="No plans yet." />
        <Group icon="place" label="Places and notes" list={[...p.places, ...p.notes]} empty="Nothing yet." />
      </div>
      <div className="section-rule">
        <span className="lab">Lately</span>
      </div>
      <Messages list={p.recent} empty="Nothing said about it yet." />
      <p className="small" style={{ marginTop: 16 }}>
        <a className="link" href="#/library/areas">
          Edit in Library
        </a>
      </p>
    </>
  );
}

function Group({
  icon,
  label,
  list,
  onPick,
  empty,
}: {
  icon: "people" | "grid" | "place";
  label: string;
  list: RecordView[];
  onPick?: (r: RecordView) => void;
  empty: string;
}) {
  return (
    <div className="cell">
      <span className="lab">
        <Icon name={icon} size={13} />
        {label}
        <span className="count mono">{list.length}</span>
      </span>
      {list.map((r) => (
        <div
          key={r.id}
          className={`li ${onPick ? "pickable" : ""}`}
          {...(onPick ? pressable(() => onPick(r)) : {})}
          title={r.fact || r.name}
        >
          <span className="dot sq" />
          <span>
            {r.name}
            {r.fact && r.fact !== r.name && <span className="muted"> · {r.fact}</span>}
          </span>
        </div>
      ))}
      {!list.length && <p className="faint small">{empty}</p>}
    </div>
  );
}

function Messages({ list, empty }: { list: StageMessage[]; empty: string }) {
  if (!list.length) return <p className="faint small">{empty}</p>;
  return (
    <div className="rows">
      {list.map((m) => (
        <div className="r small" key={m.id} style={{ alignItems: "flex-start" }}>
          <span className="lab" style={{ width: 44, flex: "none", paddingTop: 2 }}>
            {m.by === "owner" ? "You" : <Diamond size={12} />}
          </span>
          <span className="grow clamp">{m.text}</span>
          {m.surface === "voice" && <span className="tag hide-phone">Voice</span>}
          <span className="mono faint" style={{ flex: "none" }}>
            {shortDay(m.at)}
          </span>
        </div>
      ))}
    </div>
  );
}

function sourceLine(r: RecordView): string {
  const when = shortDay(r.learned_at);
  if (r.source.text) return `${r.source.surface === "voice" ? "You said" : "You wrote"}, ${when}: “${r.source.text}”`;
  if (r.source.via === "setup") return `From setup, ${when}`;
  if (r.source.via === "owner") return `You added it, ${when}`;
  return `From ${r.source.via}, ${when}`;
}

function PersonView({
  atlas,
  view,
  onOpen,
  onClose,
}: {
  atlas: Atlas;
  view: Extract<StageView, { kind: "person" }>;
  onOpen: (v: StageView, title: string) => void;
  onClose?: () => void;
}) {
  const page = usePage(atlas, view);
  if (page === undefined) return <Loading />;
  if (!page || page.kind === "missing") return <Missing why={page?.why ?? "Atlas doesn't have that person any more."} onClose={onClose} />;
  if (page.kind !== "person") return null;
  const p: PersonPage = page;
  const r = p.person;
  const s = atlas.state;
  const details = Object.entries(r.details).filter(([, v]) => v != null && v !== "");
  return (
    <>
      <div className="sheet-title">
        <Icon name="people" />
        <h1 className="disp">{r.name}</h1>
        <AreaChip
          ids={r.areas}
          areas={s.areas}
          onMove={s.areas.length ? (ids) => atlas.send({ type: "atlas.areas.set", ref: `rec:${r.id}`, areas: ids }) : undefined}
        />
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      <p className={r.fact ? "" : "muted"} style={{ marginBottom: 16, fontSize: 15 }}>
        {r.fact || "Atlas knows their name, and not much else yet."}
      </p>
      <div className="kv">
        {details.map(([k, v]) => (
          <span key={k} style={{ display: "contents" }}>
            <span className="lab">{k.replace(/_/g, " ")}</span>
            <span style={{ overflowWrap: "anywhere" }}>{typeof v === "string" ? v : JSON.stringify(v)}</span>
          </span>
        ))}
        <span className="lab">Learned</span>
        <span>{sourceLine(r)}</span>
        {r.corrections > 0 && (
          <>
            <span className="lab">Corrected</span>
            <span>
              {r.corrections} {r.corrections === 1 ? "time" : "times"}, last {shortDay(r.updated_at)}
            </span>
          </>
        )}
      </div>
      {p.links.length > 0 && (
        <>
          <div className="section-rule">
            <span className="lab">Linked</span>
          </div>
          <div className="rows">
            {p.links.map((l) => {
              const open = l.record.type === "person" ? () => onOpen({ kind: "person", person: l.record.id }, l.record.name) : null;
              return (
                <div key={l.record.id} className={`r small ${open ? "pickable" : ""}`} {...(open ? pressable(open) : {})}>
                  <span className="lab" style={{ width: 90, flex: "none" }}>
                    {l.kind.replace(/_/g, " ")}
                  </span>
                  <span className="grow">
                    {l.record.name}
                    {l.record.fact && <span className="muted"> · {l.record.fact}</span>}
                  </span>
                  <span className="lab faint hide-phone">{l.record.type}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="section-rule">
        <span className="lab">Where they came up</span>
      </div>
      <Messages list={p.mentions} empty="Not named in a conversation yet." />
      {p.history.length > 0 && (
        <>
          <div className="section-rule">
            <span className="lab">Before</span>
          </div>
          <div className="rows">
            {[...p.history].reverse().map((h) => (
              <div className="r small" key={h.at}>
                <span className="grow faint">
                  <s>{h.fact || h.name}</s>
                </span>
                <span className="lab">{h.reason}</span>
                <span className="mono faint">{shortDay(h.at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="small" style={{ marginTop: 16 }}>
        <a className="link" href={`#/library/memory:${encodeURIComponent(r.id)}`}>
          Correct in Library
        </a>
      </p>
    </>
  );
}

function ListView({ view, onClose }: { view: Extract<StageView, { kind: "list" }>; onClose?: () => void }) {
  const checklist = view.items.some((i) => i.done != null);
  return (
    <>
      <div className="sheet-title">
        <h1 className="disp">{view.title}</h1>
        <span className="muted">{view.items.length}</span>
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      {view.source && (
        <p className="lab faint" style={{ marginTop: -10, marginBottom: 12 }}>
          {view.source}
        </p>
      )}
      <div className="rows">
        {view.items.map((it, i) => (
          <div className="r" key={i} style={{ alignItems: "flex-start" }}>
            <span className="mono faint" style={{ width: 26, flex: "none", paddingTop: 1 }}>
              {checklist ? (it.done ? "[x]" : "[ ]") : view.numbered ? String(i + 1).padStart(2, "0") : "·"}
            </span>
            <span className="grow">
              <span className={it.done ? "faint" : ""} style={it.done ? { textDecoration: "line-through" } : undefined}>
                {it.text}
              </span>
              {it.note && (
                <span className="muted small" style={{ display: "block", marginTop: 2 }}>
                  {it.note}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function TableView({ view, onClose }: { view: Extract<StageView, { kind: "table" }>; onClose?: () => void }) {
  const numeric = view.columns.map((_, c) => view.rows.every((r) => r[c] == null || typeof r[c] === "number"));
  return (
    <>
      <div className="sheet-title">
        <h1 className="disp">{view.title}</h1>
        <span className="muted">
          {view.rows.length} {view.rows.length === 1 ? "row" : "rows"}
        </span>
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      {view.source && (
        <p className="lab faint" style={{ marginTop: -10, marginBottom: 12 }}>
          {view.source}
        </p>
      )}
      <div className="scroll-x">
        <table className="grid stage-table">
          <thead>
            <tr>
              {view.columns.map((c, i) => (
                <th key={i} className="lab" style={numeric[i] ? { textAlign: "right" } : undefined}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr key={i}>
                {view.columns.map((_, c) => (
                  <td key={c} className={numeric[c] ? "mono" : ""} style={numeric[c] ? { textAlign: "right" } : undefined}>
                    {r[c] == null ? <span className="faint">·</span> : <span className="cell-text">{String(r[c])}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// --- compact: the card in an exchange or the transcript --------------------------------------

const KIND: Record<StageView["kind"], string> = { area: "Area", person: "Person", list: "List", table: "Table" };

export function StageCard({ atlas, shown, onOpen }: { atlas: Atlas; shown: Shown; onOpen: () => void }) {
  const v = shown.view;
  const preview =
    v.kind === "list"
      ? v.items
          .slice(0, 3)
          .map((i) => i.text)
          .join(" · ") + (v.items.length > 3 ? ` · and ${v.items.length - 3} more` : "")
      : v.kind === "table"
        ? `${v.rows.length} ${v.rows.length === 1 ? "row" : "rows"} · ${v.columns.join(", ")}`
        : v.kind === "area"
          ? atlas.state.areas.find((a) => a.id === v.area)?.about || "Its people, plans and what was said lately."
          : "What Atlas knows about them, and where they came up.";
  return (
    <div className="stage-card rise">
      <span className="lab">
        {KIND[v.kind]}
        {v.kind === "list" ? ` · ${v.items.length}` : ""}
      </span>
      <p className="title">{titleOf(atlas, shown)}</p>
      <p className="muted small clamp">{preview}</p>
      <button className="link small" onClick={onOpen}>
        Open on the stage
      </button>
    </div>
  );
}

/** Opens a shown view on Home's stage, from anywhere. */
export const openOnStage = (id: string) => {
  location.hash = `/home/${encodeURIComponent(`view:${id}`)}`;
};
