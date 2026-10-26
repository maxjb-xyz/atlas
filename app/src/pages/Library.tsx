// Library (§5.5, §21.2): everything Atlas knows, except people, who have
// their own place (People). Each record shows its source, can be corrected
// (the old value stays, struck through) and forgotten, and opens on the
// stage. Areas live here too, with their settings, color and icon (§6.4, §21.3).

import { useEffect, useState } from "react";
import type { AreaView, RecordView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Composer } from "../Shell";
import { StageSheet } from "../StageViews";
import { fileBase64 } from "../settings/parts";
import { signedIn } from "../abilities/Services";
import { MoveIn } from "../movein/MoveIn";
import { AREA_ICON_PATHS, AreaChip, areaColor, AreaDot, Empty, Icon, Picker, pressable, Sheet, shortDay, Stage, Toggle } from "../ui";

type LibTab = "overview" | "places" | "memory" | "areas" | "files" | "movein";

/** Asks for records under `ref`, and again whenever they change. */
function useRecords(atlas: Atlas, ref: string, q: { record_type?: RecordView["type"]; text?: string; limit?: number; learned?: boolean }) {
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
  // A person opens in People now; an old link to one here goes there.
  useEffect(() => {
    if (head === "person" && rest) location.replace(`#/people/${encodeURIComponent(`person:${rest}`)}`);
    if (head === "people") location.replace("#/people");
  }, [head, rest]);
  const page = head === "area" || head === "place" || head === "page" || head === "file" ? { kind: head, id: rest } : null;
  const tab = (
    page
      ? page.kind === "area"
        ? "areas"
        : page.kind === "page" || page.kind === "file"
          ? "files"
          : "places"
      : ["overview", "places", "memory", "areas", "files", "movein"].includes(head)
        ? head
        : "overview"
  ) as LibTab;
  const all = useRecords(atlas, "lib:all", { limit: 200 });
  const counts = all?.counts ?? {};
  // For Move in's badge: what's waiting to be kept or dropped.
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.movein" });
  }, [atlas.voice.connected]);

  return (
    <Stage
      label="Library"
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "places", label: "Places", badge: counts.place || null },
        { id: "areas", label: "Areas", badge: s.areas.filter((a) => a.state !== "archived").length || null },
        { id: "memory", label: "Memory", badge: counts.all || null },
        { id: "files", label: "Pages & files", badge: (s.pages?.length ?? 0) + (s.files?.length ?? 0) || null },
        // Moving in (§23.3): what's waiting to be kept or dropped shows as its badge.
        { id: "movein", label: "Move in", badge: s.movein?.items.filter((i) => i.state === "new").length || null },
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
                    : { kind: "place", place: page.id },
            title: "",
          }}
          onClose={() => go(page.kind === "area" ? "areas" : page.kind === "page" || page.kind === "file" ? "files" : "places")}
          onOpen={(v) => {
            if (v.kind === "person") location.hash = `#/people/${encodeURIComponent(`person:${v.person}`)}`;
            if (v.kind === "place") go(`place:${v.place}`);
          }}
        />
      )}
      {!page && tab === "overview" && <Overview atlas={atlas} records={all?.records ?? []} counts={counts} go={go} />}
      {!page && tab === "places" && <Records atlas={atlas} type="place" title="Places" go={go} />}
      {tab === "memory" && <Records atlas={atlas} title="Everything Atlas knows" focus={detail.split(":")[1]} search go={go} />}
      {!page && tab === "areas" && <Areas atlas={atlas} go={go} />}
      {!page && tab === "files" && <Pages atlas={atlas} go={go} />}
      {!page && tab === "movein" && (
        <Sheet>
          <div className="sheet-in">
            <MoveIn atlas={atlas} />
          </div>
        </Sheet>
      )}
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
  // The newest places on their own: the list of everything is mostly people, so a place can fall outside it.
  const places = useRecords(atlas, "lib:places", { record_type: "place", limit: 5 })?.records ?? of("place");
  const others = records.filter((r) => !["person", "place", "preference", "note"].includes(r.type)).slice(0, 5);
  const corrections = records.reduce((n, r) => n + r.corrections, 0);
  // Imported contacts and addresses seen on mail aren't learning: these are what Atlas wrote down itself, newest first.
  const learned = useRecords(atlas, "lib:learned", { learned: true, limit: 100 })?.records ?? records.filter((r) => r.learned);
  const week = learned.filter((r) => r.learned_at > Date.now() - 7 * 86_400_000).length;
  const areas = s.areas.filter((a) => a.state !== "archived");
  const maxArea = Math.max(1, ...areas.map((a) => a.messages + a.records));
  const total = counts.all ?? 0;
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.pages" });
    atlas.send({ type: "atlas.files" });
  }, [atlas.voice.connected]);
  // What Atlas made or the owner kept, newest first: each opens where Pages & files opens it.
  const made = [
    ...(s.files ?? []).map((f) => ({ key: `file:${f.id}`, name: f.name, at: f.updated_at })),
    ...(s.pages ?? []).map((p) => ({ key: `page:${p.id}`, name: p.name, at: p.updated_at })),
  ].sort((a, b) => b.at - a.at);

  const List = ({ list }: { list: RecordView[] }) => (
    <>
      {list.map((r) => (
        <div className="li pickable" key={r.id} {...pressable(() => openRecord(r, go))}>
          <AreaDot area={s.areas.find((a) => r.areas.includes(a.id))} />
          <span>{r.name}</span>
          <span className="mono faint small" style={{ marginLeft: 8 }}>
            {shortDay(r.updated_at)}
          </span>
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
        <Portrait atlas={atlas} />
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
            <List list={places} />
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
              Pages and files<span className="count mono">{made.length}</span>
            </span>
            {made.length ? (
              made.slice(0, 5).map((m) => (
                <div className="li pickable" key={m.key} {...pressable(() => go(m.key))}>
                  <span className="dot sq" />
                  <span className="clamp">{m.name}</span>
                  <span className="mono faint small">{shortDay(m.at)}</span>
                </div>
              ))
            ) : (
              <p className="faint small">None yet.</p>
            )}
          </div>
        </div>
        <div className="section-rule">
          <span className="lab ac">■ Recently learned</span>
        </div>
        {!learned.length && (
          <Empty title="Nothing learned yet">
            Tell Atlas something worth remembering, and it shows up here with where it came from. Or{" "}
            <button className="link" onClick={() => go("movein")}>
              move in
            </button>{" "}
            what ChatGPT, Claude, Hermes or OpenClaw knew about you.
          </Empty>
        )}
        <div className="rows">
          {learned.slice(0, 8).map((r) => (
            <RecordRow key={r.id} atlas={atlas} r={r} go={go} />
          ))}
        </div>
        {learned.length > 8 && (
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
  if (r.source.via === "moving in") return r.source.from ? `Moved in from ${r.source.from}` : "Moved in";
  if (r.source.via === "compaction") return "From an earlier conversation";
  return `From ${r.source.via}`;
}

/** One record: what Atlas knows, where it came from, its areas, and Correct. */
/** Opens a record on the stage: a person in People, a place as its view here, anything else where it sits in Memory. */
function openRecord(r: RecordView, go: (d: string) => void) {
  if (r.type === "person") location.hash = `#/people/${encodeURIComponent(`person:${r.id}`)}`;
  else if (r.type === "place") go(`place:${r.id}`);
  else go(`memory:${r.id}`);
}

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
          {r.type === "person" && (r.channels?.length || (r.trust && r.trust !== "unknown")) ? (
            <span>
              {" "}
              · {[...(r.trust && r.trust !== "unknown" ? [r.trust] : []), ...(r.channels ?? []).map((c) => c.value)].join(" · ")}
            </span>
          ) : null}
          {(r.type === "place" || r.type === "organization") && (
            <span>
              {" "}
              ·{" "}
              {typeof r.details.lat === "number"
                ? `Pinned${typeof r.details.address === "string" ? `, ${r.details.address}` : ""}`
                : typeof r.details.address === "string"
                  ? `${r.details.address}, not pinned yet`
                  : "No address or pin yet"}
            </span>
          )}
        </p>
      </div>
      <AreaChip
        ids={r.areas}
        areas={s.areas}
        onMove={s.areas.length ? (ids) => atlas.send({ type: "atlas.areas.set", ref: `rec:${r.id}`, areas: ids }) : undefined}
      />
      <span className="mono faint small" style={{ marginLeft: 8 }}>
        {shortDay(r.updated_at)}
      </span>
      {!editing && (
        <span className="row" style={{ gap: 10 }}>
          {(r.type === "person" || r.type === "place") && (
            <button className="link" onClick={() => openRecord(r, go)}>
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
          {r.type !== "person" && (
            <button
              className="link"
              title="Faces covering its areas may share it with the people they talk to"
              onClick={() => atlas.send({ type: "atlas.record.share", id: r.id, shared: !r.shared })}
            >
              {r.shared ? "Shareable ✓" : "Shareable"}
            </button>
          )}
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
        <SharedAreas atlas={atlas} />
      </div>
    </Sheet>
  );
}

/**
 * Shared areas (§6, §7.1): an area the owner shares with members. Its
 * records live in the owner's Atlas; everyone who shares it sees them here,
 * and what Atlas keeps there shows for all of them.
 */
function SharedAreas({ atlas }: { atlas: Atlas }) {
  const shared = atlas.state.shared;
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.shared" });
  }, [atlas.voice.connected]);
  if (!shared?.length) return null;
  return (
    <>
      <div className="section-rule">
        <span className="lab">Shared</span>
      </div>
      {shared.map((a) => (
        <div key={a.id} style={{ marginBottom: 14 }}>
          <p>
            <b>{a.name}</b> <span className="muted small">with {a.with.join(", ")}</span>
          </p>
          <div className="rows">
            {a.records.map((r) => (
              <div className="r" key={r.id}>
                <span className="grow">
                  {r.name}
                  {r.fact && <span className="muted"> · {r.fact}</span>}
                </span>
                <span className="faint small">
                  {r.by} · {shortDay(r.updated_at)}
                </span>
              </div>
            ))}
            {!a.records.length && <p className="muted small">Nothing kept here yet.</p>}
          </div>
        </div>
      ))}
    </>
  );
}

/** A mail account in words: "Google · you@work.com". */
const accountLabel = (x: { name: string; account: string | null }) => (x.account ? `${x.name} · ${x.account}` : x.name);

function AreaRow({ atlas, area, others, go }: { atlas: Atlas; area: AreaView; others: AreaView[]; go: (d: string) => void }) {
  // With more than one mail account, an area can send from one of them (§6.2). A reply always goes from the one its mail came to.
  const mailAccounts = (atlas.state.view?.extensions ?? []).filter((x) => x.state === "on" && x.provides.includes("mail") && signedIn(x));
  const defaultMail = atlas.state.view?.settings.accounts.mail ?? "";
  // Every calendar account, whole, and each calendar in it, for an area to call its own.
  const providers = atlas.state.view?.calendar.providers ?? [];
  const accountOf = (id: string) => providers.find((p) => p.id === id);
  const calLabel = (ref: string) => {
    const [id, ...rest] = ref.split("::");
    const p = accountOf(id!);
    const who = p ? accountLabel(p) : id!;
    return rest.length ? `${rest.join("::")} (${who})` : `All of ${who}`;
  };
  const calendarRefs = providers.flatMap((p) => [
    { value: p.id, label: calLabel(p.id) },
    ...p.calendars.map((c) => ({ value: `${p.id}::${c}`, label: calLabel(`${p.id}::${c}`) })),
  ]);
  const [open, setOpen] = useState(false);
  // Only the owner shares areas, with members who've joined (§7.1).
  const members = atlas.state.view?.me ? [] : (atlas.state.view?.members ?? []).filter((m) => m.joined_at);
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
        <span style={{ fontWeight: 500, color: areaColor(area) }}>{area.name}</span>
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
        <div className="rise" style={{ display: "grid", gap: 12, paddingLeft: 18 }}>
          <AreaLook atlas={atlas} area={area} />
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
          {mailAccounts.length > 1 && (
            <div className="field">
              <span>New mail here goes from</span>
              <Picker
                label={`New mail in ${area.name} goes from`}
                value={mailAccounts.some((x) => x.id === area.settings.mail) ? area.settings.mail : ""}
                options={[
                  {
                    value: "",
                    label: `Your default (${accountLabel(mailAccounts.find((x) => x.id === defaultMail) ?? mailAccounts[0]!)})`,
                  },
                  ...mailAccounts.map((x) => ({ value: x.id, label: accountLabel(x) })),
                ]}
                onPick={(mail) => atlas.send({ type: "atlas.area.update", id: area.id, settings: { mail } })}
                width={320}
              />
            </div>
          )}
          {calendarRefs.length > 0 && (
            <div className="field">
              <span>Its calendars: their events are this area's, and new events here go on the first</span>
              <div className="row" style={{ gap: 6 }}>
                {area.settings.calendars.map((ref) => (
                  <span key={ref} className="tag">
                    {calLabel(ref)}
                    <button
                      className="icon"
                      aria-label={`Take ${calLabel(ref)} out of ${area.name}`}
                      onClick={() =>
                        atlas.send({
                          type: "atlas.area.update",
                          id: area.id,
                          settings: { calendars: area.settings.calendars.filter((x) => x !== ref) },
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {calendarRefs.some((r) => !area.settings.calendars.includes(r.value)) && (
                  <Picker
                    label={`Add a calendar to ${area.name}`}
                    value=""
                    options={[
                      { value: "", label: area.settings.calendars.length ? "Add another" : "Add a calendar" },
                      ...calendarRefs.filter((r) => !area.settings.calendars.includes(r.value)),
                    ]}
                    onPick={(ref) =>
                      ref &&
                      atlas.send({ type: "atlas.area.update", id: area.id, settings: { calendars: [...area.settings.calendars, ref] } })
                    }
                    width={320}
                  />
                )}
              </div>
            </div>
          )}
          {members.length > 0 && (
            <div className="field">
              <span>Shared with: they see and add to what's in it</span>
              <div className="lines">
                {members.map((m) => (
                  <div key={m.id} className="line">
                    <span className="grow">{m.name}</span>
                    <Toggle
                      on={area.settings.shared_with.includes(m.id)}
                      label={`Share with ${m.name}`}
                      onChange={(shared) => atlas.send({ type: "atlas.area.share", area: area.id, member: m.id, shared })}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
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
              <Picker
                label="Merge into another area"
                value={"" as string}
                options={[
                  { value: "", label: "Merge into…" },
                  ...others.map((o) => ({ value: o.id, label: o.name, lead: <AreaDot area={o} /> })),
                ]}
                onPick={(into) => into && atlas.send({ type: "atlas.area.merge", from: area.id, into })}
              />
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

/** An area's color and icon, which the owner picks (§6.4): a deep preset or any color, a line icon or a logo they upload. */
function AreaLook({ atlas, area }: { atlas: Atlas; area: AreaView }) {
  const [error, setError] = useState<string | null>(null);
  const look = (patch: Omit<Extract<Parameters<Atlas["send"]>[0], { type: "atlas.area.look" }>, "type" | "id">) =>
    atlas.send({ type: "atlas.area.look", id: area.id, ...patch });
  return (
    <div className="area-look">
      <div className="row" style={{ gap: 8 }}>
        <span className="small muted" style={{ width: 52 }}>
          Color
        </span>
        {Array.from({ length: 8 }, (_, i) => (
          <button
            key={i}
            className={`swatch ${!area.custom_color && area.color % 8 === i ? "on" : ""}`}
            style={{ background: `var(--a${i})` }}
            aria-label={`Color ${i + 1}`}
            aria-pressed={!area.custom_color && area.color % 8 === i}
            onClick={() => look({ color: i })}
          />
        ))}
        <label
          className={`swatch any ${area.custom_color ? "on" : ""}`}
          style={area.custom_color ? { background: area.custom_color } : undefined}
          title="Any color"
        >
          {!area.custom_color && <Icon name="plus" size={11} />}
          <input
            type="color"
            className="sr"
            aria-label="Any color"
            value={area.custom_color ?? "#f5a524"}
            onChange={(e) => look({ custom_color: e.target.value })}
          />
        </label>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className="small muted" style={{ width: 52 }}>
          Icon
        </span>
        <button
          className={`icon-pick ${!area.icon ? "on" : ""}`}
          aria-label="No icon"
          aria-pressed={!area.icon}
          onClick={() => look({ icon: null })}
        >
          <span className="dot sq" style={{ background: areaColor(area) }} />
        </button>
        {Object.entries(AREA_ICON_PATHS).map(([name, d]) => (
          <button
            key={name}
            className={`icon-pick ${area.icon === name ? "on" : ""}`}
            aria-label={name}
            aria-pressed={area.icon === name}
            onClick={() => look({ icon: name as never })}
          >
            <svg className="ic" width={14} height={14} viewBox="0 0 24 24" aria-hidden style={{ color: areaColor(area) }}>
              <path d={d} />
            </svg>
          </button>
        ))}
        <label className={`icon-pick wide ${area.icon?.startsWith("file:") ? "on" : ""}`} title="Upload a logo">
          {area.icon?.startsWith("file:") ? <AreaDot area={area} size={14} /> : <Icon name="up" size={12} />}
          <span className="small">Your logo</span>
          <input
            type="file"
            className="sr"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (f.size > 300_000) return setError(`That image is ${Math.round(f.size / 1000)} KB; a logo can be at most 300 KB.`);
              setError(null);
              look({ image: { name: f.name, type: f.type as never, data: await fileBase64(f) } });
            }}
          />
        </label>
      </div>
      {error && <p className="err small">{error}</p>}
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
  mcp_app: "app",
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
                {s.areas.length > 0 && (
                  <span onClick={(e) => e.stopPropagation()}>
                    <AreaChip
                      ids={f.areas ?? []}
                      areas={s.areas}
                      onMove={(ids) => atlas.send({ type: "atlas.areas.set", ref: `file:${f.id}`, areas: ids })}
                    />
                  </span>
                )}
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

/**
 * Atlas's portrait of the owner (§5.1): what it carries into every conversation, rewritten each night from what it
 * learned. The owner can read it and put it in their own words, which Atlas then keeps as true.
 */
function Portrait({ atlas }: { atlas: Atlas }) {
  const p = atlas.state.view?.portrait ?? null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p?.text ?? "");
  const name = atlas.state.view?.settings.assistant_name || "Atlas";
  return (
    <div className="portrait">
      <div className="row" style={{ alignItems: "baseline" }}>
        <span className="lab">What I carry about you</span>
        <span className="grow" />
        {p && !editing && <span className="mono faint small">{p.by === "owner" ? "In your words" : `Rewritten ${shortDay(p.at)}`}</span>}
        {!editing && (
          <button
            className="btn sm"
            onClick={() => {
              setText(p?.text ?? "");
              setEditing(true);
            }}
          >
            {p ? "Correct it" : "Write it"}
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea value={text} maxLength={2000} rows={6} onChange={(e) => setText(e.target.value)} autoFocus />
          <div className="row">
            <button
              className="btn sm primary"
              onClick={() => {
                atlas.send({ type: "atlas.portrait.set", text });
                setEditing(false);
              }}
            >
              Save
            </button>
            <button className="btn sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="faint small">{name} keeps your words as true, and adds what it learns each night.</span>
          </div>
        </>
      ) : p ? (
        <>
          <p className="portrait-text">{p.text}</p>
          {p.learned.length > 0 && (
            <ul className="portrait-learned">
              {p.learned.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted small">
          Nothing yet. Each night {name} writes down what it's learned about you from your conversations, and it shows here.
        </p>
      )}
    </div>
  );
}
