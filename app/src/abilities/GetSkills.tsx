// Abilities → Skills → Get skills (§9.3, §17): the skills in the catalog's
// skill hubs (Anthropic's, and any an added index lists), each with what
// it's for and Install. Installing opens the skill in full first: it's
// someone else's instructions, so it's read before it's kept. Installed ones
// say so, and one the hub changed since offers Update.

import { useEffect, useState } from "react";
import type { HubSkillView, HubView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Markdown } from "../Markdown";
import { Icon, pressable } from "../ui";

const size = (b: number) => (b < 1_000 ? `${b} B` : b < 1_000_000 ? `${Math.round(b / 1_000)} KB` : `${(b / 1_000_000).toFixed(1)} MB`);

/** The SKILL.md without its frontmatter, which the page shows as the name and the line above it. */
const bodyOf = (md: string) => md.replace(/\r\n/g, "\n").replace(/^\s*---\n[\s\S]*?\n---\s*\n?/, "");

export function GetSkills({
  atlas,
  start,
  onClose,
}: {
  atlas: Atlas;
  /** A skill to open at once: an update from the Skills page, read in full before it's installed. */
  start?: { hub: string; name: string } | null;
  onClose: () => void;
}) {
  const { hubs, hubPreview, hubNote } = atlas.state;
  const [chip, setChip] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<{ hub: string; name: string } | null>(start ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.hubs" });
    if (start) atlas.send({ type: "atlas.hub.preview", hub: start.hub, name: start.name });
  }, [atlas.voice.connected, start?.hub, start?.name]);
  useEffect(() => setOpen(start ?? null), [start?.hub, start?.name]);
  useEffect(() => setBusy(null), [hubNote]);

  const all = (hubs ?? []).flatMap((h) => (h.skills ?? []).map((k) => ({ h, k })));
  const words = q.trim().toLowerCase();
  const shown = all.filter(
    ({ h, k }) => (chip === "all" || h.id === chip) && (!words || `${k.name} ${k.description}`.toLowerCase().includes(words)),
  );
  const reading = hubs == null || hubs.some((h) => h.skills == null && !h.error);
  const failed = (hubs ?? []).filter((h) => h.error && h.skills == null);
  const key = (h: HubView, k: HubSkillView) => `${h.id}/${k.name}`;
  const note = hubNote && (!open || (hubNote.hub === open.hub && hubNote.name === open.name)) ? hubNote : null;

  const install = (h: HubView, k: HubSkillView) => {
    setBusy(key(h, k));
    atlas.send({ type: "atlas.hub.install", hub: h.id, name: k.name });
  };
  const see = (h: HubView, k: HubSkillView) => {
    setOpen({ hub: h.id, name: k.name });
    atlas.send({ type: "atlas.hub.preview", hub: h.id, name: k.name });
  };

  const opened = open ? all.find(({ h, k }) => h.id === open.hub && k.name === open.name) : null;
  if (opened) {
    const { h, k } = opened;
    const p = hubPreview?.hub === h.id && hubPreview.name === k.name ? hubPreview : null;
    return (
      <div className="card2 pad rise get-skills">
        <button className="back" onClick={() => setOpen(null)}>
          <Icon name="back" size={14} /> Get skills
        </button>
        <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }} className="grow">
            <span className="disp">{k.name}</span>
            <span className="aside">
              From {h.name},{" "}
              <a href={p?.preview?.url ?? h.url} target="_blank" rel="noreferrer">
                {h.repo}
              </a>{" "}
              at <span className="mono">{h.commit.slice(0, 7)}</span>
              {k.license ? ` · ${k.license}` : ""}
            </span>
          </span>
          {k.installed && !k.installed.update ? (
            <span className="tag ok">Installed</span>
          ) : (
            <button
              className="btnp s"
              disabled={!p?.preview || Boolean(k.problem) || k.taken || busy === key(h, k)}
              onClick={() => install(h, k)}
            >
              {busy === key(h, k) ? "Installing" : k.installed?.update ? "Update" : "Install"}
            </button>
          )}
        </div>
        {note && <p className={`small ${note.ok ? "ok" : "err"}`}>{note.text}</p>}
        <p className="small">{k.description}</p>
        {k.problem && <p className="small err">It can't be installed: {k.problem}.</p>}
        {k.taken && <p className="small err">You already have a skill called {k.name} that didn't come from here.</p>}
        <p className="aside">
          It's someone else's instructions, so read it before you install it. Its folder is kept as it is, and its scripts only ever run in
          the workspace.
        </p>
        {!p ? (
          <p className="lab">Fetching it</p>
        ) : p.error ? (
          <p className="small err">{p.error}</p>
        ) : (
          <>
            <div className="card2 dim pad">
              <Markdown text={bodyOf(p.preview!.md)} />
            </div>
            {p.preview!.files.length > 0 && (
              <div className="lines">
                <span className="lab">
                  {p.preview!.files.length} {p.preview!.files.length === 1 ? "file" : "files"} in its folder
                </span>
                {p.preview!.files.map((f) => (
                  <div className="line" key={f.path}>
                    <span className="mono small grow clip">{f.path}</span>
                    <span className="mono aside">{size(f.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="card2 pad rise get-skills">
      <div className="row" style={{ gap: 10 }}>
        <span className="disp">Get skills</span>
        <span className="aside grow">From the skill hubs in your catalog. Each opens in full before it's installed.</span>
        <button className="btn s" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="row">
        <button className={`fchip ${chip === "all" ? "on" : ""}`} onClick={() => setChip("all")}>
          All
          <span className="mono aside">{all.length}</span>
        </button>
        {(hubs ?? []).map((h) => (
          <button key={h.id} className={`fchip ${chip === h.id ? "on" : ""}`} onClick={() => setChip(h.id)} title={h.about ?? undefined}>
            {h.name}
            <span className="mono aside">{h.skills?.length ?? "…"}</span>
          </button>
        ))}
        <span className="grow" />
        <label className="find">
          <Icon name="search" size={13} />
          <input value={q} placeholder="Find a skill" onChange={(e) => setQ(e.target.value)} aria-label="Find a skill" />
        </label>
      </div>
      {note && <p className={`small ${note.ok ? "ok" : "err"}`}>{note.text}</p>}
      {failed.map((h) => (
        <p key={h.id} className="small err">
          Couldn't read {h.name}: {h.error}{" "}
          <button className="tbtn" onClick={() => atlas.send({ type: "atlas.hubs", again: true })}>
            Try again
          </button>
        </p>
      ))}
      {reading && <p className="lab">Reading the hubs</p>}
      {hubs && !hubs.length && <p className="aside">No index in your catalog lists a skill hub yet.</p>}
      <div className="svc-grid">
        {shown.map(({ h, k }) => (
          <div key={key(h, k)} className="card2 dim svc small-card hub-skill" {...pressable(() => see(h, k))}>
            <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }} className="clip">
                {k.name}
              </span>
              <span className="aside clamp2">{k.description}</span>
            </span>
            <span className="row" style={{ width: "100%", flexWrap: "nowrap", marginTop: "auto" }}>
              <span className="aside clip grow">{h.name}</span>
              {k.installed && !k.installed.update ? (
                <span className="tag ok">Installed</span>
              ) : k.problem || k.taken ? (
                <span className="aside">Can't install</span>
              ) : (
                <button
                  className="btn s"
                  onClick={(e) => {
                    e.stopPropagation();
                    see(h, k);
                  }}
                >
                  {k.installed?.update ? "Update" : "Install"}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {!reading && hubs && hubs.length > 0 && !shown.length && <p className="aside">Nothing matches that.</p>}
    </div>
  );
}
