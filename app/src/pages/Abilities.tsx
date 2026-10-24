// Abilities (§21.2, docs/ui §8): what Atlas can do. It opens on a live map,
// then Services (a card per service, opening in place), Skills and Devices.

import { useEffect } from "react";
import { AbilitiesMap } from "../abilities/Map";
import { services } from "../abilities/model";
import { Devices } from "../abilities/Devices";
import { Services } from "../abilities/Services";
import { Skills } from "../abilities/Skills";
import type { Atlas } from "../connection";
import { Composer } from "../Shell";
import { useDetail } from "../theme";
import { type Place, Sheet, Stage } from "../ui";

type Tab = "map" | "services" | "skills" | "devices";

export function Abilities({
  atlas,
  detail,
  go,
  place,
}: {
  atlas: Atlas;
  detail: string;
  go: (d: string) => void;
  place: (p: Place, d?: string) => void;
}) {
  const s = atlas.state;
  const { at } = useDetail();
  // "services:ext:linear" opens a service in place; a sign-in coming back carries "?signin=ok&note=…".
  const [base = "", query = ""] = detail.split("?");
  const [head = "", ...rest] = base.split(":");
  const tab = (["services", "skills", "devices"].includes(head) ? head : "map") as Tab;
  const open = tab === "services" && rest.length ? rest.join(":") : null;
  const signin = new URLSearchParams(query);
  const note = signin.get("note") ? { ok: signin.get("signin") === "ok", text: signin.get("note")! } : null;
  useEffect(() => {
    if (!atlas.voice.connected) return;
    atlas.send({ type: "atlas.mcp" });
    atlas.send({ type: "atlas.skills" });
  }, [atlas.voice.connected]);
  const view = s.view;
  const all = view ? services(view, s.mcpServers) : [];
  const on = all.filter((x) => x.installed).length;
  const skills = (s.skills ?? []).filter((k) => k.state === "active");
  const nodes = view?.nodes ?? [];
  const online = nodes.filter((n) => n.online).length;
  const meta =
    tab === "map"
      ? "Live · updated now"
      : tab === "services"
        ? `${on} on · ${all.length - on} more`
        : tab === "skills"
          ? `${skills.length} ${skills.length === 1 ? "skill" : "skills"}${at("developer") ? ` · ${skills.filter((k) => k.made_by === "owner").length} yours` : ""}`
          : `${online} online · ${nodes.length - online} offline`;
  return (
    <Stage
      label="Abilities"
      tabs={[
        { id: "map", label: "Map" },
        { id: "services", label: "Services", badge: on || null },
        { id: "skills", label: "Skills", badge: skills.length || null },
        { id: "devices", label: "Devices", badge: nodes.length || null },
      ]}
      tab={tab}
      onTab={(t) => go(t === "map" ? "" : t)}
      meta={meta}
      dock={
        <div className="dock slim">
          <Composer atlas={atlas} placeholder="Ask what Atlas can do, or to set something up" />
        </div>
      }
    >
      <Sheet>
        {!view ? (
          <p className="muted sheet-in">Loading.</p>
        ) : (
          <div className="rise" key={tab + (open ?? "")}>
            {tab === "map" && <AbilitiesMap atlas={atlas} go={place} />}
            {tab === "services" && <Services atlas={atlas} open={open} go={go} note={note} />}
            {tab === "skills" && <Skills atlas={atlas} />}
            {tab === "devices" && <Devices atlas={atlas} go={go} />}
          </div>
        )}
      </Sheet>
    </Stage>
  );
}
