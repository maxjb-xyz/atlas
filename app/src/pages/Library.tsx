// Library (§5.5, §21.2): everything Atlas knows. Each record shows its
// source, can be corrected (the old value stays, struck through) and
// forgotten. Areas live here too, with their settings (§6.4, §21.3).

import { useEffect, useState } from "react";
import type { AreaView, RecordView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Composer } from "../Shell";
import { StageSheet } from "../StageViews";
import { AreaChip, areaColor, AreaDot, Empty, Icon, pressable, Sheet, shortDay, Stage } from "../ui";

type LibTab = "overview" | "people" | "places" | "memory" | "areas" | "files";

/** Asks for records under `ref`, and again whenever they change. */
function useRecords(atlas: Atlas, ref: string, q: { record_type?: RecordView["type"]; text?: string; limit?: number }) {
  const s = atlas.state;
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.records.list", ref, area: s.scope, ...(q as object), record_type: (q.record_type ?? "all") as never });
  }, [ref, s.scope, s.recordsVersion, q.record_type, q.text, atlas.voice.connected]);
  return s.records[ref];
}

export function Library({ atlas, detail, go }: { atlas: Atlas; detail: string; go: (d: string) => void }) {
  const s = atlas.state;
  // An area's or a person's page opens in place: "area:<id>" under Areas, "person:<id>" under People (§21.2).
  const [head, rest = ""] = [detail.split(":")[0]!, detail.split(":").slice(1).join(":")];
  const page = head === "area" || head === "person" || head === "page" || head === "file" ? { kind: head, id: rest } : null;
  const tab = (
    page
      ? page.kind === "area"
        ? "areas"
        : page.kind === "page" || page.kind === "file"
          ? "files"
          : "people"
      : ["overview", "people", "places", "memory", "areas", "files"].includes(head)
        ? head
        : "overview"
  ) as LibTab;
  const all = useRecords(atlas, "lib:all", { limit: 200 });
  const counts = all?.counts ?? {};

  return (
    <Stage
      label="Library"
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "people", label: "People", badge: counts.person || null },
        { id: "places", label: "Places", badge: counts.place || null },
        { id: "areas", label: "Areas", badge: s.areas.filter((a) => a.state !== "archived").length || null },
        { id: "memory", label: "Memory", badge: counts.all || null },
        { id: "files", label: "Pages & files", badge: (s.pages?.length ?? 0) + (s.files?.length ?? 0) || null },
      ]}
      tab={tab}
      onTab={(t) => go(t === "overview" ? "" : t)}
      meta={s.scope ? `Focused on ${s.areas.find((a) => a.id === s.scope)?.name ?? "an area"}` : "Every record keeps its source"}
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder="Ask what Atlas knows, or tell it something" />
        </div>
      }
    >
      {page && (
        <StageSheet
          atlas={atlas}
          shown={{
            id: detail,
            view:
              page.kind === "area"
                ? { kind: "area", area: page.id }
                : page.kind === "page"
                  ? { kind: "page", page: page.id }
                  : page.kind === "file"
                    ? { kind: "file", file: page.id }
                    : { kind: "person", person: page.id },
            title: "",
          }}
          onClose={() => go(page.kind === "area" ? "areas" : page.kind === "page" || page.kind === "file" ? "files" : "people")}
          onOpen={(v) => {
            if (v.kind === "person") go(`person:${v.person}`);
          }}
        />
      )}
      {!page && tab === "overview" && <Overview atlas={atlas} records={all?.records ?? []} counts={counts} go={go} />}
      {!page && tab === "people" && <Records atlas={atlas} type="person" title="People" go={go} />}
      {tab === "places" && <Records atlas={atlas} type="place" title="Places" go={go} />}
      {tab === "memory" && <Records atlas={atlas} title="Everything Atlas knows" focus={detail.split(":")[1]} search go={go} />}
      {!page && tab === "areas" && <Areas atlas={atlas} go={go} />}
      {!page && tab === "files" && <Pages atlas={atlas} go={go} />}
    </Stage>
  );
}

