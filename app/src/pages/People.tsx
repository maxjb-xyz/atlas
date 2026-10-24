// People (§7, §21.2, docs/ui §8): Contacts (the people Atlas knows, each
// opening on the stage), Members (who shares this Atlas, §7.1) and Faces
// (Atlas as other people reach it, §7.2), each face opening in place with its
// rules as sentences at Simple, its conversations, and its stranger test.

import { useEffect, useState } from "react";
import type { AreaView, LogRow, RecordView, SettingsView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { Composer } from "../Shell";
import { StageSheet } from "../StageViews";
import { useDetail } from "../theme";
import {
  AreaChip,
  AreaDot,
  AreaTag,
  Avatar,
  Empty,
  Icon,
  type IconName,
  LogoMark,
  pressable,
  Seg,
  Sheet,
  shortDay,
  Stage,
  startOfDay,
  StateDot,
  Toggle,
} from "../ui";

type Tab = "contacts" | "members" | "faces";
type FaceV = SettingsView["faces"][number];

/** Asks for people, and again whenever records change. */
function usePeople(atlas: Atlas, text: string) {
  const s = atlas.state;
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.records.list", ref: "people", area: s.scope, record_type: "person", ...(text ? { text } : {}), limit: 500 });
  }, [s.scope, s.recordsVersion, text, atlas.voice.connected]);
  return s.records.people;
}

/** The faces' conversations, from History. */
function useFaceRows(atlas: Atlas): LogRow[] {
  const s = atlas.state;
  useEffect(() => {
    if (atlas.voice.connected) atlas.send({ type: "atlas.history", filter: "faces", day_start: startOfDay(new Date()).getTime() });
  }, [atlas.voice.connected, s.rows.length]);
  return s.history?.filter === "faces" ? s.history.rows : [];
}

export function People({ atlas, detail, go }: { atlas: Atlas; detail: string; go: (d: string) => void }) {
  const s = atlas.state;
  const view = s.view;
  const [head = "", rest = ""] = [detail.split(":")[0], detail.split(":").slice(1).join(":")];
  const tab: Tab = head === "members" ? "members" : head === "faces" || head === "face" ? "faces" : "contacts";
  const people = s.records.people;
  const members = view?.members ?? [];
  const faces = view?.faces ?? [];
  const meta =
    tab === "contacts"
      ? head === "person"
        ? "Contact"
        : `${people?.records.length ?? 0} people`
      : tab === "members"
        ? `${members.filter((m) => m.joined_at).length + 1} members${members.some((m) => !m.joined_at && m.invite_open) ? ` · ${members.filter((m) => !m.joined_at && m.invite_open).length} invite out` : ""}`
        : `${faces.length} ${faces.length === 1 ? "face" : "faces"} · ${faces.filter((f) => f.on).length} on`;
  return (
    <Stage
      label="People"
      tabs={[
        { id: "contacts", label: "Contacts", badge: people?.records.length || null },
        { id: "members", label: "Members", badge: view?.me ? null : members.filter((m) => m.joined_at).length + 1 },
        { id: "faces", label: "Faces", badge: faces.length || null },
      ]}
      tab={tab}
      onTab={(t) => go(t === "contacts" ? "" : t)}
      meta={meta}
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder="Ask about anyone, or say who a face should answer" />
        </div>
      }
    >
      {head === "person" && rest ? (
        <StageSheet
          atlas={atlas}
          shown={{ id: detail, view: { kind: "person", person: rest }, title: "" }}
          onClose={() => go("")}
          onOpen={(v) => {
            if (v.kind === "person") go(`person:${v.person}`);
          }}
        />
      ) : (
        <Sheet>
          {!view ? (
            <p className="muted sheet-in">Loading.</p>
          ) : (
            <div className="rise" key={tab + rest}>
              {tab === "contacts" && <Contacts atlas={atlas} go={go} />}
              {tab === "members" && <Members atlas={atlas} view={view} />}
              {tab === "faces" &&
                (head === "face" && faces.some((f) => f.id === rest) ? (
                  <FaceOpen atlas={atlas} view={view} face={faces.find((f) => f.id === rest)!} onBack={() => go("faces")} />
                ) : head === "face" && rest === "new" ? (
                  <div className="sheet-in">
                    <button className="back" onClick={() => go("faces")}>
                      <Icon name="left" size={14} /> All faces
                    </button>
                    <FaceEditor atlas={atlas} view={view} face={null} done={() => go("faces")} />
                  </div>
                ) : (
                  <Faces atlas={atlas} view={view} go={go} />
                ))}
            </div>
          )}
        </Sheet>
      )}
    </Stage>
  );
}

// --- contacts -----------------------------------------------------------------------------

const TRUSTS: Array<[string, string]> = [
  ["family", "Family"],
  ["friend", "Friends"],
  ["colleague", "Colleagues"],
  ["client", "Clients"],
  ["unknown", "Unknown"],
];
const REACH: Record<string, IconName> = { email: "mail", phone: "phone", telegram: "send" };

/** A person's photo, when the address book gave one. */
const photoOf = (r: RecordView) =>
  typeof r.details.photo === "string" && /^(data:image\/|https:\/\/)/.test(r.details.photo) ? r.details.photo : null;

