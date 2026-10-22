// The stage's views (§21.6): area, person, list and table, each drawn from
// the contract the agent saved (core/src/stage.ts). Expanded is the view on
// a sheet; compact is the card an exchange or the transcript shows, which
// opens it on Home's stage. Library's area and person pages are these same
// views (§21.2).

import { useEffect, useRef, useState } from "react";
import type { Segment } from "../../core/src/pages";
import type { LogRow, RecordView } from "../../core/src/protocol";
import type { AreaPage, PagePage, PersonPage, StageMessage, StageView } from "../../core/src/stage";
import { Markdown } from "./Markdown";
import type { Atlas } from "./connection";
import { AreaChip, AreaDot, Diamond, Empty, Icon, pressable, Sheet, shortDay } from "./ui";
import { AutomationFlow } from "./pages/Automations";
import { AppFrame, ChartBody, CompareBody, KitBody } from "./ChartViews";
import { McpAppFrame } from "./McpApp";

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
  // There's one workspace and one browser: their tab goes by that, not by what was run or opened.
  if (r.view.kind === "workspace") return { id: row.id, view: r.view, title: "Workspace" };
  if (r.view.kind === "browser") return { id: row.id, view: r.view, title: "Browser" };
  // An MCP App goes by its tool's title.
  if (r.view.kind === "mcp_app") return { id: row.id, view: r.view, title: r.view.title };
  // "Showing · X", "Made page · X", "Changed page · X · version 2": the view goes by X.
  const title = String(r.text ?? "")
    .replace(/^(Showing|Made page|Changed page) · /, "")
    .replace(/ · version \d+$/, "");
  return { id: row.id, view: r.view, title };
}

/** The ref an area or person view asks for its page under, so every copy of one view shares it. */
export const pageRef = (v: StageView) =>
  v.kind === "area"
    ? `area:${v.area}`
    : v.kind === "person"
      ? `person:${v.person}`
      : v.kind === "automation"
        ? `automation:${v.automation}`
        : v.kind === "page"
          ? `page:${v.page}:${v.version ?? ""}`
          : v.kind === "browser"
            ? "browser"
            : v.kind === "file"
              ? `file:${v.file}`
              : v.kind === "workspace"
                ? "workspace"
                : null;

/** The live page behind an area or person view: undefined while it loads. Asked again when what it's built from changes. */
function usePage(atlas: Atlas, view: StageView) {
  const s = atlas.state;
  const ref = pageRef(view);
  useEffect(() => {
    if (ref && atlas.voice.connected) atlas.send({ type: "atlas.stage", ref, view });
  }, [ref, atlas.voice.connected, s.recordsVersion, s.areas, s.rows.length, s.automations]);
  return ref ? s.stage[ref] : null;
}

