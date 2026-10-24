// Abilities → Skills (§9.3, docs/ui §8): what Atlas knows how to do, written
// down so it does it the same way next time. Each shows how often it's used,
// who made it and its check, with reuse counted at the top. A row opens in
// place: what it says, every version, edit, download and archive.

import { useEffect, useState } from "react";
import type { SkillView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Markdown } from "../Markdown";
import { useDetail } from "../theme";
import { dayName, Empty, pressable, shortDay } from "../ui";

const DAY = 86_400_000;

function fresh(k: SkillView): string | null {
  const last = k.versions.at(-1);
  if (!last || last.by !== "atlas" || Date.now() - last.at > 7 * DAY) return null;
  const d = shortDay(last.at);
  return `${k.version === 1 ? "Learned" : "Improved"} ${/\d:\d\d/.test(d) ? "today" : d === "Yesterday" ? "yesterday" : d}`;
}

/** Uses as an ASCII meter: [■■■□□□]. */
const meter = (uses: number, max: number) => {
  const k = max ? Math.min(6, Math.round((uses / max) * 6)) : 0;
  return `[${"■".repeat(k)}${"□".repeat(6 - k)}]`;
};

export function Skills({ atlas }: { atlas: Atlas }) {
  const s = atlas.state;
  const { at } = useDetail();
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.skills" });
  }, [atlas.voice.connected, s.rows.length]);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; md: string } | null>(null);
  const skills = s.skills;
  const active = (skills ?? []).filter((k) => k.state === "active");
  const archived = (skills ?? []).filter((k) => k.state === "archived");
  const month = new Date();
  month.setDate(1);
  month.setHours(0, 0, 0, 0);
  const learned = active.filter((k) => (k.versions[0]?.at ?? k.updated_at) >= month.getTime() && k.made_by === "atlas").length;
  const reused = active.reduce((n, k) => n + k.uses, 0);
  const max = Math.max(1, ...active.map((k) => k.uses));
  const download = (name: string, md: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = `${name}.SKILL.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const row = (k: SkillView) => {
    const f = fresh(k);
    const check = k.checked
      ? k.checked.ok
        ? { text: `✓ Checked ${shortDay(k.checked.at)}`, cls: "ok" }
        : {
            text: `Broke ${shortDay(k.checked.at)}${k.checked.output ? `: ${k.checked.output.split("\n")[0]!.slice(0, 40)}` : ""}`,
            cls: "ac",
          }
      : { text: k.check ? "Not checked yet" : "No check", cls: "aside" };
    return (
      <div key={k.id} className="skill">
        <div className="skill-row" {...pressable(() => setOpen(open === k.id ? null : k.id))} aria-expanded={open === k.id}>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
              <span style={{ fontWeight: 600 }} className="clip">
                {k.name}
              </span>
              {f && <span className="tag fresh">{f}</span>}
            </span>
            <span className="aside clip">{k.description}</span>
          </span>
          {/* TODO(core): each skill's area (SkillView has none yet), shown as its tinted chip in this column. */}
          <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <span className="mono small muted">{meter(k.uses, max)}</span>
            <span className="mono aside">{k.uses}×</span>
          </span>
          <span className="small muted">
            {k.made_by === "owner" ? "You" : "Atlas"}
            {k.made_by === "atlas" || at("detailed") ? ` · v${k.version}` : ""}
          </span>
          <span className={`small ${check.cls}`}>{check.text}</span>
        </div>
        {open === k.id && (
          <div className="skill-open rise">
            <div className="card2 dim pad">
              <Markdown text={k.body} />
            </div>
            {at("detailed") && k.check && (
              <p className="small">
                <span className="lab">Check</span> <code className="mono">{k.check}</code>
              </p>
            )}
            {k.checked && !k.checked.ok && <pre className="code-block mono">{k.checked.output}</pre>}
            {k.files.length > 0 && (
              <p className="aside">
                {k.files.length} {k.files.length === 1 ? "file" : "files"} in its folder: {k.files.map((x) => x.path).join(", ")}
              </p>
            )}
            <div className="lines">
              {k.versions
                .slice()
                .reverse()
                .map((v) => (
                  <div className="line" key={v.n}>
                    <span className="mono aside" style={{ width: 28 }}>
                      v{v.n}
                    </span>
                    <span className="small grow">{v.note}</span>
                    <span className="aside">
                      {v.by === "owner" ? "You" : "Atlas"}, {dayName(v.at)}
                    </span>
                    {v.n !== k.version && (
                      <button className="tbtn" onClick={() => atlas.send({ type: "atlas.skill.restore", id: k.id, n: v.n })}>
                        Bring back
                      </button>
                    )}
                  </div>
                ))}
            </div>
            <div className="row">
              <button className="btn s" onClick={() => setEditing({ id: k.id, md: k.md })}>
                Edit
              </button>
              <button className="btn s" onClick={() => download(k.name, k.md)}>
                Download
              </button>
              <button
                className="btn s"
                onClick={() => atlas.send({ type: "atlas.skill.state", id: k.id, state: k.state === "active" ? "archived" : "active" })}
              >
                {k.state === "active" ? "Archive" : "Bring back"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="sheet-in">
      <div className="map-title">
        <span className="disp">What Atlas knows how to do</span>
        <span className="row muted" style={{ gap: 18 }}>
          <span>
            <b className="num">{active.length}</b> skills
          </span>
          <span>
            <b className="num">{learned}</b> learned this month
          </span>
          <span>
            <b className="num">{reused}</b> times opened again
          </span>
        </span>
        <span className="grow" />
        <button
          className="btn"
          onClick={() =>
            setEditing({ id: null, md: "---\nname: my-skill\ndescription: What it's for and when to use it.\n---\n\n1. The first step.\n" })
          }
        >
          Paste a SKILL.md
        </button>
        {/* TODO(stage 5): "Get skills" from the catalog's skill hubs. */}
      </div>
      {editing && (
        <form
          className="card2 pad rise"
          style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            atlas.send({ type: "atlas.skill.save", md: editing.md });
            setEditing(null);
          }}
        >
          <span className="aside">
            {editing.id ? "Edit it as a SKILL.md." : "A SKILL.md from Claude Code, Codex, Hermes or OpenClaw works here unchanged."}
          </span>
          <textarea
            className="mono"
            rows={14}
            spellCheck={false}
            value={editing.md}
            onChange={(e) => setEditing({ ...editing, md: e.target.value })}
          />
          <div className="row">
            <button className="btnp s" disabled={editing.md.trim().length < 20}>
              Save
            </button>
            <button type="button" className="btn s" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {skills == null ? (
        <p className="lab">Looking</p>
      ) : !active.length ? (
        <Empty title="No skills yet">
          After a task that took some working out and went the way you wanted, Atlas writes down how, and says "Learned a skill".
        </Empty>
      ) : (
        <>
          <div className="skill-row head">
            <span className="lab">Skill</span>
            <span className="lab">Used</span>
            <span className="lab">Made by</span>
            <span className="lab">Check</span>
          </div>
          {active.map(row)}
        </>
      )}
      {archived.length > 0 && (
        <>
          <div className="section-rule">
            <span className="lab">Archived · unused for months, never deleted</span>
          </div>
          {archived.map(row)}
        </>
      )}
    </div>
  );
}