function Overview({
  atlas,
  records,
  counts,
  go,
}: {
  atlas: Atlas;
  records: RecordView[];
  counts: Record<string, number>;
  go: (d: string) => void;
}) {
  const s = atlas.state;
  const of = (t: string) => records.filter((r) => r.type === t).slice(0, 5);
  const others = records.filter((r) => !["person", "place", "preference", "note"].includes(r.type)).slice(0, 5);
  const corrections = records.reduce((n, r) => n + r.corrections, 0);
  const week = records.filter((r) => r.learned_at > Date.now() - 7 * 86_400_000).length;
  const areas = s.areas.filter((a) => a.state !== "archived");
  const maxArea = Math.max(1, ...areas.map((a) => a.messages + a.records));
  const total = counts.all ?? 0;

  const List = ({ list }: { list: RecordView[] }) => (
    <>
      {list.map((r) => (
        <div className="li" key={r.id}>
          <AreaDot area={s.areas.find((a) => r.areas.includes(a.id))} />
          <span>{r.name}</span>
          <span className="mono faint small">{shortDay(r.updated_at)}</span>
        </div>
      ))}
      {!list.length && <p className="faint small">None yet.</p>}
    </>
  );

  return (
    <Sheet>
      <div className="sheet-in">
        <div className="sheet-title">
          <h1 className="disp">Everything Atlas knows</h1>
          <span className="muted">
            {total} {total === 1 ? "record" : "records"} in one memory
          </span>
        </div>
        <div className="cells">
          <div className="cell">
            <span className="lab">
              <Icon name="people" size={13} />
              People<span className="count mono">{counts.person ?? 0}</span>
            </span>
            <List list={of("person")} />
          </div>
          <div className="cell">
            <span className="lab">
              <Icon name="place" size={13} />
              Places<span className="count mono">{counts.place ?? 0}</span>
            </span>
            <List list={of("place")} />
          </div>
          <div className="cell">
            <span className="lab">
              <Icon name="layers" size={13} />
              Areas<span className="count mono">{areas.length}</span>
            </span>
            {areas.slice(0, 5).map((a) => (
              <div className="li" key={a.id}>
                <AreaDot area={a} />
                <span>{a.name}</span>
                <span
                  style={{
                    width: 70,
                    height: 3,
                    background: areaColor(a),
                    transform: `scaleX(${(a.messages + a.records) / maxArea})`,
                    transformOrigin: "right",
                  }}
                />
                <span className="mono faint small" style={{ width: 30, textAlign: "right" }}>
                  {a.messages + a.records}
                </span>
              </div>
            ))}
            {!areas.length && <p className="faint small">Atlas starts areas as things come up.</p>}
          </div>
          <div className="cell">
            <span className="lab">
              <Icon name="grid" size={13} />
              Plans and tasks<span className="count mono">{others.length}</span>
            </span>
            <List list={others} />
          </div>
          <div className="cell">
            <span className="lab">
              <Icon name="memory" size={13} />
              Memory<span className="count mono">{total}</span>
            </span>
            <div className="li">
              <span className="dot sq" />
              <span>Facts and preferences</span>
              <span className="mono faint small">{(counts.preference ?? 0) + (counts.note ?? 0)}</span>
            </div>
            <div className="li">
              <span className="dot sq" />
              <span>Corrections kept</span>
              <span className="mono faint small">{corrections}</span>
            </div>
            <div className="li">
              <span className="dot sq" />
              <span>Learned this week</span>
              <span className="mono faint small">{week}</span>
            </div>
          </div>
          <div className="cell">
            <span className="lab">
              <Icon name="file" size={13} />
              Files<span className="count mono">0</span>
            </span>
            <p className="faint small">None yet.</p>
          </div>
        </div>
        <div className="section-rule">
          <span className="lab ac">■ Recently learned</span>
        </div>
        {!records.length && (
          <Empty title="Nothing learned yet">Tell Atlas something worth remembering, and it shows up here with where it came from.</Empty>
        )}
        <div className="rows">
          {records.slice(0, 8).map((r) => (
            <RecordRow key={r.id} atlas={atlas} r={r} go={go} />
          ))}
        </div>
        {records.length > 8 && (
          <p style={{ marginTop: 12 }}>
            <button className="link" onClick={() => go("memory")}>
              See everything
            </button>
          </p>
        )}
      </div>
    </Sheet>
  );
}

