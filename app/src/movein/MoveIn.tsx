// Moving in (§23.3, §22 step 7): where to get each export in a sentence or
// two, the file or folder taken by a drop or a pick and opened on this
// device, the reading as it goes, then what Atlas learned, grouped, each to
// keep or drop. Nothing is saved until it's kept. Contacts come in from
// People's own import, offered here too.

import { useEffect, useRef, useState } from "react";
import type { MoveInItem, MoveInView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { useDetail } from "../theme";
import { Icon, Logo, LogoMark, logoFor } from "../ui";
import { fromDirectoryPicker, fromDrop, fromInput } from "./open";
import { send, type Sending } from "./send";
import "./movein.css";

type Reader = MoveInView["readers"][number];

/** A reader's short name, as on its card: "ChatGPT", not "ChatGPT export". */
const short = (r: Reader) => r.name.replace(/ export$/i, "");

const GROUPS: Array<[MoveInItem["kind"], string]> = [
  ["about", "About you"],
  ["preference", "How you like things"],
  ["person", "People"],
  ["project", "What you're working on"],
  ["skill", "Skills"],
];

const n = (x: number) => x.toLocaleString();
/** "ChatGPT, Claude and Hermes". */
const joined = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const mb = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

function ReaderLogo({ r, size = 34 }: { r: Reader; size?: number }) {
  if (logoFor(r.id) || !r.icon) return <Logo of={r.id} name={short(r)} size={size} />;
  return (
    <span className="logo" style={{ width: size, height: size, borderRadius: 8, overflow: "hidden" }}>
      <img
        className={`lg ${r.icon_invert ? "inv" : ""}`}
        src={r.icon}
        width={Math.round(size * 0.7)}
        height={Math.round(size * 0.7)}
        alt=""
      />
    </span>
  );
}

export function MoveIn({ atlas, setup = false }: { atlas: Atlas; setup?: boolean }) {
  const s = atlas.state;
  const v = s.movein;
  const { at } = useDetail();
  const [chosen, setChosen] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [more, setMore] = useState(false);
  const [finished, setFinished] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.movein" });
  }, [atlas.voice.connected]);

  if (!v) return <p className="lab">Looking</p>;
  const readers = v.readers;
  const reader = readers.find((r) => r.id === chosen) ?? null;
  const busy = sending != null || v.phase === "learning";
  const reviewing = v.items.length > 0 || v.phase === "learning" || v.phase === "paused" || v.phase === "review" || v.phase === "failed";
  const picking = !busy && (!reviewing || more);

  const take = async (items: Parameters<typeof send>[0]) => {
    if (!items.length) return;
    setError(null);
    setFinished(null);
    setMore(false);
    try {
      await send(items, readers, reader, (x) => setSending(x));
      atlas.send({ type: "atlas.movein.learn" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(null);
    }
  };

  const pickFolder = async () => {
    try {
      const items = await fromDirectoryPicker();
      if (items) await take(items);
      else folderInput.current?.click();
    } catch (err) {
      // Closing the picker isn't a problem.
      if ((err as { name?: string })?.name !== "AbortError") setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pick = () => (reader?.reads.pick === "folder" ? void pickFolder() : fileInput.current?.click());

  const kept = v.items.filter((i) => i.state === "kept").length;
  const waiting = v.items.filter((i) => i.state === "new").length;

  return (
    <div
      className={`mv ${setup ? "in-setup" : ""}`}
      onDragOver={(e) => {
        if (busy) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        if (busy) return;
        await take(await fromDrop(e.dataTransfer));
      }}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".zip,.json,.gz,.tgz,.tar,.md,.txt,application/zip"
        style={{ display: "none" }}
        onChange={async (e) => {
          const files = e.target.files ? fromInput(e.target.files) : [];
          e.target.value = "";
          await take(files);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        {...({ webkitdirectory: "" } as object)}
        style={{ display: "none" }}
        onChange={async (e) => {
          const files = e.target.files ? fromInput(e.target.files) : [];
          e.target.value = "";
          await take(files);
        }}
      />

      {!setup && (
        <div className="sheet-title" style={{ marginBottom: 0 }}>
          <h1 className="disp">Move in</h1>
          <span className="muted">Bring what another assistant knew about you. You choose what Atlas keeps.</span>
        </div>
      )}

      {finished != null && !reviewing && (
        <p className="ok rise">
          <Icon name="check" size={13} /> Moved in.{" "}
          {finished ? `${plural(finished, "thing")} kept, with where each came from, in Library.` : "Nothing was kept."}
        </p>
      )}

      {picking && (
        <Picking
          atlas={atlas}
          readers={readers}
          reader={reader}
          choose={(id) => setChosen((c) => (c === id ? null : id))}
          over={over}
          pick={pick}
          setup={setup}
        />
      )}

      {error && (
        <p className="err small rise" role="alert">
          {error}
        </p>
      )}

      {sending && <SendingPanel s={sending} detailed={at("detailed")} />}

      {!sending && reviewing && (
        <Review
          atlas={atlas}
          v={v}
          developer={at("developer")}
          more={more}
          onMore={() => setMore(true)}
          onDone={() => {
            setFinished(kept);
            setChosen(null);
            atlas.send({ type: "atlas.movein.done" });
          }}
          waiting={waiting}
        />
      )}
    </div>
  );
}

/** The four sources, how to get the chosen one's file, and the place to drop it. Contacts beside them. */
function Picking({
  atlas,
  readers,
  reader,
  choose,
  over,
  pick,
  setup,
}: {
  atlas: Atlas;
  readers: Reader[];
  reader: Reader | null;
  choose: (id: string) => void;
  over: boolean;
  pick: () => void;
  setup: boolean;
}) {
  const s = atlas.state;
  const contacts = (s.view?.extensions ?? []).filter((e) => e.state === "on" && e.provides.includes("contacts"));
  const imported = s.tests.contacts;
  const folder = reader?.reads.pick === "folder";
  return (
    <>
      <div className="mv-sources" role="radiogroup" aria-label="Where you're moving in from">
        {readers.map((r) => (
          <button
            key={r.id}
            role="radio"
            aria-checked={reader?.id === r.id}
            className={`card2 mv-source ${reader?.id === r.id ? "on" : ""}`}
            onClick={() => choose(r.id)}
          >
            <ReaderLogo r={r} />
            <span className="grow">
              <span style={{ fontWeight: 600 }}>{short(r)}</span>
              <span className="aside clip">{r.reads.pick === "folder" ? "Its memory and skills" : "Your data export"}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={reader ? "mv-how rise" : ""} key={reader?.id ?? "any"}>
        {reader && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, justifyContent: "center" }}>
            <span className="lab">Where to get it</span>
            <p>{reader.reads.how}</p>
            {reader.reads.link && (
              <p>
                <a className="btn s" href={reader.reads.link} target="_blank" rel="noreferrer">
                  Open {short(reader)} settings <Icon name="right" size={12} />
                </a>
              </p>
            )}
          </div>
        )}
        <div className={`mv-drop ${over ? "over" : ""}`}>
          {reader ? (
            <ReaderLogo r={reader} size={34} />
          ) : (
            <span className="mv-glyph">
              <Icon name="up" size={15} />
            </span>
          )}
          <strong style={{ fontWeight: 600 }}>
            {reader
              ? folder
                ? `Drop your ${short(reader)} folder here`
                : `Drop your ${short(reader)} export here`
              : "Drop an export or a folder here"}
          </strong>
          <span className="muted small">
            or{" "}
            <button className="link" onClick={pick}>
              {folder ? "choose the folder" : "choose the file"}
            </button>
            {!reader && ". Atlas tells which it's from."}
          </span>
          <span className="aside" style={{ maxWidth: 380 }}>
            Opened on this device. Only what {reader ? short(reader) : "it"} knew about you is sent to your Atlas, and nothing is kept until
            you say so.
          </span>
        </div>
      </div>
      {!setup || contacts.length ? (
        <div className="mv-contacts">
          <span className="logo" style={{ width: 28, height: 28, borderRadius: 7 }}>
            <Icon name="people" size={14} />
          </span>
          <span className="grow" style={{ minWidth: 200 }}>
            <strong style={{ fontWeight: 500 }}>Contacts</strong>
            <span className="muted small"> · the people in your address book come in as they are</span>
          </span>
          {contacts.map((e) => (
            <button key={e.id} className="btn s" onClick={() => atlas.send({ type: "atlas.contacts.import", from: e.id })}>
              <LogoMark of={e.id} size={13} /> Bring in from {e.name}
            </button>
          ))}
          <label className="btn s">
            Bring in a vCard
            <input
              type="file"
              accept=".vcf,text/vcard,text/x-vcard"
              style={{ display: "none" }}
              onChange={async (ev) => {
                const f = ev.target.files?.[0];
                if (f) atlas.send({ type: "atlas.contacts.import", vcards: await f.text() });
                ev.target.value = "";
              }}
            />
          </label>
          {imported && (
            <p className={`small ${imported.ok ? "ok" : "err"}`} style={{ width: "100%" }}>
              {imported.message}
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

/** What's being opened and sent, with how far along. */
function SendingPanel({ s, detailed }: { s: Sending; detailed: boolean }) {
  const share = s.of ? Math.min(1, s.done / s.of) : 0;
  const found = [
    s.seen ? plural(s.seen, "conversation") : "",
    s.notes ? plural(s.notes, "note") : "",
    s.skills ? plural(s.skills, "skill") : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="panel mv-progress rise" aria-live="polite">
      <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
        <ReaderLogo r={s.reader} size={30} />
        <span className="grow">
          <strong style={{ fontWeight: 600 }}>
            Opening your {short(s.reader)} {s.reader.reads.pick === "folder" ? "folder" : "export"}
          </strong>
          <span className="muted small" style={{ display: "block" }}>
            {found ? `Found ${found} so far` : "Looking for what it knew about you"}
          </span>
        </span>
        <span className="mono aside">{Math.round(share * 100)}%</span>
      </div>
      <div className="mv-bar">
        <i style={{ transform: `scaleX(${share})` }} />
      </div>
      {detailed && (
        <span className="mono aside clip">
          {s.file ?? s.name}
          {s.of ? ` · ${mb(s.done)} of ${mb(s.of)}` : ""}
        </span>
      )}
    </div>
  );
}

/** What Atlas is reading, then what it learned: grouped, each to keep or drop, with Keep all. */
function Review({
  atlas,
  v,
  developer,
  more,
  onMore,
  onDone,
  waiting,
}: {
  atlas: Atlas;
  v: MoveInView;
  developer: boolean;
  more: boolean;
  onMore: () => void;
  onDone: () => void;
  waiting: number;
}) {
  const learning = v.phase === "learning";
  const facts = v.items.filter((i) => i.kind !== "skill");
  const skills = v.items.filter((i) => i.kind === "skill");
  const kept = v.items.filter((i) => i.state === "kept").length;
  const decide = (ids: string[], keep: boolean) => atlas.send({ type: "atlas.movein.keep", ids, keep });
  const from = joined(v.sources.map((x) => x.name.replace(/ export$/i, "")));
  const talks = v.read?.talks ?? v.gathered.talks;
  const seen = v.read?.seen ?? v.sources.reduce((a, x) => a + x.seen, 0);
  const notes = v.read?.notes ?? v.gathered.notes;
  const read = [talks ? plural(talks, "conversation") : "", notes ? plural(notes, "note") : ""].filter(Boolean).join(" and ");
  // How much was read, in a sentence: all of it, or the newest within what Atlas reads.
  const covered =
    !talks && !notes
      ? ""
      : seen > talks && talks
        ? `Read your ${n(talks)} most recent conversations of ${n(seen)}${notes ? `, and ${plural(notes, "note")}` : ""}. `
        : `Read ${read}. `;
  const progress = v.progress;

  if (v.phase === "failed" && !v.items.length)
    return (
      <div className="panel mv-progress rise" role="alert">
        <strong style={{ fontWeight: 600 }}>Atlas couldn't read it</strong>
        <span className="err small">{v.error ?? "It didn't say why."}</span>
        <span className="mv-actions">
          {v.gathered.talks + v.gathered.notes > 0 && (
            <button className="btn primary s" onClick={() => atlas.send({ type: "atlas.movein.learn" })}>
              Try again
            </button>
          )}
          <button className="btn s" onClick={onDone}>
            Start over
          </button>
        </span>
      </div>
    );

  return (
    <div className="mv" style={{ gap: 14 }}>
      {(learning || v.phase === "paused") && progress && (
        <div className="panel mv-progress rise" aria-live="polite">
          <div className="row" style={{ gap: 10 }}>
            {learning && <span className="mono spin ac" aria-hidden />}
            <strong style={{ fontWeight: 600 }} className="grow">
              {v.phase === "paused" ? "Reading stopped when Atlas restarted" : `Reading ${read || "what you sent"} from ${from}`}
            </strong>
            {v.phase === "paused" ? (
              <button className="btn primary s" onClick={() => atlas.send({ type: "atlas.movein.learn" })}>
                Go on reading
              </button>
            ) : (
              <span className="mono aside">
                {progress.done} of {progress.of}
              </span>
            )}
          </div>
          <div className="mv-steps" aria-hidden>
            {Array.from({ length: progress.of }, (_, i) => (
              <i key={i} className={i < progress.done ? "f" : i < progress.done + progress.failed ? "x" : ""} />
            ))}
          </div>
          <span className="muted small">What it finds shows up below as it goes. You can start keeping things now.</span>
        </div>
      )}

      {!learning && v.phase !== "paused" && (
        <div className="mv-summary rise">
          <span className="mv-count">{n(facts.length + skills.length)}</span>
          <span className="grow">
            <strong style={{ fontWeight: 600, display: "block" }}>
              {facts.length || skills.length
                ? `${facts.length + skills.length === 1 ? "thing" : "things"} Atlas learned from ${from || "what you sent"}`
                : `Nothing new from ${from || "what you sent"}`}
            </strong>
            <span className="muted small">
              {covered}
              {v.known ? `${plural(v.known, "thing")} Atlas already knew ${v.known === 1 ? "isn't" : "aren't"} shown. ` : ""}
              Nothing is kept until you say so.
            </span>
          </span>
          <span className="mv-actions">
            <button
              className="btn primary"
              disabled={!waiting}
              onClick={() => atlas.send({ type: "atlas.movein.keep", ids: [], all: true, keep: true })}
            >
              <Icon name="check" size={13} /> Keep all{waiting ? ` ${n(waiting)}` : ""}
            </button>
            <button className="btn" onClick={onDone}>
              Done
            </button>
          </span>
        </div>
      )}

      {v.error && (
        <p className="err small" role="alert">
          {v.error}{" "}
          {v.progress && v.progress.failed > 0 && (
            <button className="link" onClick={() => atlas.send({ type: "atlas.movein.learn" })}>
              Try again
            </button>
          )}
        </p>
      )}

      {GROUPS.map(([kind, title]) => {
        const list = v.items.filter((i) => i.kind === kind);
        if (!list.length) return null;
        const open = list.filter((i) => i.state === "new").map((i) => i.id);
        return (
          <div key={kind} className="mv-group">
            <div className="mv-rule">
              <span className="lab">
                {title} · {list.length}
              </span>
              <i />
              {open.length > 1 && (
                <button className="link small" onClick={() => decide(open, true)}>
                  Keep these {open.length}
                </button>
              )}
            </div>
            {list.map((i) => (
              <Item key={i.id} i={i} developer={developer} decide={decide} />
            ))}
          </div>
        );
      })}

      {!learning && v.phase !== "paused" && (
        <div className="row" style={{ marginTop: 6 }}>
          {kept > 0 && <span className="okdot">{plural(kept, "thing")} kept</span>}
          <span className="grow" />
          {!more && (
            <button className="link small" onClick={onMore}>
              Move in from somewhere else too
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ i, developer, decide }: { i: MoveInItem; developer: boolean; decide: (ids: string[], keep: boolean) => void }) {
  const named = i.kind === "person" || i.kind === "project" || i.kind === "skill";
  return (
    <div className={`mv-item rise ${i.state}`}>
      <div className="mv-words">
        <p>
          {named ? (
            <>
              <span className="mv-name">{i.name}</span>
              <span className="muted"> · {i.text}</span>
            </>
          ) : (
            i.text
          )}
        </p>
        <p className="aside" style={{ marginTop: 2 }}>
          {i.why ? `${i.why} · ` : ""}
          {i.had && i.state !== "kept" ? "Adds to what Atlas knows · " : ""}
          From {i.from}
          {i.also ? ` and ${plural(i.also, "other place")}` : ""}
          {i.skill?.left_out.length
            ? ` · ${plural(i.skill.left_out.length, "file")} left out (${i.skill.left_out.slice(0, 2).join(", ")}): too big, or named in a way Atlas can't keep`
            : ""}
          {developer ? ` · ${Math.round(i.sure * 100)}% sure` : ""}
        </p>
      </div>
      <span className="mv-decide" role="group" aria-label={`Keep or drop ${i.name}`}>
        <button className={i.state === "kept" ? "kept" : ""} aria-pressed={i.state === "kept"} onClick={() => decide([i.id], true)}>
          <Icon name="check" size={12} /> {i.state === "kept" ? "Kept" : "Keep"}
        </button>
        <button
          className={i.state === "dropped" ? "dropped" : ""}
          aria-pressed={i.state === "dropped"}
          onClick={() => decide([i.id], false)}
        >
          <Icon name="x" size={12} /> {i.state === "dropped" ? "Dropped" : "Drop"}
        </button>
      </span>
    </div>
  );
}
