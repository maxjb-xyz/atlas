// Atlas settings → Permissions (§12, docs/ui §8): when Atlas asks first. The
// kind of action decides, by a rule in Atlas's code, not its judgment; then
// the trust you've given it, each with Ask again.

import type { SettingsView } from "../../../core/src/protocol";
import type { Atlas } from "../connection";
import { compose } from "../Shell";
import { useDetail } from "../theme";
import { Icon, type IconName, logoFor, LogoMark, Seg, shortDay } from "../ui";
import { Head } from "./parts";

const KINDS: Record<string, { icon: IconName; title: string; sub: string; options: Array<[string, string]>; value: string }> = {
  look: {
    icon: "eye",
    title: "Atlas looks without asking",
    sub: "Your mail, calendar, files and the web.",
    options: [
      ["ask", "Asks first"],
      ["never", "Just looks"],
    ],
    value: "never",
  },
  change_own: {
    icon: "pencil",
    title: "Changes your own things and tells you, with undo",
    sub: "Your calendar, notes and lists.",
    options: [
      ["ask", "Asks first"],
      ["never", "Does it, tells you"],
    ],
    value: "never",
  },
  outside: {
    icon: "chat",
    title: "Asks before it reaches outside, until you trust it",
    sub: "Messages, email, posts and webhooks. Say yes to the same one five times and it offers to stop asking.",
    options: [
      ["always", "Always asks"],
      ["until_trusted", "Until trusted"],
      ["never", "Never asks"],
    ],
    value: "until_trusted",
  },
  irreversible: {
    icon: "money",
    title: "Always asks about anything it can't undo",
    sub: "It shows you what it is, and you hold to confirm.",
    options: [],
    value: "always",
  },
};

export function Permissions({ atlas, view }: { atlas: Atlas; view: SettingsView }) {
  const { at } = useDetail();
  const kinds = Object.entries(view.permissions.kinds);
  return (
    <>
      <Head title="Permissions" sub="When Atlas asks you first. It's a rule in Atlas's code, not its judgment." />
      <div className="lines solid">
        {kinds.map(([k, v]) => {
          const K = KINDS[k];
          return (
            <div className="perm" key={k}>
              <span className="perm-icon">
                <Icon name={K?.icon ?? "shield"} size={16} />
              </span>
              <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span className="perm-title">{K?.title ?? k}</span>
                <span className="aside">{at("developer") ? v.why : (K?.sub ?? v.why)}</span>
              </div>
              {v.asks === "always" || !K?.options.length ? (
                <span className="aside row" style={{ gap: 6 }}>
                  <Icon name="lock" size={12} /> Always, and it can't be turned off
                </span>
              ) : (
                // TODO(core, stage 7): changing these within their floors (core/src/approvals.ts); until then they show as they are.
                <Seg label={K.title} value={v.asks === "until_trusted" ? "until_trusted" : v.asks} options={K.options} locked />
              )}
              {at("developer") && <span className="mono aside">{k}</span>}
            </div>
          );
        })}
      </div>

      <div className="set-sub">
        <span className="h2">Your own rules</span>
        <span className="aside">Trust you've given Atlas.</span>
      </div>
      {/* TODO(core, stage 7): rules the owner writes ("never email my professors without asking"), beside earned trust. */}
      <div className="rule-grid">
        {view.permissions.trusted.map((t) => (
          <div className="card2 rule-card" key={t.key}>
            <span className="logo" style={{ width: 30, height: 30, borderRadius: 7 }}>
              {logoFor(t.key.split(":")[1]) ? <LogoMark of={t.key.split(":")[1]!} size={16} /> : <Icon name="check" size={14} />}
            </span>
            <div className="grow" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontWeight: 500 }} className="clip">
                {t.name}
              </span>
              <span className="aside">
                Since {shortDay(t.since)}
                {at("developer") ? ` · ${t.key}` : ""}
              </span>
            </div>
            <button className="tbtn" onClick={() => atlas.send({ type: "atlas.trust.set", key: t.key, trusted: false })}>
              Ask again
            </button>
          </div>
        ))}
        <button className="card2 dash rule-card" onClick={() => compose("Never email my professors without asking")}>
          <span className="logo" style={{ width: 30, height: 30, borderRadius: 7 }}>
            <Icon name="plus" size={14} />
          </span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontWeight: 500 }}>Add a rule by asking</span>
            <span className="aside">Like: never email my professors without asking</span>
          </div>
        </button>
      </div>
      {!view.permissions.trusted.length && (
        <p className="aside" style={{ marginTop: 8 }}>
          Nothing trusted yet. After you've approved the same thing five times as it was, Atlas offers to stop asking.
        </p>
      )}
    </>
  );
}