function sourceText(r: RecordView): string {
  if (r.source.text)
    return `${r.source.surface === "voice" ? "You said" : "You wrote"} ${r.source.at ? shortDay(r.source.at) : ""}: “${r.source.text}”`;
  if (r.source.via === "owner") return "You set it";
  if (r.source.via === "setup") return "From setup";
  if (r.source.via === "compaction") return "From an earlier conversation";
  return `From ${r.source.via}`;
}

/** One record: what Atlas knows, where it came from, its areas, and Correct. */
function RecordRow({ atlas, r, go }: { atlas: Atlas; r: RecordView; go: (d: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [fact, setFact] = useState(r.fact);
  const s = atlas.state;
  // A person, place or organization has a name and a fact; Correct edits the fact, not the name.
  const named = ["person", "place", "organization"].includes(r.type);
  return (
    <div className="r" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
      <div className="grow" style={{ minWidth: 220 }}>
        {editing ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              atlas.send({ type: "atlas.record.correct", id: r.id, fact });
              setEditing(false);
            }}
          >
            <input
              autoFocus
              maxLength={600}
              value={fact}
              placeholder={named ? `What Atlas should know about ${r.name}` : undefined}
              onChange={(e) => setFact(e.target.value)}
            />
            <button className="btn primary sm">Save</button>
            <button type="button" className="btn sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            {named ? (
              <p>
                <strong style={{ fontWeight: 500 }}>{r.name}</strong>
                {r.fact && <span className="muted"> · {r.fact}</span>}
              </p>
            ) : (
              <p>{r.fact || r.name}</p>
            )}
            {r.was && r.was.fact !== r.fact && (
              <p className="faint small">
                <s>{r.was.fact || r.was.name}</s> · corrected {shortDay(r.was.at)}
              </p>
            )}
          </>
        )}
        <p className="faint small" style={{ marginTop: 2 }}>
          <span className="lab">{r.type}</span> · {sourceText(r)}
        </p>
      </div>
      <AreaChip
        ids={r.areas}
        areas={s.areas}
        onMove={s.areas.length ? (ids) => atlas.send({ type: "atlas.areas.set", ref: `rec:${r.id}`, areas: ids }) : undefined}
      />
      <span className="mono faint small">{shortDay(r.updated_at)}</span>
      {!editing && (
        <span className="row" style={{ gap: 10 }}>
          {r.type === "person" && (
            <button className="link" onClick={() => go(`person:${r.id}`)}>
              Open
            </button>
          )}
          <button
            className="link"
            onClick={() => {
              setFact(named ? r.fact : r.fact || r.name);
              setEditing(true);
            }}
          >
            Correct
          </button>
          <button className="link" onClick={() => atlas.send({ type: "atlas.record.forget", id: r.id })}>
            Forget
          </button>
        </span>
      )}
    </div>
  );
}