/** The title a view goes by right now: an area keeps up with its renames. */
export function titleOf(atlas: Atlas, shown: Shown): string {
  if (shown.view.kind === "area") {
    const id = shown.view.area;
    return atlas.state.areas.find((a) => a.id === id)?.name ?? shown.title;
  }
  if (shown.view.kind === "automation") {
    const id = shown.view.automation;
    return atlas.state.automations?.find((a) => a.id === id)?.name ?? shown.title;
  }
  if (shown.view.kind === "page") {
    const id = shown.view.page;
    return atlas.state.pages?.find((p) => p.id === id)?.name ?? shown.title;
  }
  if (shown.view.kind === "file") {
    const id = shown.view.file;
    return atlas.state.files?.find((f) => f.id === id)?.name ?? shown.title;
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
  const keep = v.kind !== "page" && v.kind !== "browser" && v.kind !== "file" && v.kind !== "workspace" && v.kind !== "mcp_app";
  return (
    <Sheet className="pick" key={shown.id}>
      <div className={`sheet-in ${onClose ? "closable" : ""} ${keep ? "keepable" : ""}`}>
        {keep && <Keep atlas={atlas} shown={shown} />}
        <ViewBody atlas={atlas} view={v} onOpen={onOpen} onClose={onClose} />
      </div>
    </Sheet>
  );
}

/** One view's content: on the stage's sheet, or inside a page. */
function ViewBody({
  atlas,
  view: v,
  onOpen,
  onClose,
}: {
  atlas: Atlas;
  view: StageView;
  onOpen: (v: StageView, title: string) => void;
  onClose?: () => void;
}) {
  return (
    <>
      {v.kind === "area" && <AreaView atlas={atlas} view={v} onOpen={onOpen} onClose={onClose} />}
      {v.kind === "person" && <PersonView atlas={atlas} view={v} onOpen={onOpen} onClose={onClose} />}
      {v.kind === "list" && <ListView view={v} onClose={onClose} />}
      {v.kind === "table" && <TableView view={v} onClose={onClose} />}
      {v.kind === "automation" && <AutomationStage atlas={atlas} view={v} onClose={onClose} />}
      {v.kind === "draft" && <DraftView view={v} onClose={onClose} />}
      {v.kind === "plan" && <PlanView view={v} onClose={onClose} />}
      {v.kind === "research" && <ResearchView view={v} onClose={onClose} />}
      {v.kind === "browser" && <BrowserView atlas={atlas} view={v} onClose={onClose} />}
      {v.kind === "file" && <FileView atlas={atlas} view={v} onClose={onClose} />}
      {v.kind === "document" && <DocumentView view={v} onClose={onClose} />}
      {v.kind === "code" && <CodeView view={v} onClose={onClose} />}
      {v.kind === "workspace" && <WorkspaceView atlas={atlas} view={v} onClose={onClose} />}
      {(v.kind === "chart" || v.kind === "compare" || v.kind === "kit" || v.kind === "app" || v.kind === "mcp_app") && (
        <>
          <div className="sheet-title">
            <Icon name="grid" />
            <h1 className="disp">{v.title}</h1>
            <span className="grow" />
            <Close onClose={onClose} />
          </div>
          {"source" in v && <Source text={v.source} />}
          {v.kind === "chart" && <ChartBody chart={v} />}
          {v.kind === "compare" && <CompareBody compare={v} />}
          {v.kind === "kit" && <KitBody kit={v} />}
          {v.kind === "app" && <AppFrame app={v} />}
          {v.kind === "mcp_app" && <McpAppFrame atlas={atlas} call={v.call} title={v.title} />}
        </>
      )}
      {v.kind === "page" && <PageView atlas={atlas} view={v} onOpen={onOpen} onClose={onClose} />}
    </>
  );
}

/** Keep: saves the view as a page, which lives in Library (§21.7). */
function Keep({ atlas, shown }: { atlas: Atlas; shown: Shown }) {
  const [asked, setAsked] = useState(false);
  const kept = asked ? atlas.state.kept : null;
  if (kept)
    return (
      <a className="link small view-keep" href={`#/library/${encodeURIComponent(`page:${kept.id}`)}`}>
        Kept · Open
      </a>
    );
  return (
    <button
      className="btn sm view-keep"
      disabled={asked}
      title="Keep this as a page in Library"
      onClick={() => {
        setAsked(true);
        atlas.send({ type: "atlas.page.keep", view: shown.view, name: titleOf(atlas, shown) || "Kept view" });
      }}
    >
      <Diamond size={11} /> Keep
    </button>
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

/** An automation on the stage: the same When → Do → Report flow as its page (§21.2: pages and views are one thing). */
function AutomationStage({
  atlas,
  view,
  onClose,
}: {
  atlas: Atlas;
  view: Extract<StageView, { kind: "automation" }>;
  onClose?: () => void;
}) {
  const page = usePage(atlas, view);
  if (page === undefined) return <Loading />;
  if (!page || page.kind !== "automation")
    return <Missing why={page?.kind === "missing" ? page.why : "That automation was deleted."} onClose={onClose} />;
  return (
    <>
      <div className="sheet-title">
        <a className="link small" href={`#/automations/${encodeURIComponent(`a:${page.automation.id}`)}`}>
          Open in Automations
        </a>
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      <AutomationFlow atlas={atlas} a={page.automation} />
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

function Source({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <p className="lab faint" style={{ marginTop: -10, marginBottom: 12 }}>
      {text}
    </p>
  );
}

/** Words for the owner to copy and send themselves (§21.6). Sending for them comes with the channels (M5). */
function DraftView({ view, onClose }: { view: Extract<StageView, { kind: "draft" }>; onClose?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="sheet-title">
        <Icon name="file" />
        <h1 className="disp">{view.title}</h1>
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      {view.for && (
        <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>
          {view.for}
        </p>
      )}
      <Source text={view.source} />
      <div className="panel draft-text">
        <Markdown text={view.text} />
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn sm"
          onClick={() =>
            void navigator.clipboard?.writeText(view.text).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <span className="faint small">Atlas doesn't send it: copy it, or ask for changes.</span>
      </div>
    </>
  );
}

const STEP_MARK = { done: "✓", doing: "▸", waiting: "…", todo: "○" } as const;
const STEP_WORD = { done: "Done", doing: "Under way", waiting: "Waiting", todo: "To do" } as const;

/** Steps toward something, each with where it stands (§21.6). */
function PlanView({ view, onClose }: { view: Extract<StageView, { kind: "plan" }>; onClose?: () => void }) {
  const done = view.steps.filter((s) => s.state === "done").length;
  return (
    <>
      <div className="sheet-title">
        <Icon name="grid" />
        <h1 className="disp">{view.title}</h1>
        <span className="muted">
          {done} of {view.steps.length} done
        </span>
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      <Source text={view.source} />
      <div className="rows">
        {view.steps.map((s, i) => (
          <div className="r" key={i} style={{ alignItems: "flex-start" }}>
            <span className={`mono plan-mark ${s.state}`} aria-label={STEP_WORD[s.state ?? "todo"]} title={STEP_WORD[s.state ?? "todo"]}>
              {STEP_MARK[s.state ?? "todo"]}
            </span>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className={s.state === "done" ? "faint" : ""}>{s.text}</span>
              {s.note && (
                <span className="muted small" style={{ display: "block", marginTop: 2 }}>
                  {s.note}
                </span>
              )}
            </span>
            {s.when && (
              <span className="lab faint" style={{ flex: "none" }}>
                {s.when}
              </span>
            )}
            {s.state === "waiting" && <span className="tag ac">Waiting</span>}
          </div>
        ))}
      </div>
    </>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** An answer from the web, with the pages it rests on (§21.6). Each source opens in a new tab. */
function ResearchView({ view, onClose }: { view: Extract<StageView, { kind: "research" }>; onClose?: () => void }) {
  return (
    <>
      <div className="sheet-title">
        <Icon name="search" />
        <h1 className="disp">{view.title}</h1>
        <span className="muted">
          {view.sources.length} {view.sources.length === 1 ? "source" : "sources"}
        </span>
        <span className="grow" />
        <Close onClose={onClose} />
      </div>
      <div className="panel research-answer">
        <Markdown text={view.answer} />
      </div>
      <p className="lab" style={{ marginTop: 16, marginBottom: 6 }}>
        Sources
      </p>
      <ol className="rows" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {view.sources.map((src, i) => (
          <li className="r" key={i} style={{ alignItems: "flex-start" }}>
            <span className="mono faint" style={{ flex: "none", width: 22 }}>
              {i + 1}
            </span>
            <span className="grow" style={{ minWidth: 0 }}>
              <a className="link" href={src.url} target="_blank" rel="noopener noreferrer">
                {src.title}
              </a>
              <span className="lab faint" style={{ display: "block", marginTop: 2 }}>
                {hostOf(src.url)}
              </span>
              {src.note && (
                <span className="muted small" style={{ display: "block", marginTop: 2 }}>
                  {src.note}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * Atlas's browser, live (§9.1). While Atlas drives, the frame is read-only;
 * Take over gives the owner one they can drive, for a login or a captcha,
 * and Hand back gives it to Atlas again, which carries on from there.
 */
function BrowserView({ atlas, view, onClose }: { atlas: Atlas; view: Extract<StageView, { kind: "browser" }>; onClose?: () => void }) {
  const page = usePage(atlas, view);
  const [shownAt, setShownAt] = useState(Date.now());
  // Live links last about five minutes: ask for a fresh one every four while it's on screen.
  useEffect(() => {
    const t = setInterval(() => {
      if (atlas.voice.connected) atlas.send({ type: "atlas.stage", ref: "browser", view });
      setShownAt(Date.now());
    }, 4 * 60_000);
    return () => clearInterval(t);
  }, [atlas.voice.connected]);
  const b = page && page.kind === "browser" ? page : null;
  const button = (action: "take" | "give" | "close") => atlas.send({ type: "atlas.browser", action });
  return (
    <>
      <div className="sheet-title">
        <Icon name="search" />
        <h1 className="disp clamp">{b?.title || "Browser"}</h1>
        <span className="grow" />
        {b?.open &&
          (b.taken ? (
            <button className="btn sm primary" onClick={() => button("give")}>
              Hand back
            </button>
          ) : (
            <button className="btn sm" onClick={() => button("take")}>
              Take over
            </button>
          ))}
        {b?.open && (
          <button className="btn sm" onClick={() => button("close")}>
            Close browser
          </button>
        )}
        <Close onClose={onClose} />
      </div>
      {b === null ? (
        <p className="muted">Opening the browser.</p>
      ) : !b.open ? (
        <p className="muted">
          {b.error ?? "The browser is closed. It closes by itself after ten minutes without use; ask Atlas to open a page."}
        </p>
      ) : (
        <>
          <p className="lab faint clamp" style={{ marginTop: -6, marginBottom: 10 }}>
            {b.url}
          </p>
          {b.taken && (
            <p className="banner rise" style={{ marginBottom: 10 }}>
              <span className="grow">{b.taken.why}. It's yours to drive; press Hand back when you're done.</span>
            </p>
          )}
          {b.live ? (
            <iframe
              key={`${b.live}-${shownAt}`}
              className="browser-live"
              src={b.live}
              title="Atlas's browser, live"
              allow="clipboard-read; clipboard-write"
            />
          ) : (
            <p className="err small">{b.error ?? "No live view right now."}</p>
          )}
        </>
      )}
    </>
  );
}

/**
 * Atlas's workspace (§9.1): what it's running now, as it prints; a terminal
 * of your own; its files, with Keep; the sites it may reach; and what ran
 * lately. Opening the terminal starts the workspace; looking doesn't.
 */
function WorkspaceView({ atlas, view, onClose }: { atlas: Atlas; view: Extract<StageView, { kind: "workspace" }>; onClose?: () => void }) {
  const page = usePage(atlas, view);
  const [terminal, setTerminal] = useState(false);
  const w = page && page.kind === "workspace" ? page : null;
  const live = atlas.state.workspaceOut;
  return (
    <>
      <div className="sheet-title">
        <Icon name="grid" />
        <h1 className="disp">Workspace</h1>
        {w && <span className={`tag ${w.running ? "ok" : ""}`}>{w.running ? "Running" : "Asleep"}</span>}
        <span className="grow" />
        {w?.available && w.running && (
          <button
            className="btn sm"
            title="Stops it now; the next command starts it fresh. Its files and setup are kept."
            onClick={() => {
              setTerminal(false);
              atlas.send({ type: "atlas.workspace.restart" });
            }}
          >
            Restart
          </button>
        )}
        {w?.available && (
          <button className="btn sm" onClick={() => setTerminal(!terminal)}>
            {terminal ? "Close terminal" : "Open terminal"}
          </button>
        )}
        <Close onClose={onClose} />
      </div>
      {w === null ? (
        <p className="lab">Looking</p>
      ) : !w.available ? (
        <p className="muted">{w.error ?? "This deployment has no workspace."}</p>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: -6 }}>
            Atlas's own computer: bash, Python and Node, with files in /workspace. It sleeps after ten minutes without use.
          </p>
          {terminal && <Terminal />}
          {live && !terminal && (
            <>
              <p className="lab" style={{ marginTop: 14 }}>
                Atlas, live
              </p>
              <pre className="code-block mono workspace-live">{live.text}</pre>
            </>
          )}
          <p className="lab" style={{ marginTop: 16 }}>
            Files
          </p>
          {w.files === null ? (
            <p className="faint small">The workspace is asleep; its files show when it's running.</p>
          ) : w.files.length === 0 ? (
            <p className="faint small">/workspace is empty.</p>
          ) : (
            <div className="rows">
              {w.files.slice(0, 120).map((f) => (
                <div className="r" key={f.path}>
                  <span className="mono small grow clamp">
                    {f.path}
                    {f.dir ? "/" : ""}
                  </span>
                  {!f.dir && <span className="mono faint small">{sizeOf(f.size)}</span>}
                  {!f.dir && (
                    <button className="link small" onClick={() => atlas.send({ type: "atlas.workspace.keep", path: f.path })}>
                      Keep
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="lab" style={{ marginTop: 16 }}>
            Websites it can reach
          </p>
          {w.sites.length ? (
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {w.sites.map((s) => (
                <span key={s} className="tag">
                  {s}{" "}
                  <button className="link small" onClick={() => atlas.send({ type: "atlas.workspace.site.remove", site: s })}>
                    Remove
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="faint small">None yet. Atlas asks you before the workspace reaches any website.</p>
          )}
          {w.runs.length > 0 && (
            <>
              <p className="lab" style={{ marginTop: 16 }}>
                Lately
              </p>
              <div className="rows">
                {w.runs.map((r) => (
                  <details className="r workspace-run" key={`${r.id}-${r.at}`}>
                    <summary className="row" style={{ flexWrap: "nowrap" }}>
                      <span className={`mono small ${r.exit === 0 ? "" : "err"}`} style={{ flex: "none" }}>
                        {r.exit === 0 ? "✓" : `✗ ${r.exit ?? ""}`}
                      </span>
                      <span className="mono small grow clamp">{r.command.split("\n")[0]}</span>
                      <span className="lab faint" style={{ flex: "none" }}>
                        {shortDay(r.at)}
                      </span>
                    </summary>
                    <pre className="code-block mono">{r.error ?? (r.output || "(nothing printed)")}</pre>
                  </details>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

/** A terminal into the workspace: a shell of your own (tmux), over a WebSocket through the Worker. */
function Terminal() {
  const box = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState("Connecting…");
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let gone = false;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      await import("@xterm/xterm/css/xterm.css");
      if (gone) return;
      const css = getComputedStyle(document.documentElement);
      const term = new XTerm({
        fontFamily: "Geist Mono, ui-monospace, monospace",
        fontSize: 13,
        cursorBlink: true,
        theme: {
          background: css.getPropertyValue("--win").trim(),
          foreground: css.getPropertyValue("--tx").trim(),
          cursor: css.getPropertyValue("--ac").trim(),
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/workspace/terminal?cols=${term.cols}&rows=${term.rows}`,
      );
      ws.binaryType = "arraybuffer";
      ws.onopen = () => setState("");
      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = (e) => setState(e.reason || "The terminal closed.");
      const enc = new TextEncoder();
      const typed = term.onData((d) => ws.readyState === 1 && ws.send(enc.encode(d)));
      const resized = term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ cols, rows })));
      const onWindow = () => fit.fit();
      window.addEventListener("resize", onWindow);
      term.focus();
      cleanup = () => {
        window.removeEventListener("resize", onWindow);
        typed.dispose();
        resized.dispose();
        ws.close();
        term.dispose();
      };
    })();
    return () => {
      gone = true;
      cleanup();
    };
  }, []);
  return (
    <>
      {state && <p className="faint small">{state}</p>}
      <div className="terminal-box" ref={box} />
    </>
  );
}

/** A copy button that says it worked. */
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** A write-up to read (§21.6): a document in Markdown, on the sheet. */
function DocumentView({ view, onClose }: { view: Extract<StageView, { kind: "document" }>; onClose?: () => void }) {
  return (
    <>
      <div className="sheet-title">
        <Icon name="file" />
        <h1 className="disp">{view.title}</h1>
        <span className="grow" />
        <CopyButton text={view.text} />
        <Close onClose={onClose} />
      </div>
      <Source text={view.source} />
      <div className="document-text">
        <Markdown text={view.text} />
      </div>
    </>
  );
}

/** Code (§21.6), with its language and a copy button. */
function CodeView({ view, onClose }: { view: Extract<StageView, { kind: "code" }>; onClose?: () => void }) {
  return (
    <>
      <div className="sheet-title">
        <Icon name="file" />
        <h1 className="disp">{view.title}</h1>
        <span className="tag">{view.language}</span>
        <span className="grow" />
        <CopyButton text={view.code} />
        <Close onClose={onClose} />
      </div>
      <Source text={view.source} />
      <pre className="code-block mono">
        <code>{view.code}</code>
      </pre>
    </>
  );
}

const sizeOf = (n: number) => (n < 1_000 ? `${n} B` : n < 1_000_000 ? `${Math.round(n / 1_000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`);

/** A file Atlas made (§21.7): what it is, Download, and a look inside when the stage can show it. */
function FileView({ atlas, view, onClose }: { atlas: Atlas; view: Extract<StageView, { kind: "file" }>; onClose?: () => void }) {
  const page = usePage(atlas, view);
  if (page === undefined) return <p className="lab">Opening</p>;
  if (!page || page.kind !== "file")
    return (
      <>
        <div className="sheet-title">
          <h1 className="disp">A file</h1>
          <span className="grow" />
          <Close onClose={onClose} />
        </div>
        <p className="muted">{page?.kind === "missing" ? page.why : "That file isn't there."}</p>
      </>
    );
  const { file: f, preview: p } = page;
  return (
    <>
      <div className="sheet-title">
        <Icon name="file" />
        <h1 className="disp clamp">{f.name}</h1>
        <span className="muted">{sizeOf(f.size)}</span>
        <span className="grow" />
        <a className="btn sm" href={f.url} download={f.name}>
          Download
        </a>
        <Close onClose={onClose} />
      </div>
      <p className="lab faint" style={{ marginTop: -6, marginBottom: 10 }}>
        {f.made_by === "owner" ? "Yours" : "Made by Atlas"} · {shortDay(f.updated_at)}
        {f.note ? ` · ${f.note}` : ""}
      </p>
      {p.kind === "table" && (
        <div className="scroll-x">
          <table className="grid stage-table">
            <thead>
              <tr>
                {p.columns.map((c, i) => (
                  <th key={i} className="lab">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r, i) => (
                <tr key={i}>
                  {p.columns.map((_, j) => (
                    <td key={j}>
                      <span className="cell-text">{r[j] ?? ""}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.kind === "text" &&
        (f.type === "text/markdown" ? (
          <div className="document-text">
            <Markdown text={p.text} />
          </div>
        ) : (
          <pre className="code-block mono">
            <code>{p.text}</code>
          </pre>
        ))}
      {p.kind === "image" && <img className="file-image" src={`${f.url}?inline=1`} alt={f.name} />}
      {p.kind === "pdf" && <iframe className="browser-live" src={`${f.url}?inline=1`} title={f.name} />}
      {p.kind === "none" && (
        <p className="muted small">The stage can't show a .{f.name.split(".").pop()} file. Download it to open it in its app.</p>
      )}
      {"more" in p && p.more && <p className="faint small">That's the start of it; download it for the rest.</p>}
    </>
  );
}

/** A view's name in a page's editor, where views can be moved out but not rewritten. */
function viewLabel(atlas: Atlas, v: StageView): string {
  if (v.kind === "area") return atlas.state.areas.find((a) => a.id === v.area)?.name ?? "An area";
  if (v.kind === "person") return "A person";
  if (v.kind === "automation") return atlas.state.automations?.find((a) => a.id === v.automation)?.name ?? "An automation";
  if (v.kind === "page") return "A page";
  if (v.kind === "browser") return "The browser";
  if (v.kind === "workspace") return "The workspace";
  if (v.kind === "file") return atlas.state.files?.find((f) => f.id === v.file)?.name ?? "A file";
  return v.title;
}

const bodyOf = (parts: Segment[]) =>
  parts
    .filter((s) => s.kind === "view" || s.text.trim())
    .map((s) => (s.kind === "text" ? s.text.trim() : "```view\n" + JSON.stringify(s.view) + "\n```"))
    .join("\n\n");

/**
 * A page you keep (§21.7): its text, and the views kept in it, which open
 * as they are now when they point at what Atlas knows. Edit changes the
 * text and can take views out; Versions lists every version and brings
 * one back as a new version.
 */
function PageView({
  atlas,
  view,
  onOpen,
  onClose,
}: {
  atlas: Atlas;
  view: Extract<StageView, { kind: "page" }>;
  onOpen: (v: StageView, title: string) => void;
  onClose?: () => void;
}) {
  const page = usePage(atlas, view);
  const [editing, setEditing] = useState<{ name: string; parts: Segment[] } | null>(null);
  const [versions, setVersions] = useState(false);
  const [shownN, setShownN] = useState<number | undefined>(view.version);
  const [deleting, setDeleting] = useState(false);
  const old = usePage(atlas, { kind: "page", page: view.page, ...(shownN ? { version: shownN } : {}) });
  if (page === undefined) return <Loading />;
  if (!page || page.kind !== "page")
    return <Missing why={page?.kind === "missing" ? page.why : "That page was deleted."} onClose={onClose} />;
  const p: PagePage["page"] = (old && old.kind === "page" ? old : page).page;
  const latest = p.shown.n === p.version;

  if (editing) {
    const set = (i: number, s: Segment | null) =>
      setEditing({ ...editing, parts: editing.parts.flatMap((x, j) => (j === i ? (s ? [s] : []) : [x])) });
    return (
      <>
        <div className="sheet-title">
          <input
            className="disp grow"
            value={editing.name}
            maxLength={80}
            aria-label="Page name"
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            style={{ fontSize: 22 }}
          />
          <Close onClose={onClose} />
        </div>
        <div className="page-edit">
          {editing.parts.map((s, i) =>
            s.kind === "text" ? (
              <textarea
                key={i}
                value={s.text}
                rows={Math.min(16, Math.max(3, s.text.split("\n").length + 1))}
                onChange={(e) => set(i, { kind: "text", text: e.target.value })}
              />
            ) : (
              <div key={i} className="page-chip row">
                <span className="lab">{KIND[s.view.kind]}</span>
                <span className="grow">{viewLabel(atlas, s.view)}</span>
                <button className="link small" onClick={() => set(i, null)}>
                  Take out
                </button>
              </div>
            ),
          )}
          <button className="btn sm" onClick={() => setEditing({ ...editing, parts: [...editing.parts, { kind: "text", text: "" }] })}>
            <Icon name="plus" size={12} /> Add text
          </button>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button
            className="btn primary"
            disabled={!editing.name.trim()}
            onClick={() => {
              atlas.send({ type: "atlas.page.save", id: p.id, name: editing.name.trim(), body: bodyOf(editing.parts) });
              setEditing(null);
              setShownN(undefined);
            }}
          >
            Save as version {p.version + 1}
          </button>
          <button className="btn" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <span className="faint small">Markdown works in the text. For bigger changes, ask Atlas.</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="sheet-title">
        <Diamond size={14} />
        <h1 className="disp">{p.name}</h1>
        <span className="tag">v{p.shown.n}</span>
        <span className="grow" />
        <div className="row" style={{ gap: 6 }}>
          {latest && (
            <button
              className="btn sm"
              onClick={() => setEditing({ name: p.name, parts: p.segments.length ? p.segments : [{ kind: "text", text: "" }] })}
            >
              Edit
            </button>
          )}
          <button className={`btn sm ${versions ? "on" : ""}`} onClick={() => setVersions(!versions)}>
            Versions · {p.versions.length}
          </button>
        </div>
        <Close onClose={onClose} />
      </div>
      <p className="lab faint" style={{ marginTop: -10, marginBottom: 12 }}>
        Version {p.shown.n} · {p.shown.by === "owner" ? "you" : "Atlas"} · {shortDay(p.shown.at)}
        {p.shown.note ? ` · ${p.shown.note}` : ""}
      </p>
      {!latest && (
        <div className="panel row" style={{ marginBottom: 14 }}>
          <span className="grow small">This is an older version. The newest is version {p.version}.</span>
          <button
            className="btn sm"
            onClick={() => {
              atlas.send({ type: "atlas.page.restore", id: p.id, version: p.shown.n });
              setShownN(undefined);
            }}
          >
            Bring this one back
          </button>
          <button className="link small" onClick={() => setShownN(undefined)}>
            Newest
          </button>
        </div>
      )}
      {versions && (
        <div className="rows" style={{ marginBottom: 16 }}>
          {p.versions.map((v) => (
            <div
              key={v.n}
              className={`r small pickable ${v.n === p.shown.n ? "on" : ""}`}
              {...pressable(() => setShownN(v.n === p.version ? undefined : v.n))}
            >
              <span className="mono" style={{ width: 34, flex: "none" }}>
                v{v.n}
              </span>
              <span className="grow">{v.note}</span>
              <span className="lab faint">{v.by === "owner" ? "You" : "Atlas"}</span>
              <span className="mono faint">{shortDay(v.at)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="page-body">
        {p.segments.map((s, i) =>
          s.kind === "text" ? (
            <Markdown key={i} text={s.text} />
          ) : (
            <div key={i} className="page-view">
              <ViewBody atlas={atlas} view={s.view} onOpen={onOpen} />
            </div>
          ),
        )}
        {!p.segments.length && <p className="muted">Nothing on this page yet.</p>}
      </div>
      <p className="small" style={{ marginTop: 18 }}>
        {deleting ? (
          <>
            Delete {p.name} and all its versions?{" "}
            <button
              className="link err"
              onClick={() => {
                atlas.send({ type: "atlas.page.delete", id: p.id });
                onClose?.();
              }}
            >
              Delete
            </button>{" "}
            <button className="link" onClick={() => setDeleting(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button className="link faint" onClick={() => setDeleting(true)}>
            Delete this page
          </button>
        )}
      </p>
    </>
  );
}

// --- compact: the card in an exchange or the transcript --------------------------------------

const KIND: Record<StageView["kind"], string> = {
  area: "Area",
  person: "Person",
  list: "List",
  table: "Table",
  automation: "Automation",
  draft: "Draft",
  plan: "Plan",
  page: "Page",
  research: "Research",
  browser: "Browser",
  file: "File",
  document: "Document",
  code: "Code",
  workspace: "Workspace",
  chart: "Chart",
  compare: "Compare",
  kit: "View",
  app: "App",
  mcp_app: "App",
};

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
          : v.kind === "automation"
            ? atlas.state.automations?.find((a) => a.id === v.automation)?.when_text || "When it runs, what it does, and where it reports."
            : v.kind === "draft"
              ? v.for || v.text.slice(0, 160)
              : v.kind === "plan"
                ? `${v.steps.filter((s) => s.state === "done").length} of ${v.steps.length} done · ${v.steps
                    .filter((s) => s.state !== "done")
                    .slice(0, 2)
                    .map((s) => s.text)
                    .join(" · ")}`
                : v.kind === "page"
                  ? atlas.state.pages?.find((p) => p.id === v.page)?.preview || "A page you keep."
                  : v.kind === "browser"
                    ? "Atlas's browser, live."
                    : v.kind === "chart"
                      ? `${v.series.map((s) => s.name).join(", ")} · ${v.x.length} ${v.style === "bar" ? "bars" : "points"}`
                      : v.kind === "compare"
                        ? `${v.options.map((o) => o.name).join(" · ")}${v.pick ? ` · pick: ${v.pick}` : ""}`
                        : v.kind === "kit"
                          ? `${v.blocks.length} parts`
                          : v.kind === "app"
                            ? "A small app."
                            : v.kind === "mcp_app"
                              ? "A page from a connected service."
                              : v.kind === "workspace"
                                ? "Atlas's computer: its terminal and files."
                                : v.kind === "file"
                                  ? (atlas.state.files?.find((f) => f.id === v.file)?.note ?? "A file to open or download.")
                                  : v.kind === "document"
                                    ? v.text.slice(0, 160)
                                    : v.kind === "code"
                                      ? `${v.language} · ${v.code.split("\n").length} lines`
                                      : v.kind === "research"
                                        ? `${v.sources.length} ${v.sources.length === 1 ? "source" : "sources"} · ${v.sources
                                            .slice(0, 3)
                                            .map((x) => hostOf(x.url))
                                            .join(", ")}`
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