function Contacts({ atlas, go }: { atlas: Atlas; go: (d: string) => void }) {
  const s = atlas.state;
  const { at } = useDetail();
  const [text, setText] = useState("");
  const [trust, setTrust] = useState("all");
  const data = usePeople(atlas, text.trim());
  const all = data?.records ?? [];
  const list = all.filter((r) => trust === "all" || (r.trust ?? "unknown") === trust);
  const week = all.filter((r) => r.learned_at > Date.now() - 30 * 86_400_000).length;
  const areaOf = (r: RecordView) => s.areas.find((a) => r.areas.includes(a.id));
  const imported = s.tests.contacts;
  const from = (s.view?.extensions ?? []).filter((e) => e.state === "on" && e.provides.includes("contacts"));
  return (
    <div className="sheet-in">
      <div className="map-title">
        <span className="disp">Contacts</span>
        <span className="muted">
          {all.length} {all.length === 1 ? "person" : "people"}
          {week ? ` · ${week} new this month` : ""}
        </span>
        <span className="grow" />
        <label className="find">
          <Icon name="search" size={13} />
          <input value={text} placeholder="Find someone" onChange={(e) => setText(e.target.value)} aria-label="Find someone" />
        </label>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={`fchip ${trust === "all" ? "on" : ""}`} onClick={() => setTrust("all")}>
          All <span className="mono aside">{all.length}</span>
        </button>
        {TRUSTS.map(([id, name]) => (
          <button key={id} className={`fchip ${trust === id ? "on" : ""}`} onClick={() => setTrust(id)}>
            {name} <span className="mono aside">{all.filter((r) => (r.trust ?? "unknown") === id).length}</span>
          </button>
        ))}
        <span className="grow" />
        {from.map((e) => (
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
      </div>
      {imported && (
        <p className={`small ${imported.ok ? "ok" : "err"}`} style={{ marginBottom: 8 }}>
          {imported.message}
        </p>
      )}
      {!data ? (
        <p className="lab">Looking</p>
      ) : !list.length ? (
        <Empty title={text ? "Nobody by that name" : "Nobody yet"}>
          {text ? "Try another name." : "Bring in your contacts, or tell Atlas about someone, and they show up here."}
        </Empty>
      ) : (
        <div className="ptable">
          <div className="prow head">
            <span />
            <span className="lab">Name</span>
            <span className="lab">Trust</span>
            <span className="lab hide-phone">Reach on</span>
            <span className="lab hide-phone">Areas</span>
            <span className="lab hide-phone">Updated</span>
          </div>
          {list.map((r) => (
            <div key={r.id} className="prow" {...pressable(() => go(`person:${r.id}`))}>
              {/* TODO(core): the address book's photo for each contact (RecordView.details.photo); until then, initials. */}
              <Avatar name={r.name} area={areaOf(r)} photo={photoOf(r)} size={28} />
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontWeight: 500 }} className="clip">
                  {r.name}
                </span>
                <span className="aside clip">{r.fact}</span>
              </span>
              <span>
                <span className={`trust ${r.trust ?? "unknown"}`}>
                  {(r.trust ?? "unknown")[0]!.toUpperCase() + (r.trust ?? "unknown").slice(1)}
                </span>
              </span>
              <span className="row hide-phone" style={{ gap: 8, color: "var(--tx2)" }}>
                {[...new Set((r.channels ?? []).map((c) => c.kind))].map((k) => (
                  <span
                    key={k}
                    title={(r.channels ?? [])
                      .filter((c) => c.kind === k)
                      .map((c) => c.value)
                      .join(", ")}
                  >
                    <Icon name={REACH[k] ?? "chat"} size={13} />
                  </span>
                ))}
              </span>
              <span className="hide-phone" onClick={(e) => e.stopPropagation()}>
                <AreaChip
                  ids={r.areas}
                  areas={s.areas}
                  onMove={s.areas.length ? (ids) => atlas.send({ type: "atlas.areas.set", ref: `rec:${r.id}`, areas: ids }) : undefined}
                />
              </span>
              <span className="small muted hide-phone">
                {shortDay(r.updated_at)}
                {at("developer") && <span className="mono aside"> · {r.id}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- members ------------------------------------------------------------------------------

function Members({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const s = atlas.state;
  const me = view.me;
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [copied, setCopied] = useState(false);
  const invited = s.invited;
  const canInvite = !me || me.role === "admin";
  const owner = view.settings.owner_name || "You";
  const areasOf = (id: string | null) =>
    s.areas.filter((a) => a.state !== "archived" && (id == null ? true : a.settings.shared_with.includes(id)));
  const shared = s.areas.filter((a) => a.settings.shared_with.length > 0);
  const nameOf = (id: string) => view.members.find((m) => m.id === id)?.name ?? "?";
  if (me)
    return (
      <div className="sheet-in">
        <div className="map-title">
          <span className="disp">Members</span>
        </div>
        <p>
          You share {me.owner}'s Atlas as {me.role === "admin" ? "an admin" : "a member"}. Your conversations and what you tell Atlas are
          yours alone; the areas shared with you are in Library.
        </p>
      </div>
    );
  return (
    <div className="sheet-in">
      <div className="map-title">
        <span className="disp">Members</span>
        <span className="muted">
          {view.members.filter((m) => m.joined_at).length + 1}{" "}
          {view.members.filter((m) => m.joined_at).length ? "people share" : "person uses"} this Atlas, each with their own
        </span>
      </div>
      <div className="dev-grid">
        <div className="card2 member">
          <div className="row" style={{ flexWrap: "nowrap", gap: 10, padding: "14px 16px 0" }}>
            <Avatar name={owner} size={34} />
            <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
              <span className="row" style={{ gap: 8 }}>
                <span className="disp" style={{ fontSize: 15 }}>
                  {owner}
                </span>
                <span className="aside">You</span>
              </span>
              <span className="small muted row" style={{ gap: 6 }}>
                <StateDot state="on" /> Here now
              </span>
            </span>
            <span className="trust">Owner</span>
          </div>
          <div className="kv2">
            <span>Shares</span>
            <span className="row" style={{ gap: 8 }}>
              {shared.length ? (
                shared.map((a) => (
                  <span key={a.id} className="row" style={{ gap: 5 }}>
                    <AreaDot area={a} square /> {a.name}
                  </span>
                ))
              ) : (
                <span className="muted">Nothing yet</span>
              )}
            </span>
            <span>Private</span>
            <span>
              {areasOf(null).length - shared.length} {areasOf(null).length - shared.length === 1 ? "area" : "areas"} only you see
            </span>
          </div>
          <div className="member-foot aside">Full control of this Atlas, its bills and its keys.</div>
        </div>
        {view.members.map((m) => (
          <div key={m.id} className="card2 member">
            <div className="row" style={{ flexWrap: "nowrap", gap: 10, padding: "14px 16px 0" }}>
              <Avatar name={m.name} size={34} />
              <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
                <span className="disp" style={{ fontSize: 15 }}>
                  {m.name}
                </span>
                <span className="small muted row" style={{ gap: 6 }}>
                  <StateDot state={m.joined_at ? "asleep" : "off"} />
                  {m.joined_at ? `Joined ${shortDay(m.joined_at)}` : m.invite_open ? "Invited, hasn't joined yet" : "The invite ran out"}
                </span>
              </span>
            </div>
            <div className="kv2">
              <span>Shares</span>
              <span className="row" style={{ gap: 8 }}>
                {areasOf(m.id).length ? (
                  areasOf(m.id).map((a) => (
                    <span key={a.id} className="row" style={{ gap: 5 }}>
                      <AreaDot area={a} square /> {a.name}
                    </span>
                  ))
                ) : (
                  <span className="muted">Nothing yet</span>
                )}
              </span>
              <span>Private</span>
              <span>Their own conversations and records</span>
              <span>Invited</span>
              <span>{shortDay(m.invited_at)}, by you</span>
            </div>
            <div className="member-foot row">
              <span className="aside">Role</span>
              <Seg
                small
                label={`${m.name}'s role`}
                value={m.role}
                options={[
                  ["admin", "Admin"],
                  ["member", "Member"],
                ]}
                onChange={(r) => atlas.send({ type: "atlas.member.role", id: m.id, role: r })}
              />
              <span className="grow" />
              {!m.joined_at && (
                <button className="tbtn" onClick={() => atlas.send({ type: "atlas.member.invite", name: m.name, role: m.role, id: m.id })}>
                  New link
                </button>
              )}
              <button className="tbtn" onClick={() => atlas.send({ type: "atlas.member.remove", id: m.id })}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="members-low">
        <div style={{ minWidth: 0 }}>
          <div className="set-sub">
            <span className="h2">Shared areas</span>
            <span className="aside">Everything else stays with whoever it belongs to.</span>
            <span className="grow" />
            <a className="tbtn" href="#/library/areas">
              Share an area
            </a>
          </div>
          <div className="lines solid">
            {shared.map((a) => (
              <div className="line" key={a.id} style={{ minHeight: 52 }}>
                <span style={{ display: "flex", flexDirection: "column", width: 140 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <AreaDot area={a} square /> <span style={{ fontWeight: 500 }}>{a.name}</span>
                  </span>
                  <span className="aside">{a.records} items</span>
                </span>
                <span className="row" style={{ gap: 0 }}>
                  <Avatar name={owner} size={20} />
                  {a.settings.shared_with.map((id) => (
                    <Avatar key={id} name={nameOf(id)} size={20} />
                  ))}
                </span>
                <span className="grow small muted">{a.about}</span>
              </div>
            ))}
            {!shared.length && (
              <p className="aside line">Nothing shared yet. Share an area from Library → Areas, and its records show for both of you.</p>
            )}
          </div>
          <p className="small muted row" style={{ gap: 8, marginTop: 10 }}>
            <Icon name="lock" size={13} /> No one can read another member's private records. That includes you.
          </p>
        </div>
        {canInvite && (
          <div className="card2 dash pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="h2">Invite someone</span>
            <span className="small muted">They get their own thread, records and voice. You pick what to share.</span>
            <input value={name} placeholder="Their name" onChange={(e) => setName(e.target.value)} />
            <Seg
              label="Role"
              value={role}
              options={[
                ["member", "Member"],
                ["admin", "Admin, who can invite too"],
              ]}
              onChange={setRole}
            />
            <button
              className="btnp s"
              style={{ alignSelf: "flex-start" }}
              disabled={!name.trim()}
              onClick={() => {
                atlas.send({ type: "atlas.member.invite", name: name.trim(), role });
                setName("");
                setCopied(false);
              }}
            >
              <Icon name="plus" size={12} /> Make an invite link
            </button>
            {invited && (
              <>
                <div className="linkbox">
                  <span className="mono clip grow">{invited.link}</span>
                  <button
                    className="btn s"
                    onClick={() => {
                      void navigator.clipboard?.writeText(invited.link).then(() => setCopied(true));
                    }}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
                <span className="aside">For {invited.name}. Works once and expires in 7 days.</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- faces --------------------------------------------------------------------------------

const SHARE_WORDS: Record<string, string> = {
  free_busy: "whether you're free or busy",
  public: "what you marked shareable",
  status: "how open work is going",
};
const CAN_WORDS: Record<string, string> = {
  messages: "take messages",
  hold_time: "hold time for you to confirm",
  answer: "answer questions",
  collect: "note people's details",
};
const PULL_WORDS: Record<string, string> = {
  urgent: "something's urgent",
  money: "money's involved",
  cant_answer: "it can't answer",
  people: "certain people write",
};

/** The places a face answers, by name, with their logos. */
function addressesOf(view: SettingsView) {
  return [
    ...(view.mail.address
      ? [{ id: "email", name: view.mail.address, short: "Atlas's email", logo: null as string | null, icon: "mail" as IconName }]
      : []),
    ...view.channels.map((c) => ({ id: c.ext, name: c.name, short: c.name, logo: c.ext as string | null, icon: "chat" as IconName })),
  ];
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

interface Conv {
  conv: string;
  from: string;
  first: string;
  at: number;
  outcome: string;
  handed: boolean;
  test: boolean;
}

/** A face's conversations, newest first, from the log: who wrote, what about, and how it ended. */
function conversations(rows: LogRow[], face: string): Conv[] {
  const by = new Map<string, Conv>();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const b = r.body as Record<string, unknown>;
    if (b.face !== face || typeof b.conv !== "string") continue;
    const c = by.get(b.conv) ?? {
      conv: b.conv,
      from: String(b.from ?? "Someone"),
      first: "",
      at: r.at,
      outcome: "",
      handed: false,
      test: !!b.test,
    };
    if (r.kind === "face.in" && !c.first) {
      c.first = String(b.text ?? "");
      c.from = String(b.from ?? c.from);
    }
    if (r.kind === "face.out") c.outcome = b.by === "owner" ? "You answered" : "Answered";
    if (r.kind === "face.handoff") {
      c.outcome = `Handed to you${b.kind === "message" ? ": a message" : ""}`;
      c.handed = true;
    }
    c.at = r.at;
    by.set(b.conv, c);
  }
  return [...by.values()].filter((c) => !c.test).sort((a, b) => b.at - a.at);
}

function Faces({ atlas, view, go }: { atlas: Atlas; view: SettingsView; go: (d: string) => void }) {
  const rows = useFaceRows(atlas);
  const s = atlas.state;
  const addresses = addressesOf(view);
  const all = view.faces.flatMap((f) => conversations(rows, f.id).map((c) => ({ ...c, face: f })));
  const weekAgo = Date.now() - 7 * 86_400_000;
  return (
    <div className="sheet-in">
      <div className="map-title">
        <span className="disp">Faces</span>
        <span className="muted">Atlas, for people who aren't you. Every face says it's an AI.</span>
        <span className="grow" />
        {!view.me && (
          <button className="btn" onClick={() => go("face:new")}>
            <Icon name="plus" size={12} /> New face
          </button>
        )}
      </div>
      {!addresses.length && (
        <p className="small muted" style={{ marginBottom: 10 }}>
          A face needs somewhere to answer: set up Atlas's email or a chat like Telegram in{" "}
          <a href="#/abilities/services">Abilities → Services</a>.
        </p>
      )}
      {!view.faces.length ? (
        <Empty title="No faces yet">Without one, Atlas tells people whose assistant it is and nothing more.</Empty>
      ) : (
        <div className="face-grid">
          {view.faces.map((f) => {
            const convs = conversations(rows, f.id);
            const week = convs.filter((c) => c.at > weekAgo);
            const handed = week.filter((c) => c.handed).length;
            const waiting = (s.inbox ?? []).filter((i) => i.kind === "face" && i.face?.name === f.name).length;
            const areas = f.areas.map((id) => s.areas.find((a) => a.id === id)).filter((a): a is AreaView => !!a);
            return (
              <div key={f.id} className="card2 face-card">
                <div className="row" style={{ flexWrap: "nowrap", gap: 10, padding: "14px 16px 0" }}>
                  <span className="logo" style={{ width: 34, height: 34 }}>
                    <Icon name="diamond" size={15} />
                  </span>
                  <span
                    className="grow"
                    style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
                    {...pressable(() => go(`face:${f.id}`))}
                  >
                    <span className="row" style={{ gap: 8 }}>
                      <span className="disp" style={{ fontSize: 17 }}>
                        {f.name}
                      </span>
                      {areas.map((a) => (
                        <span key={a.id} className="row aside" style={{ gap: 5 }}>
                          <AreaDot area={a} square /> {a.name}
                        </span>
                      ))}
                    </span>
                    <span className="small muted row" style={{ gap: 6 }}>
                      <StateDot state={f.on ? "on" : "off"} />
                      {f.on ? (convs[0] ? `On · last answered ${shortDay(convs[0].at)}` : "On") : "Paused"}
                    </span>
                  </span>
                  <Toggle
                    on={f.on}
                    label={`${f.name} on`}
                    onChange={(on) => atlas.send({ type: "atlas.face.save", face: faceInput(f, { on }) })}
                  />
                </div>
                {f.intro && (
                  <p className="small muted" style={{ padding: "8px 16px 0" }}>
                    “{f.intro}”
                  </p>
                )}
                <div className="row" style={{ gap: 6, padding: "8px 16px 0" }}>
                  {f.addresses.map((id) => {
                    const a = addresses.find((x) => x.id === id);
                    return (
                      <span key={id} className="nch">
                        {a?.logo ? <LogoMark of={a.logo} size={12} /> : <Icon name={a?.icon ?? "chat"} size={12} />}
                        <span className={id === "email" ? "mono small" : ""}>{a?.name ?? id}</span>
                      </span>
                    );
                  })}
                </div>
                <div className="kv2" {...pressable(() => go(`face:${f.id}`))}>
                  <span>Answers</span>
                  <span>
                    {f.audience === "anyone" ? "Anyone" : f.audience === "known" ? "People you know" : `Only ${list(f.people_names)}`}
                  </span>
                  <span>Shares</span>
                  <span>
                    {list([...new Set(Object.values(f.shares).flat())].map((k) => SHARE_WORDS[k] ?? k)) || "Nothing but messages"}
                  </span>
                  <span>Can</span>
                  <span>{cap(list(f.can.map((k) => CAN_WORDS[k] ?? k)))}</span>
                  <span>Pulls you in</span>
                  <span>{f.pulls.length ? `When ${list(f.pulls.map((k) => PULL_WORDS[k] ?? k))}` : "Never"}</span>
                  <span>Speaks as</span>
                  <span>{f.speaks_as === "atlas" ? "Atlas" : "You, with your OK"}</span>
                  <span>Digest</span>
                  <span>{f.digest === "daily" ? "Daily, in Inbox" : "None"}</span>
                </div>
                <div className="member-foot row">
                  <span className="small">
                    <b>{week.length}</b> {week.length === 1 ? "conversation" : "conversations"} this week · <b>{handed}</b> handed to you
                  </span>
                  <span className="grow" />
                  {waiting ? (
                    <a className="tag ac" href="#/inbox">
                      {waiting} in Inbox
                    </a>
                  ) : (
                    <span className="aside">Nothing waiting</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {all.length > 0 && (
        <>
          <div className="set-sub">
            <span className="h2">Latest conversations</span>
            <span className="aside">All of them are in History. What a face hands you goes to Inbox.</span>
          </div>
          <ConvList convs={all.slice(0, 6)} areas={s.areas} />
        </>
      )}
    </div>
  );
}

const cap = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

function ConvList({ convs, areas }: { convs: Array<Conv & { face?: FaceV }>; areas: AreaView[] }) {
  return (
    <div className="lines solid">
      {convs.map((c) => {
        const area = c.face ? areas.find((a) => c.face!.areas.includes(a.id)) : undefined;
        return (
          <a key={c.conv} className="conv" href="#/history">
            <Avatar name={c.from} area={area} size={24} />
            <span style={{ fontWeight: 500 }} className="clip">
              {c.from}
            </span>
            <span className="clip muted">{c.first}</span>
            {c.face && (
              <span className="row aside" style={{ gap: 5 }}>
                <AreaDot area={area} square /> {c.face.name}
              </span>
            )}
            <span className={`small ${c.handed ? "ac" : "muted"} row`} style={{ gap: 6 }}>
              {c.handed ? <span className="sq-ac" /> : <Icon name="check" size={12} style={{ color: "var(--ok)" }} />}
              {c.outcome || "Waiting"}
            </span>
            <span className="mono aside" style={{ textAlign: "right" }}>
              {shortDay(c.at)}
            </span>
          </a>
        );
      })}
    </div>
  );
}

/** A face's settings as the save message takes them, with a change. */
function faceInput(f: FaceV, patch: Partial<FaceV> = {}) {
  const x = { ...f, ...patch };
  return {
    id: x.id,
    name: x.name,
    intro: x.intro,
    addresses: x.addresses,
    audience: x.audience,
    people: x.people_names,
    areas: x.areas,
    shares: x.shares,
    can: x.can,
    pulls: x.pulls,
    pull_people: x.pull_names,
    speaks_as: x.speaks_as,
    digest: x.digest,
    on: x.on,
  };
}

function FaceOpen({ atlas, view, face: f, onBack }: { atlas: Atlas; view: SettingsView; face: FaceV; onBack: () => void }) {
  const s = atlas.state;
  const { at } = useDetail();
  const [more, setMore] = useState(false);
  const [mode, setMode] = useState<"view" | "edit" | "talk">("view");
  const dev = more || at("developer");
  const rows = useFaceRows(atlas);
  const convs = conversations(rows, f.id);
  const addresses = addressesOf(view);
  const areas = f.areas.map((id) => s.areas.find((a) => a.id === id)).filter((a): a is AreaView => !!a);
  const where = f.addresses.map((id) => addresses.find((a) => a.id === id)).filter((a) => a != null);
  const shares = [...new Set(Object.values(f.shares).flat())].map((k) => SHARE_WORDS[k] ?? k);
  // This week, Monday on: conversations a day.
  const monday = startOfDay(new Date());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const days = Array.from(
    { length: 7 },
    (_, i) => convs.filter((c) => c.at >= monday.getTime() + i * 86_400_000 && c.at < monday.getTime() + (i + 1) * 86_400_000).length,
  );
  const week = convs.filter((c) => c.at >= monday.getTime());
  const handed = week.filter((c) => c.handed).length;
  const maxDay = Math.max(1, ...days);
  const today = (new Date().getDay() + 6) % 7;
  const chip = (a: (typeof where)[number]) => (
    <span key={a.id} className="nch">
      {a.logo ? <LogoMark of={a.logo} size={12} /> : <Icon name={a.icon} size={12} />}{" "}
      {a.id === "email" ? <span className="mono small">{a.name}</span> : a.short}
    </span>
  );

  if (mode === "edit")
    return (
      <div className="sheet-in">
        <button className="back" onClick={() => setMode("view")}>
          <Icon name="left" size={14} /> {f.name}
        </button>
        <FaceEditor atlas={atlas} view={view} face={f} done={() => setMode("view")} onRemoved={onBack} />
      </div>
    );

  return (
    <div className="sheet-in">
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="back" style={{ margin: 0 }} onClick={onBack}>
          <Icon name="left" size={14} /> All faces
        </button>
        <span className="grow" />
        {at("developer") && (
          <>
            <span className="aside">Speaks as</span>
            <Seg
              small
              label="Speaks as"
              value={f.speaks_as}
              options={[
                ["atlas", "Atlas"],
                ["owner", "You"],
              ]}
              onChange={(speaks_as) => atlas.send({ type: "atlas.face.save", face: faceInput(f, { speaks_as }) })}
            />
          </>
        )}
        {!at("developer") && (
          <button className="btn s" onClick={() => setMore(!more)}>
            {more ? "Hide details" : "Show details"}
          </button>
        )}
        <button className="btn s" onClick={() => setMode("edit")}>
          Edit
        </button>
        <button className={mode === "talk" ? "btn s" : "btnp s"} onClick={() => setMode(mode === "talk" ? "view" : "talk")}>
          <Icon name="chat" size={12} /> {mode === "talk" ? "Stop the test" : "Talk to it as a stranger"}
        </button>
        <button className="btn s" onClick={() => atlas.send({ type: "atlas.face.save", face: faceInput(f, { on: !f.on }) })}>
          {f.on ? "Pause" : "Turn on"}
        </button>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: "nowrap", alignItems: "center" }}>
        <span className="logo" style={{ width: 36, height: 36 }}>
          <Icon name="diamond" size={16} />
        </span>
        <span className="disp" style={{ fontSize: 26 }}>
          {f.name}
        </span>
        {areas.map((a) => (
          <AreaTag key={a.id} area={a} />
        ))}
        <span className="small muted row" style={{ gap: 6 }}>
          <StateDot state={f.on ? "on" : "off"} />
          {f.on ? (convs[0] ? `On, and answered ${shortDay(convs[0].at)}` : "On") : "Paused"}
        </span>
      </div>
      {f.intro && (
        <p className="muted" style={{ margin: "8px 0 16px 48px" }}>
          Introduces itself: “{f.intro}”
        </p>
      )}
      {mode === "talk" && <StrangerChat atlas={atlas} face={f} />}
      {!dev ? (
        <div className="card2 rules">
          <div className="rule-s">
            <Icon name="chat" size={15} />
            {where.length ? (
              <p className="say">
                Answers {f.audience === "anyone" ? "anyone" : f.audience === "known" ? "people you know" : list(f.people_names)} who writes
                to{" "}
                {where.map((a, i) => (
                  <span key={a!.id}>
                    {i > 0 && (i === where.length - 1 ? ", or " : ", ")}
                    {chip(a!)}
                  </span>
                ))}
                .
              </p>
            ) : (
              <p className="say">Answers nowhere yet. Pick where in Edit, once Atlas's email or a chat is set up.</p>
            )}
          </div>
          <div className="rule-s">
            <Icon name="book" size={15} />
            <p className="say">
              Talks about {areas.length ? areas.map((a) => <AreaTag key={a.id} area={a} />) : "nothing of yours"}
              {shares.length ? ` only: ${list(shares)}.` : " and shares nothing from them."} Never your other areas.
            </p>
          </div>
          <div className="rule-s">
            <Icon name="calendar" size={15} />
            <p className="say">{cap(list(f.can.map((k) => CAN_WORDS[k] ?? k)))}.</p>
          </div>
          <div className="rule-s">
            <Icon name="hand" size={15} />
            <p className="say">
              {f.pulls.length
                ? `Pulls you in when ${list(f.pulls.map((k) => PULL_WORDS[k] ?? k))}${f.pull_names.length ? ` (${list(f.pull_names)})` : ""}. Those go straight to your Inbox.`
                : "Never pulls you in."}
            </p>
          </div>
          <div className="rule-s">
            <Icon name="sun" size={15} />
            <p className="say">
              {f.digest === "daily"
                ? "Sends you a recap of its day in Inbox, and anything urgent right away."
                : "Sends no recap; anything urgent comes right away."}
            </p>
          </div>
          <div className="rule-s">
            <Icon name="shield" size={15} />
            <p className="say">
              {f.speaks_as === "atlas"
                ? "Always says it's an AI, and speaks as Atlas, never as you."
                : "Always says it's an AI. It speaks as you, so each answer waits for your OK until you trust it."}
            </p>
          </div>
        </div>
      ) : (
        <div className="flow face-flow">
          <div className="flow-box">
            <span className="h2">Who it answers</span>
            <span className="flow-item">
              {f.audience === "anyone" ? "Anyone" : f.audience === "known" ? "People you know" : list(f.people_names)}
            </span>
            {where.map((a) => (
              <span key={a!.id} className="flow-item row" style={{ flexDirection: "row", gap: 6 }}>
                {a!.logo ? <LogoMark of={a!.logo} size={12} /> : <Icon name={a!.icon} size={12} />}{" "}
                <span className={a!.id === "email" ? "mono small" : ""}>{a!.name}</span>
              </span>
            ))}
            <span className="aside">Always says it's an AI</span>
          </div>
          <span className="flow-dash" />
          <div className="flow-box">
            <span className="h2">Covers and shares</span>
            {areas.map((a) => (
              <span key={a.id} className="flow-item row" style={{ flexDirection: "row", gap: 6, fontWeight: 500 }}>
                <AreaDot area={a} square /> {a.name}
              </span>
            ))}
            {shares.map((x) => (
              <span key={x} className="flow-item">
                {cap(x)}
              </span>
            ))}
            <span className="aside">Never mentions other areas</span>
          </div>
          <span className="flow-dash" />
          <div className="flow-box">
            <span className="h2">What it can do</span>
            {f.can.map((k) => (
              <span key={k} className="flow-item">
                {cap(CAN_WORDS[k] ?? k)}
              </span>
            ))}
          </div>
          <span className="flow-dash" />
          <div className="flow-box">
            <span className="h2">When it pulls you in</span>
            {f.pulls.map((k) => (
              <span key={k} className="flow-item">
                {cap(PULL_WORDS[k] ?? k)}
              </span>
            ))}
            <span className="aside ac">Straight to Inbox</span>
          </div>
          <span className="flow-dash" />
          <div className="flow-box">
            <span className="h2">Digest</span>
            <span className="flow-item" style={{ fontWeight: 500 }}>
              {f.digest === "daily" ? "Daily, in Inbox" : "None"}
            </span>
            <span className="flow-item">Urgent ones at once</span>
            {at("developer") && <span className="mono aside">{f.id}</span>}
          </div>
        </div>
      )}
      <div className="face-low">
        <div style={{ minWidth: 0 }}>
          <div className="set-sub">
            <span className="h2">Recent conversations</span>
            <span className="aside">All of them are in History.</span>
          </div>
          {convs.length ? <ConvList convs={convs.slice(0, 6)} areas={s.areas} /> : <p className="aside">Nobody has written to it yet.</p>}
        </div>
        <div className="card2 pad week-card">
          <div className="row">
            <span className="h2 grow">This week</span>
            <span className="aside">Since Monday</span>
          </div>
          <div className="stats3">
            <span className="stat">
              <b className="disp">{week.length}</b>
              <span className="aside">conversations</span>
            </span>
            <span className="stat">
              <b className="disp">{week.length - handed}</b>
              <span className="aside">handled alone</span>
            </span>
            <span className="stat">
              <b className="disp">{handed}</b>
              <span className="aside">handed to you</span>
            </span>
          </div>
          <div className="bars" aria-hidden>
            {days.map((n, i) => (
              <span key={i} className="bar-col">
                <i
                  style={{
                    height: `${Math.max(2, (n / maxDay) * 26)}px`,
                    background: n ? (areas[0] ? `var(--a${areas[0].color % 8})` : "var(--tx3)") : "var(--sep2)",
                    opacity: i === today ? 1 : 0.6,
                  }}
                />
                <span className="aside">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** "Talk to it as a stranger" (§7.2): a test chat that sees only what the face would. Nothing in it goes anywhere. */
function StrangerChat({ atlas, face }: { atlas: Atlas; face: FaceV }) {
  const [conv] = useState(() => `${face.id}-${Date.now().toString(36)}`);
  const [mine, setMine] = useState<string[]>([]);
  const [text, setText] = useState("");
  const theirs = atlas.state.faceSaid[conv] ?? [];
  const waiting = mine.length > theirs.length;
  return (
    <div className="card2 dim pad stranger rise">
      <span className="aside">You're a stranger here. It sees only what {face.name} would, and nothing in this test goes anywhere.</span>
      {mine.map((m, i) => (
        <div key={i} className="stranger-turn">
          <p>
            <b>You:</b> {m}
          </p>
          {theirs[i] && (
            <p className={theirs[i]!.ok ? "" : "err"}>
              <b>{face.name}:</b> {theirs[i]!.text}
            </p>
          )}
        </div>
      ))}
      {waiting && <p className="aside">{face.name} is writing.</p>}
      <form
        className="row"
        style={{ flexWrap: "nowrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || waiting) return;
          setMine([...mine, text.trim()]);
          atlas.send({ type: "atlas.face.test", id: face.id, conv, text: text.trim() });
          setText("");
        }}
      >
        <input autoFocus value={text} placeholder="Write as someone who doesn't know you" onChange={(e) => setText(e.target.value)} />
        <button className="btnp s" disabled={!text.trim() || waiting}>
          Send
        </button>
      </form>
    </div>
  );
}

/** Making or changing a face: its name and introduction, where it answers, who for, what it covers, can do and pulls you in for. */
function FaceEditor({
  atlas,
  view,
  face,
  done,
  onRemoved,
}: {
  atlas: Atlas;
  view: SettingsView;
  face: FaceV | null;
  done: () => void;
  onRemoved?: () => void;
}) {
  const areas = atlas.state.areas.filter((a) => a.state !== "archived");
  const addresses = addressesOf(view);
  const [f, setF] = useState(() => ({
    name: face?.name ?? "",
    intro: face?.intro ?? "",
    addresses: face?.addresses ?? addresses.map((a) => a.id).slice(0, 1),
    audience: face?.audience ?? ("anyone" as FaceV["audience"]),
    people: face?.people_names.join(", ") ?? "",
    areas: face?.areas ?? [],
    shares: face?.shares ?? ({} as FaceV["shares"]),
    can: face?.can ?? (["messages", "answer"] as FaceV["can"]),
    pulls: face?.pulls ?? (["urgent", "money", "cant_answer"] as FaceV["pulls"]),
    pull_people: face?.pull_names.join(", ") ?? "",
    speaks_as: face?.speaks_as ?? ("atlas" as FaceV["speaks_as"]),
    digest: face?.digest ?? ("daily" as FaceV["digest"]),
    on: face?.on ?? true,
  }));
  const toggle = <T extends string>(xs: T[], v: T) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]);
  const names = (t: string) =>
    t
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const save = () => {
    atlas.send({
      type: "atlas.face.save",
      face: { ...(face ? { id: face.id } : {}), ...f, people: names(f.people), pull_people: names(f.pull_people) },
    });
    done();
  };
  const Pick = ({ on, label, flip }: { on: boolean; label: string; flip: () => void }) => (
    <div className="line">
      <span className="grow">{label}</span>
      <Toggle on={on} label={label} onChange={flip} />
    </div>
  );
  return (
    <div className="face-edit">
      <span className="disp" style={{ fontSize: 22 }}>
        {face ? `Change ${face.name}` : "A new face"}
      </span>
      <label className="field">
        <span>Name</span>
        <input value={f.name} placeholder="Front desk" onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label className="field">
        <span>How it introduces itself. It always says it's an AI.</span>
        <textarea rows={2} value={f.intro} onChange={(e) => setF({ ...f, intro: e.target.value })} />
      </label>
      <div className="two">
        <div className="card2 pad">
          <span className="h2">Where it answers</span>
          <div className="lines">
            {addresses.map((a) => (
              <Pick
                key={a.id}
                on={f.addresses.includes(a.id)}
                label={a.id === "email" ? `Atlas's email, ${a.name}` : a.name}
                flip={() => setF({ ...f, addresses: toggle(f.addresses, a.id) })}
              />
            ))}
            {!addresses.length && <p className="aside line">Nowhere yet: set up Atlas's email or a chat in Abilities → Services.</p>}
          </div>
          <span className="h2" style={{ display: "block", marginTop: 12 }}>
            Who it's for
          </span>
          <Seg
            label="Who it's for"
            value={f.audience}
            options={[
              ["anyone", "Anyone"],
              ["known", "People you know"],
              ["people", "Only these people"],
            ]}
            onChange={(audience) => setF({ ...f, audience })}
          />
          {f.audience === "people" && (
            <input
              style={{ marginTop: 8 }}
              value={f.people}
              placeholder="Their names, as Atlas knows them"
              onChange={(e) => setF({ ...f, people: e.target.value })}
            />
          )}
        </div>
        <div className="card2 pad">
          <span className="h2">The areas it covers, and what it shares</span>
          <div className="lines">
            {areas.map((a) => (
              <div key={a.id}>
                <Pick on={f.areas.includes(a.id)} label={a.name} flip={() => setF({ ...f, areas: toggle(f.areas, a.id) })} />
                {f.areas.includes(a.id) && (
                  <div className="row" style={{ gap: 6, padding: "0 0 8px 12px" }}>
                    {Object.entries(SHARE_WORDS).map(([k, label]) => {
                      const on = (f.shares[a.id] ?? []).includes(k as never);
                      return (
                        <button
                          key={k}
                          className={`fchip ${on ? "on" : ""}`}
                          onClick={() => setF({ ...f, shares: { ...f.shares, [a.id]: toggle(f.shares[a.id] ?? [], k as never) } })}
                        >
                          {on && <Icon name="check" size={11} />} {cap(label)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            {!areas.length && <p className="aside line">No areas yet: it can take messages and nothing more.</p>}
          </div>
        </div>
        <div className="card2 pad">
          <span className="h2">What it can do</span>
          <div className="lines">
            {Object.entries(CAN_WORDS).map(([k, label]) => (
              <Pick
                key={k}
                on={f.can.includes(k as never)}
                label={cap(label)}
                flip={() => setF({ ...f, can: toggle(f.can, k as never) })}
              />
            ))}
          </div>
        </div>
        <div className="card2 pad">
          <span className="h2">When it pulls you in</span>
          <div className="lines">
            {Object.entries(PULL_WORDS).map(([k, label]) => (
              <Pick
                key={k}
                on={f.pulls.includes(k as never)}
                label={cap(label)}
                flip={() => setF({ ...f, pulls: toggle(f.pulls, k as never) })}
              />
            ))}
          </div>
          {f.pulls.includes("people") && (
            <input
              value={f.pull_people}
              placeholder="Their names, comma separated"
              onChange={(e) => setF({ ...f, pull_people: e.target.value })}
            />
          )}
        </div>
      </div>
      <div className="row" style={{ gap: 28 }}>
        <div className="ctl-col">
          <span className="small muted">It speaks as</span>
          <Seg
            label="It speaks as"
            value={f.speaks_as}
            options={[
              ["atlas", "Atlas, on its own"],
              ["owner", "You, with your OK"],
            ]}
            onChange={(speaks_as) => setF({ ...f, speaks_as })}
          />
        </div>
        <div className="ctl-col">
          <span className="small muted">A recap of its day</span>
          <Seg
            label="Digest"
            value={f.digest}
            options={[
              ["daily", "Daily, in Inbox"],
              ["off", "None"],
            ]}
            onChange={(digest) => setF({ ...f, digest })}
          />
        </div>
        <div className="ctl-col">
          <span className="small muted">On</span>
          <Toggle on={f.on} label="On" onChange={(on) => setF({ ...f, on })} />
        </div>
      </div>
      <div className="row">
        <button className="btnp s" disabled={!f.name.trim()} onClick={save}>
          Save
        </button>
        <button className="btn s" onClick={done}>
          Cancel
        </button>
        <span className="grow" />
        {face && (
          <button
            className="btn s"
            onClick={() => {
              atlas.send({ type: "atlas.face.remove", id: face.id });
              (onRemoved ?? done)();
            }}
          >
            Remove this face
          </button>
        )}
      </div>
      <p className="aside">Changes apply to its next conversation.</p>
    </div>
  );
}