function Records({
  atlas,
  type,
  title,
  focus,
  search,
  go,
}: {
  atlas: Atlas;
  type?: RecordView["type"];
  title: string;
  focus?: string;
  search?: boolean;
  go: (d: string) => void;
}) {
  const [text, setText] = useState("");
  const data = useRecords(atlas, `lib:${type ?? "memory"}`, { record_type: type, text: text.trim() || undefined, limit: 300 });
  const list = data?.records ?? [];
  useEffect(() => {
    if (focus) document.getElementById(`rec-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, list.length]);
  return (
    <Sheet>
      <div className="sheet-in">
        <div className="sheet-title">
          <h1 className="disp">{title}</h1>
          <span className="muted">{list.length}</span>
          <span className="grow" />
          {search && <input placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} style={{ width: 220 }} />}
        </div>
        {!list.length && (
          <Empty title="Nothing here yet">{text ? "Nothing matches." : "As you tell Atlas things, they show up here."}</Empty>
        )}
        <div className="rows">
          {list.map((r) => (
            <div key={r.id} id={`rec-${r.id}`} style={focus === r.id ? { outline: "1px solid var(--ac)", outlineOffset: 2 } : undefined}>
              <RecordRow atlas={atlas} r={r} go={go} />
            </div>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function Areas({ atlas, go }: { atlas: Atlas; go: (d: string) => void }) {
  const s = atlas.state;
  const [name, setName] = useState("");
  const live = s.areas.filter((a) => a.state !== "archived");
  const archived = s.areas.filter((a) => a.state === "archived");
  return (
    <Sheet>
      <div className="sheet-in">
        <div className="sheet-title">
          <h1 className="disp">Areas</h1>
          <span className="muted">One memory. Areas are lenses, not walls.</span>
        </div>
        {!live.length && (
          <Empty title="No areas yet">
            Atlas starts an area when things keep coming up that fit none, and says so once. You can add one too.
          </Empty>
        )}
        <div className="rows">
          {live.map((a) => (
            <AreaRow key={a.id} atlas={atlas} area={a} others={live.filter((x) => x.id !== a.id)} go={go} />
          ))}
        </div>
        <form
          className="row"
          style={{ marginTop: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            atlas.send({ type: "atlas.area.create", name: name.trim() });
            setName("");
          }}
        >
          <input
            placeholder="Add an area, like Keyframes or Gym"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <button className="btn" disabled={!name.trim()}>
            Add
          </button>
        </form>
        {archived.length > 0 && (
          <>
            <div className="section-rule">
              <span className="lab">Archived</span>
            </div>
            <div className="rows">
              {archived.map((a) => (
                <div className="r" key={a.id}>
                  <AreaDot area={a} />
                  <span className="grow muted">{a.name}</span>
                  <button className="link" onClick={() => atlas.send({ type: "atlas.area.update", id: a.id, state: "active" })}>
                    Bring back
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="faint small" style={{ marginTop: 18 }}>
          What leaves Atlas from each area (which account it sends from, who it's shared with, what Atlas does alone) is set here once those
          arrive.
        </p>
      </div>
    </Sheet>
  );
}

function AreaRow({ atlas, area, others, go }: { atlas: Atlas; area: AreaView; others: AreaView[]; go: (d: string) => void }) {
  const [open, setOpen] = useState(false);
  const saved = { name: area.name, about: area.about, tone: area.settings.tone };
  const [draft, setDraft] = useState(saved);
  // Typing marks the draft as the owner's; until then it follows the saved area as it changes.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setDraft(saved);
  }, [area.name, area.about, area.settings.tone]);
  const change = (p: Partial<typeof draft>) => {
    setDraft({ ...draft, ...p });
    setTyping(true);
  };
  const dirty = draft.name !== area.name || draft.about !== area.about || draft.tone !== area.settings.tone;
  return (
    <div className="r" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
      <div className="row" style={{ cursor: "pointer", flexWrap: "nowrap" }} {...pressable(() => setOpen(!open))} aria-expanded={open}>
        <AreaDot area={area} square />
        <span style={{ fontWeight: 500 }}>{area.name}</span>
        <span className="muted small grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {area.about}
        </span>
        {area.state === "dormant" && <span className="tag">Quiet</span>}
        <span className="mono faint small hide-phone">
          {area.messages} messages · {area.records} records
        </span>
        <Icon name="down" size={13} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </div>
      {open && (
        <div className="rise" style={{ display: "grid", gap: 10, paddingLeft: 18 }}>
          <label className="field">
            <span>Name</span>
            <input maxLength={60} value={draft.name} onChange={(e) => change({ name: e.target.value })} />
          </label>
          <label className="field">
            <span>What it is, and your role in it</span>
            <input
              maxLength={500}
              value={draft.about}
              onChange={(e) => change({ about: e.target.value })}
              placeholder="My video studio; I run it with Jordan"
            />
          </label>
          <label className="field">
            <span>Tone here</span>
            <input
              maxLength={300}
              value={draft.tone}
              onChange={(e) => change({ tone: e.target.value })}
              placeholder="Formal with clients"
            />
          </label>
          <div className="row">
            <button className="btn sm" onClick={() => go(`area:${area.id}`)}>
              Open
            </button>
            <button
              className="btn primary sm"
              disabled={!dirty || !draft.name.trim()}
              onClick={() => {
                atlas.send({
                  type: "atlas.area.update",
                  id: area.id,
                  name: draft.name,
                  about: draft.about,
                  settings: { tone: draft.tone },
                });
                setTyping(false);
              }}
            >
              Save
            </button>
            <span className="grow" />
            {others.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) atlas.send({ type: "atlas.area.merge", from: area.id, into: e.target.value });
                }}
                style={{ height: 24, fontSize: 12 }}
              >
                <option value="">Merge into…</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn sm"
              onClick={() => atlas.send({ type: "atlas.area.update", id: area.id, state: area.state === "dormant" ? "active" : "dormant" })}
            >
              {area.state === "dormant" ? "Wake" : "Quiet"}
            </button>
            <button className="btn sm" onClick={() => atlas.send({ type: "atlas.area.update", id: area.id, state: "archived" })}>
              Archive
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A file's size in the words people use. */
export const sizeOf = (n: number) =>
  n < 1_000 ? `${n} B` : n < 1_000_000 ? `${Math.round(n / 1_000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`;

const VIEW_WORD: Record<string, string> = {
  area: "area",
  person: "person",
  list: "list",
  table: "table",
  automation: "automation",
  draft: "draft",
  plan: "plan",
  research: "research",
  browser: "browser",
  file: "file",
  document: "document",
  code: "code",
  chart: "chart",
  compare: "comparison",
  kit: "view",
  app: "app",
  workspace: "workspace",
};

/** Pages Atlas made or you kept (§21.7). Files Atlas makes join them in M3. */
function Pages({ atlas, go }: { atlas: Atlas; go: (d: string) => void }) {
  const s = atlas.state;
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.pages" });
    atlas.send({ type: "atlas.files" });
  }, [atlas.voice.connected, s.rows.length]);
  const pages = s.pages;
  const files = s.files;
  return (
    <Sheet>
      <div className="sheet-in">
        <div className="sheet-title">
          <h1 className="disp">Pages</h1>
          <span className="muted">Things you keep: press Keep on a view, or ask Atlas to write one up.</span>
        </div>
        {pages == null ? (
          <p className="lab">Looking</p>
        ) : pages.length ? (
          <div className="rows">
            {pages.map((p) => (
              <div key={p.id} className="r pickable" {...pressable(() => go(`page:${p.id}`))} style={{ alignItems: "flex-start" }}>
                <Icon name="file" size={14} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{p.name}</span>
                  <span className="muted small clamp" style={{ display: "block" }}>
                    {p.preview || (p.views.length ? `A kept ${p.views.map((v) => VIEW_WORD[v] ?? v).join(", ")}` : "Empty")}
                  </span>
                </span>
                <span className="lab faint hide-phone">{p.made_by === "owner" ? "You" : "Atlas"}</span>
                <span className="mono faint small" style={{ flex: "none" }}>
                  v{p.version} · {shortDay(p.updated_at)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No pages yet">
            Press Keep on anything Atlas shows on the stage, or say "write up the Riverside shoot plan as a page". Pages keep their
            versions, and the areas and people in them stay current.
          </Empty>
        )}
        <div className="sheet-title" style={{ marginTop: 28 }}>
          <h2 className="disp">Files</h2>
          <span className="muted">What Atlas makes for you to download: spreadsheets, documents, PDFs.</span>
        </div>
        {files == null ? (
          <p className="lab">Looking</p>
        ) : files.length ? (
          <div className="rows">
            {files.map((f) => (
              <div key={f.id} className="r pickable" {...pressable(() => go(`file:${f.id}`))} style={{ alignItems: "flex-start" }}>
                <Icon name="file" size={14} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{f.name}</span>
                  {f.note && (
                    <span className="muted small clamp" style={{ display: "block" }}>
                      {f.note}
                    </span>
                  )}
                </span>
                <span className="lab faint hide-phone">{f.made_by === "owner" ? "You" : "Atlas"}</span>
                <span className="mono faint small" style={{ flex: "none" }}>
                  {sizeOf(f.size)} · {shortDay(f.updated_at)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted small">No files yet. Ask Atlas for one: "make a spreadsheet of my reminders this month".</p>
        )}
      </div>
    </Sheet>
  );
}
