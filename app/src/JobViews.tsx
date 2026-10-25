// Jobs in the conversation (§8.3, §21.4): a job's card in the thread, its
// questions as messages with their buttons and files, its result, and its own
// thread on the stage. Coding jobs, the first design's jobs and helpers keep
// their detail views, opened from their cards.

import { useEffect, useRef, useState } from "react";
import type { FileRef, InboxItem, JobView, LogRow } from "../../core/src/protocol";
import type { Atlas } from "./connection";
import { jobNow } from "./jobs";
import { Markdown } from "./Markdown";
import { Receipt } from "./Shell";
import { stillMotion, useDetail } from "./theme";
import { clock, Diamond, elapsed, Empty, Icon, morphOrigin, Selected, Sheet, shortDay, stopClick, took, useNow } from "./ui";

const str = (v: unknown) => (typeof v === "string" ? v : "");

// --- files a message carries ------------------------------------------------------------------

/** A file to show: one the job made (a FileRef), or an older job's file, known only by its name. */
type Shown = { id: string; name: string; type: string; url: string | null; size?: number };

const EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
};

/** The files on a row's body: FileRefs from jobs since 2026-10-25, or names from the first design's. */
export function filesOf(v: unknown): Shown[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((f): Shown | null => {
      if (typeof f === "string") return { id: f, name: f, type: EXT[f.split(".").pop()?.toLowerCase() ?? ""] ?? "", url: null };
      if (f && typeof f === "object" && typeof (f as FileRef).name === "string") {
        const r = f as FileRef;
        return { id: r.id, name: r.name, type: r.type ?? "", url: r.url ?? null, ...(r.size != null ? { size: r.size } : {}) };
      }
      return null;
    })
    .filter((f): f is Shown => f != null);
}

const sizeOf = (n?: number) =>
  n == null ? "" : n < 1_000 ? `${n} B` : n < 1_000_000 ? `${Math.round(n / 1_000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`;

const kindOf = (f: Shown) =>
  f.url == null
    ? "doc"
    : f.type.startsWith("audio/")
      ? "audio"
      : f.type.startsWith("image/")
        ? "image"
        : f.type.startsWith("video/")
          ? "video"
          : "doc";

/** Files as they're best taken in: tracks to play, images and video to look at, the rest as chips that open. */
export function Files({ files }: { files: Shown[] }) {
  if (!files.length) return null;
  const tracks = files.filter((f) => kindOf(f) === "audio");
  const images = files.filter((f) => kindOf(f) === "image");
  const videos = files.filter((f) => kindOf(f) === "video");
  const rest = files.filter((f) => kindOf(f) === "doc");
  return (
    <div className="files">
      {tracks.length > 0 && (
        <div className="tracks">
          {tracks.map((f, i) => (
            <AudioPlayer key={f.id} file={f} n={tracks.length > 1 ? i + 1 : undefined} />
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className={`file-images n${Math.min(images.length, 3)}`}>
          {images.map((f) => (
            <a key={f.id} href={f.url!} target="_blank" rel="noreferrer" className="file-image" title={f.name} onClick={stopClick}>
              <img src={f.url!} alt={f.name} loading="lazy" />
              <span className="fi-name mono">{f.name}</span>
            </a>
          ))}
        </div>
      )}
      {videos.map((f) => (
        <figure key={f.id} className="file-video">
          <video src={f.url!} controls preload="metadata" playsInline />
          <figcaption className="mono">
            <span className="clip">{f.name}</span>
            {f.size != null && <span>{sizeOf(f.size)}</span>}
          </figcaption>
        </figure>
      ))}
      {rest.length > 0 && <FileChips files={rest} />}
    </div>
  );
}

const docMark = (f: Shown) => (f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE";

export function FileChips({ files, max }: { files: Shown[]; max?: number }) {
  const shown = max ? files.slice(0, max) : files;
  return (
    <div className="file-chips">
      {shown.map((f) => (
        <a
          key={f.id}
          className="file-chip"
          href={f.url ?? "#/library"}
          target={f.url ? "_blank" : undefined}
          rel="noreferrer"
          title={f.url ? f.name : `${f.name}, in Library`}
          onClick={stopClick}
        >
          <span className="fc-ext mono">{docMark(f)}</span>
          <span className="clip">{f.name}</span>
          {f.size != null && <span className="faint mono fc-size">{sizeOf(f.size)}</span>}
        </a>
      ))}
      {max && files.length > max && <span className="file-chip more">+{files.length - max}</span>}
    </div>
  );
}

/** What a job has made, as small previews on its card: images, tracks with their shape, a video's first frame, documents. */
function MadeSoFar({ files }: { files: Shown[] }) {
  const media = files.filter((f) => kindOf(f) !== "doc").slice(0, 6);
  const docs = files.filter((f) => kindOf(f) === "doc");
  return (
    <div className="made" onClick={stopClick}>
      {media.map((f) =>
        kindOf(f) === "audio" ? (
          <AudioPlayer key={f.id} file={f} mini />
        ) : kindOf(f) === "image" ? (
          <a key={f.id} className="made-img" href={f.url!} target="_blank" rel="noreferrer" title={f.name}>
            <img src={f.url!} alt={f.name} loading="lazy" />
          </a>
        ) : (
          <a key={f.id} className="made-vid" href={f.url!} target="_blank" rel="noreferrer" title={f.name}>
            <video src={`${f.url!}#t=0.5`} preload="metadata" muted playsInline />
            <span className="made-play" aria-hidden>
              <svg width="10" height="10" viewBox="0 0 12 12">
                <path d="M3 1.6v8.8a.5.5 0 0 0 .76.43l7.1-4.4a.5.5 0 0 0 0-.86l-7.1-4.4A.5.5 0 0 0 3 1.6z" fill="currentColor" />
              </svg>
            </span>
          </a>
        ),
      )}
      {docs.length > 0 && <FileChips files={docs} max={media.length ? 2 : 4} />}
    </div>
  );
}

/** A small, stable shape for a track's bars, from its id, so each track looks like itself. */
function bars(id: string, n: number): number[] {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: n }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177) ^ i;
    const r = ((h >>> 0) % 1000) / 1000;
    const swell = Math.sin((i / n) * Math.PI) * 0.45 + 0.35;
    return Math.max(0.18, Math.min(1, swell + (r - 0.5) * 0.7));
  });
}

