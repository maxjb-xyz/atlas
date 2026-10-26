// A space (VISION §21.3): an area shown as a room that feels like its own bot.
// Its feed is what Atlas said there on its own; its threads are the ones in it,
// and its message box starts a new one there. Its page, routines and rules are
// the area's. It has no memory or character of its own (§8.4): underneath, it's
// Atlas wearing the area's hat.

import { useEffect, useState } from "react";
import type { LogRow, ThreadView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Markdown } from "../Markdown";
import { ago, Composer, SpaceMark } from "../Shell";
import { StageSheet } from "../StageViews";
import { clock, Empty, Icon, shortDay, Stage, useNow } from "../ui";

type Tab = "feed" | "threads" | "page" | "routines";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function Space({ atlas, id }: { atlas: Atlas; id: string }) {
  const s = atlas.state;
  const area = s.areas.find((a) => a.id === id);
  const [tab, setTab] = useState<Tab>("feed");
  const now = useNow(60_000);
  useEffect(() => {
    setTab("feed");
  }, [id]);
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.space.feed", area: id });
    if (!s.automations) atlas.send({ type: "atlas.automations" });
  }, [id, atlas.voice.connected]);
  // What Atlas says there on its own arrives as it says it.
  const newest = s.rows.at(-1)?.seq;
  useEffect(() => {
    if (atlas.voice.connected && tab === "feed") atlas.send({ type: "atlas.space.feed", area: id });
  }, [newest]);

  if (!area) {
    return (
      <Stage label="Space">
        <Empty title="That space isn't here any more">It may have been merged into another, or put away in Library → Areas.</Empty>
      </Stage>
    );
  }
  const threads = s.threads.filter((t) => t.areas.includes(id));
  const feed = s.feeds[id];
  const routines = (s.automations ?? []).filter((a) => a.areas.includes(id));
  const focused = s.scope === id;

  return (
    <Stage
      label={area.name}
      title={
        <span className="page-title space-title">
          <SpaceMark area={area} size={28} />
          <span className="st-words">
            <span className="disp">{area.name}</span>
            {area.about && <span className="faint small clip">{area.about}</span>}
          </span>
        </span>
      }
      actions={
        <button
          className={`btn sm focus-btn ${focused ? "on" : ""}`}
          title="Focus: Atlas leads with this space, and what can wait from the others waits"
          onClick={() => atlas.send({ type: "atlas.scope.set", area: focused ? null : id })}
        >
          {focused ? "Focused" : "Focus"}
        </button>
      }
      tabs={[
        { id: "feed", label: "Feed" },
        { id: "threads", label: "Threads", badge: threads.length || null },
        { id: "page", label: "Page" },
        { id: "routines", label: "Routines", badge: routines.length || null },
      ]}
      tab={tab}
      onTab={(t) => setTab(t as Tab)}
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder={`Message ${area.name}: a new thread here`} space={id} reply={false} chip={false} />
        </div>
      }
    >
      <div className="space-body">
        {tab === "feed" && (
          <div className="feed">
            {feed == null && <p className="faint">Loading what Atlas said here.</p>}
            {feed?.length === 0 && (
              <Empty title={`Nothing from ${area.name} yet`}>
                What Atlas notices and does in this space on its own lands here: a nudge, a routine's report, something a job made.
              </Empty>
            )}
            {feed?.map((r) => (
              <Post key={r.id} atlas={atlas} row={r} area={id} now={now} />
            ))}
            {threads.length > 0 && (
              <div className="feed-threads">
                <span className="sub-head">Threads here</span>
                {threads.slice(0, 4).map((t) => (
                  <ThreadLine key={t.id} t={t} now={now} />
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "threads" && (
          <div className="feed">
            {threads.length === 0 && (
              <Empty title="No threads here yet">
                Say something below to start one in {area.name}, or start any message with @{area.name}.
              </Empty>
            )}
            {threads.map((t) => (
              <ThreadLine key={t.id} t={t} now={now} />
            ))}
          </div>
        )}
        {tab === "page" && (
          <StageSheet
            atlas={atlas}
            shown={{ id: `space:${id}`, view: { kind: "area", area: id }, title: area.name }}
            onOpen={(v) => {
              if (v.kind === "person") location.hash = `#/people/${encodeURIComponent(`person:${v.person}`)}`;
            }}
          />
        )}
        {tab === "routines" && (
          <div className="feed">
            {routines.length === 0 && (
              <Empty title="No routines here">Ask Atlas for one, like "every Friday, tell me what's left for {area.name}".</Empty>
            )}
            {routines.map((r) => (
              <a key={r.id} className="tline" href={`#/automations/${encodeURIComponent(r.id)}`}>
                <Icon name="automations" size={14} />
                <span className="grow">
                  <span className="tl1">{r.name}</span>
                  <span className="tl2 faint clip">{r.when_text}</span>
                </span>
                <span className={`small ${r.state === "on" ? "ok" : "faint"}`}>{r.state === "on" ? "On" : "Paused"}</span>
              </a>
            ))}
            <a className="link small rules-link" href={`#/library/${encodeURIComponent(`area:${id}`)}`}>
              Rules for {area.name}: tone, accounts, sharing and what Atlas does alone
            </a>
          </div>
        )}
      </div>
    </Stage>
  );
}

/** One of Atlas's posts in a space's feed; replying opens a thread on it in the space. */
function Post({ atlas, row, area, now }: { atlas: Atlas; row: LogRow; area: string; now: number }) {
  const [reply, setReply] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const made = starting ? atlas.state.made[starting] : undefined;
  useEffect(() => {
    if (made) location.hash = `/thread/${encodeURIComponent(made)}`;
  }, [made]);
  const text = str(row.body.text) || str(row.body.error);
  const send = () => {
    const t = reply?.trim();
    if (!t) return;
    const quote = text.length > 280 ? `${text.slice(0, 280)}…` : text;
    setStarting(atlas.startThread({ text: `About what you said: "${quote}"\n\n${t}`, areas: [area] }));
    setReply(null);
  };
  return (
    <article className="post rise">
      <span className="mark">
        <Icon name="diamond" size={13} />
      </span>
      <div className="p-body">
        <span className="p-when faint small" title={`${shortDay(row.at)} · ${clock(row.at)}`}>
          {ago(row.at, now) === "now"
            ? "Just now"
            : new Date(row.at).toDateString() === new Date(now).toDateString()
              ? clock(row.at)
              : `${shortDay(row.at)} · ${clock(row.at)}`}
        </span>
        <Markdown className="said" text={text} />
        {reply == null ? (
          <button className="link small p-reply" onClick={() => setReply("")}>
            {starting ? "Starting a thread" : "Reply in a thread"}
          </button>
        ) : (
          <form
            className="p-form"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input autoFocus value={reply} placeholder="Your reply starts a thread here" onChange={(e) => setReply(e.target.value)} />
            <button className="btn sm primary" disabled={!reply.trim()}>
              Reply
            </button>
            <button type="button" className="btn sm" onClick={() => setReply(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
    </article>
  );
}

function ThreadLine({ t, now }: { t: ThreadView; now: number }) {
  return (
    <a className="tline" href={`#/thread/${encodeURIComponent(t.id)}`}>
      {t.state === "working" ? <span className="live-dot" /> : <Icon name="chat" size={14} />}
      <span className="grow">
        <span className="tl1">{t.title}</span>
        {t.last && <span className="tl2 faint clip">{t.last.text}</span>}
      </span>
      <span className="faint small">{t.state === "working" ? "Working" : ago(t.last_at, now)}</span>
    </a>
  );
}
