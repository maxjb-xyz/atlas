// Atlas settings (§21.2, docs/ui §8): five sections, Atlas, Brains,
// Notifications, Permissions and Account. The section list sits inside the
// sheet. Every setting has its place (rule 6), and every check is a live test
// (§22). Services, skills and devices are in Abilities; members and faces in People.

import { useEffect, useState } from "react";
import type { Settings as SettingsT } from "../../../core/src/store/settings";
import type { Atlas } from "../connection";
import { Composer } from "../Shell";
import { useDetail } from "../theme";
import { Icon, type IconName, Sheet, Stage } from "../ui";
import { Account } from "./Account";
import { AtlasSection } from "./AtlasSection";
import { Brains } from "./Brains";
import { Notifications } from "./Notifications";
import { Permissions } from "./Permissions";

export type Edit = (p: Partial<SettingsT>) => void;

type Section = "atlas" | "brains" | "notifications" | "permissions" | "account";

const SECTIONS: Array<{ id: Section; name: string; icon: IconName }> = [
  { id: "atlas", name: "Atlas", icon: "diamond" },
  { id: "brains", name: "Brains", icon: "brains" },
  { id: "notifications", name: "Notifications", icon: "bell" },
  { id: "permissions", name: "Permissions", icon: "shield" },
  { id: "account", name: "Account", icon: "user" },
];

/** The pages that live under Settings (§21.2, changed 2026-10-26): what Atlas does on its own, what it's connected to, and what it did. */
const MORE: Array<{ href: string; name: string; icon: IconName }> = [
  { href: "#/automations", name: "Routines", icon: "automations" },
  { href: "#/abilities", name: "Connections", icon: "abilities" },
  { href: "#/history", name: "Activity", icon: "history" },
];

/** Where the sections of earlier versions went, so old links (and sign-ins that come back to one) still land. */
export const MOVED: Record<string, [place: "settings" | "abilities" | "people", detail: string]> = {
  character: ["settings", "atlas"],
  look: ["settings", "atlas:look"],
  data: ["settings", "account"],
  vault: ["settings", "account"],
  connections: ["abilities", "services"],
  extensions: ["abilities", "services"],
  skills: ["abilities", "skills"],
  devices: ["abilities", "devices"],
  people: ["people", "members"],
  faces: ["people", "faces"],
};

export function SettingsPage({
  atlas,
  detail,
  go,
  onSignOut,
  onSetup,
}: {
  atlas: Atlas;
  detail: string;
  go: (d: string) => void;
  onSignOut: () => void;
  onSetup: () => void;
}) {
  const view = atlas.state.view;
  const { at } = useDetail();
  const [base = ""] = detail.split("?");
  const [head = "", sub = ""] = base.split(":");
  const section = (SECTIONS.some((s) => s.id === head) ? head : "atlas") as Section;
  const [draft, setDraft] = useState<SettingsT | null>(view?.settings ?? null);
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (view && !dirty) setDraft(view.settings);
  }, [view, dirty]);

  const edit: Edit = (p) => {
    if (!draft) return;
    setDraft({ ...draft, ...p });
    setDirty(true);
    setProblem(null);
  };
  const save = () => {
    if (!draft || !view) return;
    const why = draftProblem(draft);
    // Kept as it is, so nothing typed is lost; the banner says what to fix.
    if (why) return setProblem(why);
    // Only what changed, so a change made elsewhere meanwhile (a pin, a sign-in) isn't undone.
    const changed = Object.fromEntries(
      Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(view.settings[k as keyof SettingsT])),
    );
    if (Object.keys(changed).length) atlas.send({ type: "atlas.settings.update", patch: changed });
    setDirty(false);
  };
  const name = SECTIONS.find((s) => s.id === section)!.name;
  const metaOf = (id: Section) =>
    id === "notifications" && view && at("developer") && view.settings.notifications.budget
      ? `${view.push.today}/${view.settings.notifications.budget}`
      : id === "account" && view?.updates.ready
        ? "Update"
        : id === "account" && at("developer")
          ? __ATLAS_VERSION__
          : "";
  const ready = view?.updates.ready && view.updates.newest ? `An update is ready: ${view.updates.newest.tag}` : "";

  return (
    <Stage
      label="Settings"
      tabs={[{ id: section, label: name }]}
      tab={section}
      // "An update is ready" when the daily look found a newer release (§23.2); otherwise, at Developer, which Atlas this is.
      meta={ready || (at("developer") ? `Atlas ${__ATLAS_VERSION__}` : "")}
      dock={
        <div className="dock slim">
          {dirty && (
            <div className="banner rise">
              <span className={`grow ${problem ? "err" : ""}`}>{problem ?? "You have changes that aren't saved."}</span>
              <button
                className="btn"
                onClick={() => {
                  setDirty(false);
                  setProblem(null);
                }}
              >
                Discard
              </button>
              <button className="btn primary" onClick={save}>
                Save
              </button>
            </div>
          )}
          <Composer atlas={atlas} placeholder="Change anything by asking, like: don't call me before 9 am" chip={false} />
        </div>
      }
    >
      <Sheet>
        <div className="set-shell">
          <nav className="set-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={s.id === section ? "on" : ""}
                aria-current={s.id === section ? "page" : undefined}
                onClick={() => go(s.id)}
              >
                <Icon name={s.icon} size={15} />
                <span className="grow">{s.name}</span>
                <span className="mono aside">{metaOf(s.id)}</span>
              </button>
            ))}
            {/* Routines, Connections and Activity are pages of their own that live under Settings (§21.2). */}
            <span className="set-sep" />
            {MORE.map((m) => (
              <a key={m.href} href={m.href}>
                <Icon name={m.icon} size={15} />
                <span className="grow">{m.name}</span>
                <Icon name="right" size={12} />
              </a>
            ))}
            <span className="grow" />
            <p className="aside set-foot">Anything here can also be done by asking.</p>
          </nav>
          <div className="set-body">
            {!view || !draft ? (
              <p className="muted">Loading settings.</p>
            ) : (
              <>
                {section === "atlas" && (
                  <AtlasSection
                    atlas={atlas}
                    draft={draft}
                    edit={edit}
                    view={view}
                    tab={sub === "voice" || sub === "look" ? sub : "character"}
                    onTab={(t) => go(t === "character" ? "atlas" : `atlas:${t}`)}
                  />
                )}
                {section === "brains" && <Brains atlas={atlas} draft={draft} edit={edit} view={view} />}
                {section === "notifications" && <Notifications atlas={atlas} draft={draft} edit={edit} view={view} />}
                {section === "permissions" && <Permissions atlas={atlas} view={view} draft={draft} edit={edit} />}
                {section === "account" && <Account atlas={atlas} view={view} onSignOut={onSignOut} onSetup={onSetup} />}
              </>
            )}
          </div>
        </div>
      </Sheet>
    </Stage>
  );
}

/** What would make the server refuse a draft, in plain words, or null. Mirrors the limits in core's settings. */
function draftProblem(d: SettingsT): string | null {
  if (!d.assistant_name.trim()) return "Give Atlas a name before saving.";
  if (d.assistant_name.length > 40) return "Atlas's name can be at most 40 characters.";
  if (d.owner_name.length > 80) return "Your name can be at most 80 characters.";
  if (d.character.notes.length > 2_000) return "The notes can be at most 2,000 characters.";
  for (const role of ["main", "voice"] as const) {
    if (d.brains[role].some((b) => !b.model.trim())) return "Every brain in a chain needs a model.";
  }
  return null;
}