const mmss = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

/** A track to listen to, played in place; `mini` is the small one on a job's card. One plays at a time. */
export function AudioPlayer({ file, n, mini }: { file: Shown; n?: number; mini?: boolean }) {
  const el = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [d, setD] = useState(0);
  const shape = bars(file.id, mini ? 22 : 72);
  useEffect(() => {
    const other = (e: Event) => {
      if ((e as CustomEvent).detail !== el.current) el.current?.pause();
    };
    window.addEventListener("atlas:play", other);
    return () => window.removeEventListener("atlas:play", other);
  }, []);
  const toggle = () => {
    const a = el.current;
    if (!a) return;
    if (a.paused) {
      window.dispatchEvent(new CustomEvent("atlas:play", { detail: a }));
      void a.play();
    } else a.pause();
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = el.current;
    if (!a || !d) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
    setT(a.currentTime);
  };
  const at = d ? t / d : 0;
  return (
    <div className={`player ${mini ? "mini" : ""} ${playing ? "on" : ""}`} onClick={stopClick} title={mini ? file.name : undefined}>
      <button className="play" onClick={toggle} aria-label={playing ? `Pause ${file.name}` : `Play ${file.name}`}>
        {playing ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <rect x="2" y="1.5" width="2.6" height="9" rx="0.6" fill="currentColor" />
            <rect x="7.4" y="1.5" width="2.6" height="9" rx="0.6" fill="currentColor" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M3 1.6v8.8a.5.5 0 0 0 .76.43l7.1-4.4a.5.5 0 0 0 0-.86l-7.1-4.4A.5.5 0 0 0 3 1.6z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="pl-body">
        {!mini && (
          <span className="pl-name">
            {n != null && <span className="mono faint">{String(n).padStart(2, "0")}</span>}
            <span className="clip">{file.name.replace(/\.[a-z0-9]{2,4}$/i, "")}</span>
            <span className="mono faint pl-ext">{file.name.split(".").pop()}</span>
          </span>
        )}
        <div className="pl-bars" onClick={seek} role="slider" aria-label="Position" aria-valuenow={Math.round(at * 100)} tabIndex={-1}>
          {shape.map((h, i) => (
            <i key={i} className={i / shape.length < at ? "past" : ""} style={{ transform: `scaleY(${h})` }} />
          ))}
        </div>
      </div>
      {!mini && <span className="mono pl-time">{mmss(playing || t ? t : d)}</span>}
      <audio
        ref={el}
        src={file.url ?? undefined}
        preload="metadata"
        onLoadedMetadata={(e) => setD(e.currentTarget.duration)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}

// --- a job's question, as a message with its buttons ---------------------------------------------

export interface QuestionData {
  /** The question's log row, which an answer names. */
  id: string;
  job: string;
  title: string;
  text: string;
  options: string[];
  content?: string;
  files: Shown[];
  why?: string;
}

export function questionFromRow(r: LogRow): QuestionData {
  const b = r.body;
  return {
    id: r.id,
    job: str(b.job),
    title: str(b.title),
    text: str(b.text),
    options: Array.isArray(b.options) ? b.options.map(String) : [],
    ...(str(b.content) ? { content: str(b.content) } : {}),
    files: filesOf(b.files),
    ...(str(b.why) ? { why: str(b.why) } : {}),
  };
}

export function questionFromItem(i: InboxItem): QuestionData {
  const q = i.job!;
  return {
    id: i.id,
    job: q.id,
    title: q.title,
    text: q.question,
    options: q.options,
    ...(q.content ? { content: q.content } : {}),
    files: filesOf(q.files),
    ...(q.why ? { why: q.why } : {}),
  };
}

/** What the owner answered, from this app or from the log (a row that names the question it answers). */
export function answerTo(atlas: Atlas, id: string): string | null {
  const s = atlas.state;
  if (s.answered[id]) return s.answered[id]!;
  const rows = [...s.rows, ...Object.values(s.jobThreads).flat()];
  const r = rows.find((x) => x.body.answers === id);
  return r ? str(r.body.text) || str(r.body.said) || null : null;
}

/** Whether a question still waits on the owner: it's in Inbox. */
export const isOpen = (atlas: Atlas, id: string) => (atlas.state.inbox ?? []).some((i) => i.id === id);

/**
 * The question's body and its answers (§8.3, §21.4): Atlas's selection
 * around it while it waits, what to look at or listen to, a button per
 * option, and Reply for the owner's own words. Once answered, it settles and
 * shows the choice. Inbox shows the same, without the selection: there,
 * everything waits on the owner.
 */
export function QuestionBody({
  atlas,
  q,
  open,
  title = true,
  selection = true,
}: {
  atlas: Atlas;
  q: QuestionData;
  open: boolean;
  title?: boolean;
  selection?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const answer = answerTo(atlas, q.id);
  const send = (t: string) => {
    atlas.jobSay(q.job, t, q.id);
    setReplying(false);
    setText("");
  };
  const waiting = open && !answer;
  const picked = answer != null ? q.options.find((o) => o.trim().toLowerCase() === answer.trim().toLowerCase()) : undefined;
  return (
    <Selected on={waiting && selection} tag={`Needs you${q.title ? ` · ${q.title}` : ""}`} className={selection ? "q-sel" : ""}>
      <div className={`question ${waiting ? "waiting" : "settled"}`}>
        {title && !waiting && (
          <span className="q-for lab">
            {q.title}
            {answer ? " · answered" : ""}
          </span>
        )}
        <Markdown className="said" text={q.text} />
        {q.content && <Markdown className="q-content" text={q.content} />}
        <Files files={q.files} />
        {q.why && <p className="muted small">{q.why}</p>}
        {q.options.length > 0 && (waiting || picked) && (
          <div className="q-options" role="group" aria-label="Answers">
            {q.options.map((o, i) => (
              <button
                key={o}
                className={`btn opt ${picked === o ? "chosen" : ""}`}
                onClick={() => send(o)}
                disabled={!waiting}
                aria-pressed={picked === o}
              >
                {picked === o ? (
                  <svg className="opt-tick" width="11" height="10" viewBox="0 0 11 10" aria-hidden>
                    <path d="M1.5 5.2 4.3 8 9.6 1.8" />
                  </svg>
                ) : (
                  <span className="mono opt-n">{i + 1}</span>
                )}
                {o}
              </button>
            ))}
            {waiting && !replying && (
              <button className="link small q-own" onClick={() => setReplying(true)}>
                Reply in your words
              </button>
            )}
          </div>
        )}
        {waiting && !q.options.length && !replying && (
          <div className="q-options">
            <button className="btn opt" onClick={() => setReplying(true)}>
              Reply
            </button>
          </div>
        )}
        {waiting && replying && (
          <form
            className="q-reply rise"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send(text.trim());
            }}
          >
            <input autoFocus value={text} placeholder="Your answer" onChange={(e) => setText(e.target.value)} />
            <button className="btn primary" type="submit" disabled={!text.trim()}>
              Send
            </button>
            <button className="btn" type="button" onClick={() => setReplying(false)}>
              Cancel
            </button>
          </form>
        )}
        {answer && !picked && (
          <div className="q-answer">
            <span className="lab">You answered</span>
            <span className="bubble">{answer}</span>
          </div>
        )}
        {!open && !answer && atlas.state.inbox != null && <p className="faint small">This doesn't need you any more.</p>}
      </div>
    </Selected>
  );
}

/** A job's result: Atlas's words on it, with what it made. */
export function ResultBody({ row }: { row: LogRow }) {
  const b = row.body;
  const failed = b.state === "failed";
  return (
    <div className={`question result ${failed ? "failed" : "done"}`}>
      <span className={`q-for lab ${failed ? "err" : "ok"}`}>
        {failed ? "×" : "✓"} {str(b.title) || "A job"} · {failed ? "didn't finish" : "done"}
      </span>
      <Markdown className="said" text={str(b.text) || str(b.error) || (failed ? "It didn't finish." : "Done.")} />
      <Files files={filesOf(b.files)} />
    </div>
  );
}

// --- a job's card in the thread ------------------------------------------------------------------

/** The jobs that get a card of their own: a coding agent working for a job Atlas owns shows on that job's card. */
export function topJobs(jobs: JobView[]): JobView[] {
  const under = new Set(jobs.map((j) => j.owned?.coding).filter((x): x is string => x != null));
  return jobs.filter((j) => !under.has(j.id));
}

/** What a job's card says it's doing, its latest words and its files, whatever kind of job it is. */
function cardOf(j: JobView): { now: string | null; latest: string | null; files: Shown[] } {
  const o = j.owned;
  if (o) return { now: o.now, latest: o.latest?.text ?? null, files: filesOf(o.files) };
  if (j.goal) {
    const said = [...j.goal.log].reverse().find((e) => e.who === "atlas");
    return { now: j.status, latest: said?.text ?? null, files: filesOf(j.goal.files) };
  }
  if (j.coding) {
    const said = [...j.coding.log].reverse().find((e) => e.who === "atlas" || e.who === "agent");
    return { now: j.status, latest: said?.text.split("\n").find((l) => l.trim()) ?? null, files: [] };
  }
  return { now: j.status, latest: j.state !== "running" ? j.result : null, files: [] };
}

/** One of the parallel lines on a job's card: a helper reading for it, or the coding agent building for it. */
interface Line {
  id: string;
  title: string;
  running: boolean;
  failed: boolean;
  status: string | null;
}

function linesOf(job: JobView, jobs: JobView[]): Line[] {
  const helpers = (job.helpers ?? []).map((h): Line => ({
    id: h.id,
    title: h.title.startsWith(`${job.title}: `) ? h.title.slice(job.title.length + 2) : h.title,
    running: h.state === "running",
    failed: h.state === "failed",
    status: h.status,
  }));
  const coding = job.owned?.coding ? jobs.find((j) => j.id === job.owned!.coding) : undefined;
  if (coding?.coding)
    helpers.push({
      id: coding.id,
      title: `${coding.coding.agent} · ${coding.coding.repo}`,
      running: coding.state === "running",
      failed: coding.state === "failed",
      status: coding.status,
    });
  return helpers;
}

/**
 * Helpers fanning out as parallel progress lines (§21.8), each with what it's
 * reading, then folding back into one line once they're all done.
 */
function Lines({ lines }: { lines: Line[] }) {
  const done = lines.every((l) => !l.running);
  const [folding, setFolding] = useState(false);
  const was = useRef(done);
  useEffect(() => {
    if (done && !was.current && !stillMotion()) {
      setFolding(true);
      const t = setTimeout(() => setFolding(false), 620);
      was.current = done;
      return () => clearTimeout(t);
    }
    was.current = done;
  }, [done]);
  if (done && !folding) {
    const failed = lines.filter((l) => l.failed).length;
    return (
      <p className="jc-fold mono rise">
        <span className={failed ? "err" : "ok"}>{failed ? "×" : "✓"}</span>
        <span className="clip">
          {lines.length === 1 ? `${lines[0]!.title} is done` : `${lines.length} helpers done`}
          {failed ? `, ${failed} didn't finish` : ""}
        </span>
      </p>
    );
  }
  return (
    <div className={`jc-lines ${folding ? "folding" : ""}`}>
      {lines.map((l, i) => (
        <div key={l.id} className={`jl ${l.running ? "on" : l.failed ? "bad" : "done"}`} style={{ "--i": i } as React.CSSProperties}>
          <span className="jl-mark mono" aria-hidden>
            {l.running ? <span className="spin" /> : l.failed ? "×" : "✓"}
          </span>
          <span className="jl-name clip">{l.title}</span>
          <span className="jl-track" aria-hidden>
            <i />
          </span>
          <span className="jl-status mono clip">{l.status ?? (l.running ? "Starting" : l.failed ? "Didn't finish" : "Done")}</span>
        </div>
      ))}
    </div>
  );
}

const helpersWord = (lines: Line[]) => {
  const on = lines.filter((l) => l.running).length;
  return on ? `${on} of ${lines.length} helpers at work` : "";
};

/** "Needs you · 3 tracks": what the question brings, in a word, for the tag on its job's card. */
function bringsWord(item: InboxItem | undefined): string {
  const files = filesOf(item?.job?.files);
  const n = (k: string) => files.filter((f) => kindOf(f) === k).length;
  if (n("audio") > 1) return `${n("audio")} tracks to hear`;
  if (n("image") > 1) return `${n("image")} images to see`;
  if (n("video")) return "a cut to watch";
  const o = item?.job?.options.length ?? 0;
  return o > 1 ? `${o} options` : "a question";
}

/**
 * A job's card (§21.4): its title and state, what Atlas is doing on it in
 * mono only while something is, how long it has been at it, its helpers as
 * parallel lines, its latest words, and what it has made as real previews.
 * Waiting on the owner it carries Atlas's selection in ember; done, it's calm;
 * stopped, it's muted. It updates in place.
 */
export function JobCard({ atlas, job, onOpen }: { atlas: Atlas; job: JobView; onOpen: () => void }) {
  const now = useNow(1000);
  const { at } = useDetail();
  const shown = jobNow(job, now);
  const card = cardOf(job);
  const o = job.owned;
  const working = o ? job.activity === "working" && shown.live : shown.live;
  const needs = shown.label === "Waiting on you";
  const running = job.state === "running";
  const lines = linesOf(job, atlas.state.jobs);
  const spent = o?.spent;
  const question = o?.question ? (atlas.state.inbox ?? []).find((i) => i.id === o.question) : undefined;
  const moved = job.moved_at ?? job.started_at;
  const state =
    job.state === "done"
      ? "done"
      : job.state === "failed"
        ? "failed"
        : job.state === "cancelled"
          ? "stopped"
          : needs
            ? "needs"
            : working
              ? "working"
              : shown.label === "Stalled"
                ? "stalled"
                : "paused";
  const time =
    state === "working"
      ? elapsed(now - job.started_at)
      : state === "needs" || state === "stalled" || state === "paused"
        ? took(now - moved)
        : state === "done"
          ? took(moved - job.started_at)
          : "";
  const meta = at("detailed")
    ? [
        spent && `${spent.turns} ${spent.turns === 1 ? "turn" : "turns"}`,
        spent && spent.tokens > 0 && `${spent.tokens >= 1000 ? `${Math.round(spent.tokens / 1000)}k` : spent.tokens} tokens`,
        spent?.dollars != null && `$${spent.dollars.toFixed(2)}`,
        job.coding && `${job.coding.agent} · ${job.coding.repo}`,
        job.coding?.cost != null && `$${job.coding.cost.toFixed(2)}`,
        o?.deadline && `due ${shortDay(o.deadline)}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const open = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    morphOrigin(e.currentTarget.closest(".job-card"));
    onOpen();
  };
  return (
    <Selected on={needs} handles={false} tag={`Needs you · ${bringsWord(question)}`} className="jc-sel">
      <div
        className={`job-card s-${state}`}
        // The whole card opens it; its title is the button for the keyboard and screen readers, so Stop isn't inside one.
        onClick={open}
      >
        <div className="jc-head">
          <button className="jc-title" title={`Open ${job.title}`} onClick={open}>
            {job.title}
          </button>
          <span className="jc-state mono">
            {state === "done" && <span className="ok">✓</span>}
            {state === "needs" && <span className="sq-ac" aria-hidden />}
            <span>{state === "working" ? "Working" : state === "needs" ? "Your turn" : state === "done" ? "Done" : shown.label}</span>
            {time && <span className="jc-time">{time}</span>}
          </span>
        </div>
        {working && card.now && (
          <p className="jc-now mono" key={card.now}>
            <span className="spin" aria-hidden />
            <span className="clip">{card.now}</span>
          </p>
        )}
        {state === "stalled" && <p className="jc-now mono err">{shown.status}</p>}
        {lines.length > 0 && running && <Lines lines={lines} />}
        {card.latest && (
          <p className="jc-latest clamp" key={card.latest}>
            {card.latest}
          </p>
        )}
        {card.files.length > 0 && <MadeSoFar files={card.files} />}
        <div className="jc-foot">
          <span className="jc-meta mono">
            {meta ||
              (card.files.length
                ? `${card.files.length} ${card.files.length === 1 ? "file" : "files"}`
                : lines.length
                  ? helpersWord(lines)
                  : "")}
          </span>
          <span className="grow" />
          {running && (
            <button
              className="jc-act"
              onClick={(e) => {
                e.stopPropagation();
                atlas.send({ type: "atlas.job.stop", id: job.id });
              }}
            >
              Stop
            </button>
          )}
          <span className="jc-act jc-open" aria-hidden>
            Open
            <Icon name="right" size={12} />
          </span>
        </div>
      </div>
    </Selected>
  );
}

/** The state word's color in a job's own thread: ember only when it waits on the owner (ember is rare); done is a quiet green. */
const stateClass = (n: ReturnType<typeof jobNow>) => (n.label === "Waiting on you" ? "needs" : n.tone === "ac" ? "" : n.tone);

// --- a job's own thread, on the stage --------------------------------------------------------------

/** A job's own thread (§21.4): everything Atlas said on it and the owner said to it, and words that go straight to it. */
export function JobThread({ atlas, job }: { atlas: Atlas; job: JobView }) {
  const rows = atlas.state.jobThreads[job.id];
  const { at } = useDetail();
  const now = useNow(30_000);
  const shown = jobNow(job, now);
  const o = job.owned;
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.job.thread", id: job.id });
  }, [job.id, atlas.voice.connected, o?.latest?.at, o?.question, job.state]);
  // Newest at the foot, as tracks and images load in, unless the owner has scrolled up to read.
  useEffect(() => {
    const el = box.current;
    const content = inner.current;
    if (!el || !content) return;
    const o = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    o.observe(content);
    return () => o.disconnect();
  }, [rows == null]);
  const working = job.activity === "working" && shown.live;
  return (
    <Sheet className="pick job-sheet">
      <div className="sheet-in job-thread">
        <div className="sheet-title">
          <h1 className="disp">{job.title}</h1>
          <span className={`jc-state ${stateClass(shown)}`}>{shown.label}</span>
          <span className="grow" />
          {job.state === "running" && (
            <button className="btn" onClick={() => atlas.send({ type: "atlas.job.stop", id: job.id })}>
              Stop
            </button>
          )}
        </div>
        {working && o?.now && (
          <p className="jc-now mono" style={{ marginTop: -8, marginBottom: 14 }}>
            <span className="spin" aria-hidden />
            <span>{o.now}</span>
          </p>
        )}
        {job.state === "running" && linesOf(job, atlas.state.jobs).length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Lines lines={linesOf(job, atlas.state.jobs)} />
          </div>
        )}
        {at("detailed") && o && (
          <details className="jt-notes">
            <summary className="small">
              What I'm keeping in mind
              <span className="faint mono">
                {" "}
                · {o.spent.turns} {o.spent.turns === 1 ? "turn" : "turns"}
                {o.spent.tokens ? ` · ${Math.round(o.spent.tokens / 1000)}k tokens` : ""}
                {o.spent.dollars != null ? ` · $${o.spent.dollars.toFixed(2)}` : ""}
                {o.coding ? ` · ${o.coding}` : ""}
              </span>
            </summary>
            {o.notes ? <Markdown className="small" text={o.notes} /> : <p className="faint small">No notes yet.</p>}
          </details>
        )}
        <div
          className="jt-rows"
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          <div className="jt-rows-in" ref={inner}>
            {rows == null && <p className="faint">Looking</p>}
            {rows?.length === 0 && <p className="muted">Nothing said on it yet.</p>}
            {rows && <Turns atlas={atlas} job={job} rows={rows} />}
          </div>
        </div>
        {o?.files && o.files.length > 0 && (
          // Folded by default, so what's made never crowds the conversation; one tap opens it.
          <details className="jt-files">
            <summary className="faint small">
              Made so far · {o.files.length} {o.files.length === 1 ? "file" : "files"}
            </summary>
            <FileChips files={filesOf(o.files)} />
          </details>
        )}
        {job.state === "running" && (
          <form
            className="composer jt-say"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              atlas.jobSay(job.id, text.trim());
              setText("");
            }}
          >
            <span className="lead">
              <Diamond size={14} />
            </span>
            <label className="sr" htmlFor={`say-${job.id}`}>
              Say something about {job.title}
            </label>
            <textarea
              id={`say-${job.id}`}
              rows={1}
              value={text}
              placeholder={`Message about ${job.title}`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button className="send" aria-label="Send" disabled={!text.trim()}>
              <Icon name="up" size={15} style={{ strokeWidth: 2.1 }} />
            </button>
          </form>
        )}
      </div>
    </Sheet>
  );
}

/**
 * A job's own thread as a conversation (§21.4): the owner's words, and each of Atlas's turns as a reply with what it
 * did as chips under it; the turn under way streams in with what it's doing now, the way a reply does in the main thread.
 */
function Turns({ atlas, job, rows }: { atlas: Atlas; job: JobView; rows: LogRow[] }) {
  const live = Object.entries(atlas.state.live).find(([, l]) => l.job === job.id);
  const byRun = new Map<string, LogRow[]>();
  for (const r of rows) if (r.kind === "tool.result" && r.run_id) byRun.set(r.run_id, [...(byRun.get(r.run_id) ?? []), r]);
  const told = new Set(rows.filter((r) => r.kind === "job.update" && r.body.turn).map((r) => String(r.body.turn)));
  const shownRuns = new Set<string>();
  const out: React.ReactNode[] = [];
  for (const r of rows) {
    if (r.kind === "tool.result") {
      const run = r.run_id;
      // A turn's chips sit under its words, or under the turn while it's under way; a turn that said nothing shows them alone.
      if (!run || told.has(run) || run === live?.[0] || shownRuns.has(run)) continue;
      shownRuns.add(run);
      out.push(
        <div key={r.id} className="msg atlas">
          <span className="mark" />
          <div className="body">
            <Chips atlas={atlas} rows={byRun.get(run) ?? [r]} />
          </div>
        </div>,
      );
      continue;
    }
    out.push(
      <JobRow
        key={r.id}
        atlas={atlas}
        row={r}
        chips={r.kind === "job.update" && r.body.turn ? (byRun.get(String(r.body.turn)) ?? []) : []}
      />,
    );
  }
  if (live) {
    const [run, l] = live;
    out.push(
      <div key={run} className="msg atlas live">
        <span className="mark">
          <Diamond size={13} />
        </span>
        <div className="body">
          {(l.status || !l.text) && <TurnWorking run={run} status={l.status} />}
          {l.text && <Markdown className="said streaming" text={l.text} />}
          <Chips atlas={atlas} rows={byRun.get(run) ?? []} />
        </div>
      </div>,
    );
  }
  return <>{out}</>;
}

const turnSince = new Map<string, number>();

/** What a turn is doing now, with how long it's been at it. */
function TurnWorking({ run, status }: { run: string; status: string | null }) {
  const now = useNow(1000);
  if (!turnSince.has(run)) turnSince.set(run, now);
  return (
    <p className="working" aria-live="polite">
      <span className="mono spin" aria-hidden />
      <span className="w-text" key={status ?? "thinking"}>
        {status ?? "Thinking"}
      </span>
      <span className="w-time mono">{elapsed(now - turnSince.get(run)!)}</span>
    </p>
  );
}

/** What Atlas did, as the receipts' chips. */
function Chips({ atlas, rows }: { atlas: Atlas; rows: LogRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="receipts">
      {rows.map((r, i) => (
        <span key={r.id} style={{ "--i": i } as React.CSSProperties}>
          <Receipt row={r} atlas={atlas} undone={false} />
        </span>
      ))}
    </div>
  );
}

/** One row of a job's own thread. */
function JobRow({ atlas, row, chips = [] }: { atlas: Atlas; row: LogRow; chips?: LogRow[] }) {
  const b = row.body;
  const when = <span className="when">{clock(row.at)}</span>;
  // An answer shows on its question; it isn't said again under it.
  if (row.kind === "message.in" && b.answers != null) return null;
  if (row.kind === "message.in" || (row.kind === "settings.change" && b.said != null))
    return (
      <div className="msg owner">
        <p className="bubble">{str(b.text) || str(b.said)}</p>
        {when}
      </div>
    );
  if (row.kind === "job.question")
    return (
      <div className="msg atlas asks">
        <span className="mark">
          <Diamond size={13} />
        </span>
        <div className="body">
          <QuestionBody atlas={atlas} q={questionFromRow(row)} open={isOpen(atlas, row.id)} title={false} />
          {when}
        </div>
      </div>
    );
  if (row.kind === "job.result")
    return (
      <div className="msg atlas">
        <span className="mark">
          <Diamond size={13} />
        </span>
        <div className="body">
          <Markdown className="said" text={str(b.text) || str(b.error) || "Done."} />
          <Files files={filesOf(b.files)} />
          {when}
        </div>
      </div>
    );
  return (
    <div className="msg atlas">
      <span className="mark">
        <Diamond size={13} />
      </span>
      <div className="body">
        <Markdown className="said" text={str(b.text)} />
        <Files files={filesOf(b.files)} />
        <Chips atlas={atlas} rows={chips} />
        {when}
      </div>
    </div>
  );
}

// --- the detail of other kinds of jobs ----------------------------------------------------------------

/** A helper's job, or a job from the first design (§8.3 before 2026-10-25): what it was asked, how it went, its plan. */
export function JobDetail({ atlas, job }: { atlas: Atlas; job: JobView }) {
  const now = useNow(30_000);
  useEffect(() => {
    if (job.run_id) atlas.send({ type: "atlas.run.detail", run_id: job.run_id });
  }, [job.id, job.steps, job.state]);
  if (job.owned) return <JobThread atlas={atlas} job={job} />;
  if (job.coding) return <CodingJob atlas={atlas} job={job} />;
  const detail = job.run_id ? atlas.state.runDetail[job.run_id] : undefined;
  const lookups = (detail?.rows ?? []).filter((r) => r.kind === "tool.call");
  const shown = jobNow(job, now);
  return (
    <Sheet className="pick">
      <div className="sheet-in">
        <div className="sheet-title">
          <h1 className="disp">{job.title}</h1>
          <span className={`jc-state ${stateClass(shown)}`}>{shown.label}</span>
          <span className="grow" />
          {job.state === "running" && (
            <button className="btn" onClick={() => atlas.send({ type: "atlas.job.stop", id: job.id })}>
              Stop
            </button>
          )}
        </div>
        <div className="kv">
          <span className="lab">Asked</span>
          <span style={{ whiteSpace: "pre-wrap" }}>{job.brief}</span>
          <span className="lab">Started</span>
          <span>{shortDay(job.started_at)}</span>
          <span className="lab">Now</span>
          <span className={shown.label === "Stalled" ? "err" : undefined}>{shown.status}</span>
        </div>
        {job.goal && <GoalPlan atlas={atlas} job={job} />}
        {lookups.length > 0 && (
          <>
            <div className="section-rule">
              <span className="lab">Lookups · {lookups.length}</span>
            </div>
            <div className="rows">
              {lookups.map((r) => (
                <div className="r small" key={r.id}>
                  <span className="mono faint">{clock(r.at)}</span>
                  <span className="mono">{String(r.body.name)}</span>
                  <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {JSON.stringify(r.body.input)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {job.result && (
          <>
            <div className="section-rule">
              <span className="lab">{job.state === "done" ? "Handed back" : "Why"}</span>
            </div>
            <p style={{ whiteSpace: "pre-wrap" }}>{job.result}</p>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** A job from the first design (§8.3): its plan with each step's state and brain, what it waits on, what it has used, and Steer. */
function GoalPlan({ atlas, job }: { atlas: Atlas; job: JobView }) {
  const g = job.goal!;
  const [steer, setSteer] = useState("");
  const mark = { todo: "·", doing: "▸", done: "✓", failed: "×", skipped: "–" } as const;
  return (
    <>
      <div className="section-rule">
        <span className="lab">The plan</span>
        <span className="grow" />
        <span className="aside">
          {g.deadline ? `Due ${new Date(g.deadline).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · ` : ""}
          {g.spent.steps} of {g.budget.steps} steps · {g.spent.looks} of {g.budget.looks} looks
        </span>
      </div>
      <div className="rows">
        {g.plan.map((s) => (
          <div className="r small" key={s.id}>
            <span className="mono faint" style={{ width: 14 }}>
              {mark[s.state]}
            </span>
            <span className={s.state === "todo" ? "muted" : ""} style={{ flex: 1 }}>
              {s.title}
              {s.kind === "checkpoint" && <span className="aside"> · your look</span>}
            </span>
            {s.brain && s.brain !== "Main" && <span className="aside">{s.brain}</span>}
          </div>
        ))}
      </div>
      {g.question && (
        <div className="card2 pad" style={{ marginTop: 12 }}>
          <p style={{ fontWeight: 500 }}>{g.question.text}</p>
          {g.question.content && <p style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{g.question.content}</p>}
          <p className="aside" style={{ marginTop: 8 }}>
            Answer it in the conversation, or below.
          </p>
        </div>
      )}
      {g.files.length > 0 && <FileChips files={filesOf(g.files)} />}
      {job.state === "running" && (
        <form
          className="row"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!steer.trim()) return;
            atlas.jobSay(job.id, steer.trim());
            setSteer("");
          }}
        >
          <input
            className="grow"
            placeholder={g.question ? "Your answer" : "Steer: a word for its next step"}
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!steer.trim()}>
            {g.question ? "Answer" : "Steer"}
          </button>
        </form>
      )}
    </>
  );
}

/** One line of a coding job's stream, as its terminal shows it. */
function streamLine(e: NonNullable<JobView["coding"]>["log"][number]): { mark: string; who: string; text: string; tone: string } {
  const first = e.text.split("\n").find((l) => l.trim()) ?? "";
  if (e.who === "tool")
    return {
      mark: e.status === "failed" ? "×" : e.status === "completed" ? "✓" : "▸",
      who: "run",
      text: first,
      tone: e.status === "failed" ? "var(--ac)" : e.status === "completed" ? "var(--tx2)" : "var(--tx)",
    };
  if (e.who === "agent") return { mark: first.trim().endsWith("?") ? "?" : "›", who: "agent", text: first, tone: "var(--tx)" };
  if (e.who === "atlas") return { mark: "◆", who: "atlas", text: first, tone: "var(--tx)" };
  if (e.who === "owner") return { mark: "◆", who: "you", text: first, tone: "var(--tx)" };
  if (e.who === "plan") return { mark: "·", who: "plan", text: first, tone: "var(--tx3)" };
  return { mark: "·", who: "note", text: first, tone: "var(--tx3)" };
}

/**
 * A coding job (§8.2, docs/ui 05): its steps, the agent's stream as a
 * terminal, the questions Atlas answered for the owner with their sources,
 * what waits on the owner, and Steer and Stop.
 */
export function CodingJob({ atlas, job }: { atlas: Atlas; job: JobView }) {
  const c = job.coding!;
  const [steer, setSteer] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const term = useRef<HTMLDivElement>(null);
  useEffect(() => {
    term.current?.scrollTo({ top: term.current.scrollHeight });
  }, [c.log.length]);
  const now = useNow(30_000);
  const minutes = Math.max(0, Math.round((now - job.started_at) / 60_000));
  const running = job.state === "running";
  const forYou = c.answers.filter((a) => a.source !== "you");
  const askedYou = c.answers.length - forYou.length + (c.question ? 1 : 0);
  const say = (text: string) => atlas.jobSay(job.id, text);
  const lastTool = [...c.log].reverse().find((e) => e.who === "tool" && e.out);
  return (
    <Sheet className="pick">
      <div className="sheet-in">
        <div className="row" style={{ alignItems: "baseline", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <h1 className="disp grow" style={{ fontSize: 21 }}>
            {job.title}
          </h1>
          <span className="mono faint small">
            {c.cost != null ? `$${c.cost.toFixed(2)}${c.cap != null ? ` of $${c.cap.toFixed(0)}` : ""} · ` : ""}
            {minutes} MIN
          </span>
          {running && (
            <button className="btn" onClick={() => setSteer(steer == null ? "" : null)} aria-expanded={steer != null}>
              Steer
            </button>
          )}
          {running && (
            <button className="btn" onClick={() => atlas.send({ type: "atlas.job.stop", id: job.id })}>
              Stop
            </button>
          )}
        </div>
        <p className="faint" style={{ marginBottom: 12 }}>
          {c.repo} · {c.agent} does the work, Atlas runs it
        </p>
        <div className="chain" style={{ marginBottom: 14 }}>
          {c.steps.map((st, i) => (
            <span key={st.name} style={{ display: "contents" }}>
              {i > 0 && <span className="dash" />}
              <span
                className={`tag ${st.state === "now" ? "ac" : ""}`}
                style={st.state === "todo" ? { borderStyle: "dashed", opacity: 0.7 } : {}}
              >
                {st.state === "done" ? "✓ " : st.state === "now" ? "● " : "→ "}
                {st.name === "PR" ? "PR to Inbox" : st.name}
              </span>
            </span>
          ))}
          {!running && (
            <span className={`tag ${job.state === "done" ? "ok" : "ac"}`}>
              {job.state === "done" ? "done" : job.state === "failed" ? "didn't finish" : "stopped"}
            </span>
          )}
        </div>
        {steer != null && (
          <form
            className="row"
            style={{ marginBottom: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (steer.trim()) say(steer.trim());
              setSteer(null);
            }}
          >
            <input
              autoFocus
              className="grow"
              placeholder="Tell the agent, such as: use the existing date helper"
              value={steer}
              onChange={(e) => setSteer(e.target.value)}
            />
            <button className="btn primary" type="submit" disabled={!steer.trim()}>
              Send
            </button>
          </form>
        )}
        <div className="coding-grid">
          <div ref={term} className="mono coding-term">
            <div style={{ color: "var(--tx3)" }}>
              $ {c.agent.toLowerCase()} · {c.repo} ·{" "}
              {c.branch_link ? (
                <a href={c.branch_link} target="_blank" rel="noreferrer">
                  {c.branch}
                </a>
              ) : (
                c.branch
              )}
            </div>
            {c.log.map((e, i) => {
              const l = streamLine(e);
              return (
                <div key={i} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: l.tone }} title={e.text}>
                  {l.mark} <span style={{ color: "var(--tx3)" }}>{l.who.padEnd(6, " ")}</span> {l.text}
                </div>
              );
            })}
            {lastTool?.out && running && (
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  color: "var(--tx3)",
                  borderTop: "1px dashed var(--dash)",
                  marginTop: 6,
                  paddingTop: 6,
                }}
              >
                {lastTool.out.trim().split("\n").slice(-8).join("\n")}
              </div>
            )}
            {running && (
              <span className="blink" style={{ color: "var(--tx)" }}>
                {" "}
                _
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {c.question && (
              <div className="coding-box needs">
                <span className="lab ac">Waiting on you</span>
                <span>{c.question.text}</span>
                {c.question.why && <span className="muted small">{c.question.why}</span>}
                {c.question.site ? (
                  <a className="btn" href="#/inbox">
                    Answer in Inbox
                  </a>
                ) : (
                  <>
                    {c.question.options.length > 0 && (
                      <div className="row">
                        {c.question.options.map((o, n) => (
                          <button key={o} className={`btn ${n === 0 ? "primary" : ""}`} onClick={() => say(o)}>
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                    <form
                      className="row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (answer.trim()) say(answer.trim());
                        setAnswer("");
                      }}
                    >
                      <input className="grow" placeholder="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
                      <button className="btn" type="submit" disabled={!answer.trim()}>
                        Answer
                      </button>
                    </form>
                  </>
                )}
              </div>
            )}
            <div className="coding-box">
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <span className="lab grow">Atlas answered for you</span>
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {forYou.length} · ASKED YOU {askedYou}
                </span>
              </div>
              {!forYou.length && (
                <span className="muted small">
                  Nothing yet. Routine questions from the agent get answered here, each with where the answer came from.
                </span>
              )}
              {forYou.map((a, i) => (
                <div
                  key={i}
                  style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 8, borderTop: "1px dashed var(--dash)" }}
                >
                  <span className="small" style={{ color: "var(--tx2)" }}>
                    {a.q}
                  </span>
                  <span className="row small" style={{ gap: 8, alignItems: "flex-start", flexWrap: "nowrap" }}>
                    <Diamond size={10} />
                    <span>{a.a}</span>
                  </span>
                  <span className="mono faint" style={{ fontSize: 10.5 }}>
                    FROM {a.source.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
            {c.pr && (
              <div className="coding-box">
                <span className="lab">Pull request</span>
                <a href={c.pr.link} target="_blank" rel="noreferrer">
                  {c.pr.title}
                </a>
                <span className="muted small">Nothing is merged until you do.</span>
              </div>
            )}
            {c.error && (
              <div className="coding-box needs">
                <span className="lab ac">Why it stopped</span>
                <span className="small">{c.error}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/** A job the stage was asked to show that isn't in the list any more (it ended over an hour ago). */
export function JobGone() {
  return (
    <Sheet className="pick">
      <Empty title="That job isn't here any more">What it said and made is in the conversation, and its files are in Library.</Empty>
    </Sheet>
  );
}
