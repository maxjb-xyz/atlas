// Atlas settings → Permissions (§12, docs/ui §8): when Atlas asks first. The
// kind of action decides, by a rule in Atlas's code, not its judgment; then
// the trust you've given it, each with Ask again.

import type { SettingsView } from "../../../core/src/protocol";
import type { Settings as SettingsT } from "../../../core/src/store/settings";
import type { Atlas } from "../connection";
import { useDetail } from "../theme";
import { Icon, type IconName, logoFor, LogoMark, Seg, shortDay } from "../ui";
import type { Edit } from "./index";
import { Head } from "./parts";

type Rules = SettingsT["permissions"];

/** The owner's own rules (VISION §12.3): each starts as Atlas behaved before, with what it can be instead. */
const RULES: Array<{ key: keyof Rules; icon: IconName; title: string; options: Array<[string, string]> }> = [
  {
    key: "sites",
    icon: "globe",
    title: "Websites the workspace reaches",
    options: [
      ["each", "Asks for each site"],
      ["any", "Any site"],
    ],
  },
  {
    key: "forms",
    icon: "pencil",
    title: "Forms in the browser",
    options: [
      ["ask", "Asks"],
      ["allowed_sites", "On sites you allowed"],
    ],
  },
  {
    key: "after_web",
    icon: "eye",
    title: "After reading the web, before anything leaves",
    options: [
      ["ask", "Asks"],
      ["trusted", "Not for what you trust"],
    ],
  },
  {
    key: "email_as_you",
    icon: "mail",
    title: "Email sent as you",
    options: [
      ["per_recipient", "Until you trust each recipient"],
      ["always", "Always asks"],
    ],
  },
  {
    key: "faces_known",
    icon: "people",
    title: "Faces replying to people Atlas knows",
    options: [
      ["until_trusted", "Until trusted"],
      ["send", "Sends"],
    ],
  },
  {
    key: "mcp",
    icon: "plug",
    title: "Tools on connected services",
    options: [
      ["per_tool", "One tool at a time"],
      ["per_service", "A whole service at once"],
    ],
  },
  {
    key: "device_tools",
    icon: "phone",
    title: "Tools on your devices",
    options: [
      ["until_trusted", "Until trusted"],
      ["always", "Always asks"],
    ],
  },
  {
    key: "calls",
    icon: "phone",
    title: "Atlas calling you",
    options: [
      ["never", "Never calls"],
      ["urgent", "About what can't wait"],
    ],
  },
];

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

export function Permissions({ atlas, view, draft, edit }: { atlas: Atlas; view: SettingsView; draft: SettingsT; edit: Edit }) {
  const rules = draft.permissions;
  const setRule = (k: keyof Rules, v: string) => edit({ permissions: { ...rules, [k]: v } as Rules });
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
              {k === "outside" ? (
                <Seg label={K!.title} value={rules.outside} options={K!.options} onChange={(x) => setRule("outside", x)} />
              ) : v.asks === "always" || !K?.options.length ? (
                <span className="aside row" style={{ gap: 6 }}>
                  <Icon name="lock" size={12} /> Always, and it can't be turned off
                </span>
              ) : (
                <Seg label={K.title} value={v.asks === "until_trusted" ? "until_trusted" : v.asks} options={K.options} locked />
              )}
              {at("developer") && <span className="mono aside">{k}</span>}
            </div>
          );
        })}
      </div>

      <div className="set-sub">
        <span className="h2">Your own rules</span>
        <span className="aside">Money, what can't be undone, and a vault login's first time on a site always ask.</span>
      </div>
      <div className="lines solid">
        {RULES.map((r) => (
          <div className="perm" key={r.key}>
            <span className="perm-icon">
              <Icon name={r.icon} size={16} />
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <span className="perm-title">{r.title}</span>
              {at("developer") && <span className="mono aside"> {r.key}</span>}
            </div>
            <Seg label={r.title} value={rules[r.key]} options={r.options} onChange={(x) => setRule(r.key, x)} />
          </div>
        ))}
      </div>

      <div className="set-sub">
        <span className="h2">What you trust</span>
        <span className="aside">Trust you've given Atlas.</span>
      </div>
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
      </div>
      {!view.permissions.trusted.length && (
        <p className="aside" style={{ marginTop: 8 }}>
          Nothing trusted yet. After you've approved the same thing five times as it was, Atlas offers to stop asking.
        </p>
      )}
    </>
  );
}
