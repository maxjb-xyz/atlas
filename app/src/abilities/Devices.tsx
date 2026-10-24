// Abilities → Devices (§16.3, docs/ui §8): paired devices, each online or
// not, with a switch for each thing it offers (sensitive ones start off);
// the phone that says where you are; and pairing a new one. They dial out to
// Atlas, so nothing on your network is left open.

import { useEffect, useState } from "react";
import type { Atlas } from "../connection";
import { useDetail } from "../theme";
import { dayName, Empty, Icon, Logo, Sheet, shortDay, Stage, StateDot, Toggle } from "../ui";
import { Location } from "./Services";

/** Where the desktop app is published, and OwnTracks' home. */
const MAC_APP = "https://github.com/maxjb-xyz/atlas/releases";
const OWNTRACKS = "https://owntracks.org";

const logoOf = (platform: string | null, kind: string) =>
  /mac|darwin|ios|iphone|ipad/i.test(platform ?? "")
    ? "apple"
    : /pi|raspberry/i.test(platform ?? "") || kind === "home"
      ? "raspberrypi"
      : null;

export function Devices({ atlas, go }: { atlas: Atlas; go: (d: string) => void }) {
  const view = atlas.state.view!;
  const { at } = useDetail();
  const [removing, setRemoving] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const owntracks = view.extensions.find((e) => e.provides.includes("location"));
  return (
    <div className="sheet-in">
      <div className="map-title">
        <span className="disp">Devices</span>
        <span className="muted">They dial out to Atlas, so nothing on your network is left open.</span>
      </div>
      <div className="dev-grid">
        {view.nodes.map((n) => {
          const lg = logoOf(n.platform, n.kind);
          return (
            <div key={n.id} className="card2 pad dev">
              <div className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
                {lg ? (
                  <Logo of={lg} size={34} />
                ) : (
                  <span className="logo" style={{ width: 34, height: 34, borderRadius: 8 }}>
                    <Icon name="devices" size={16} />
                  </span>
                )}
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }} className="grow">
                  <span style={{ fontWeight: 600 }} className="clip">
                    {n.name}
                  </span>
                  <span className="aside">{n.platform ?? n.kind}</span>
                </span>
              </div>
              <span className="row" style={{ gap: 7 }}>
                <StateDot state={n.online ? "on" : "off"} />
                <span className="small">{n.online ? "Online" : `Offline since ${shortDay(n.last_seen)}`}</span>
              </span>
              <div className="lines">
                {n.capabilities.map((c) => (
                  <div className="line" key={c.name}>
                    <span className="grow clip" title={c.description}>
                      {c.name[0]!.toUpperCase() + c.name.slice(1).replace(/_/g, " ")}
                    </span>
                    <span className="aside">{c.acts ? "asks each time" : c.sensitive && !c.on ? "sensitive" : ""}</span>
                    <Toggle
                      on={c.on}
                      label={c.name.replace(/_/g, " ")}
                      onChange={(on) => atlas.send({ type: "atlas.node.allow", id: n.id, capability: c.name, on })}
                    />
                  </div>
                ))}
                {!n.capabilities.length && <p className="aside line">It says what it can do when it first connects.</p>}
              </div>
              <div className="row aside" style={{ marginTop: "auto" }}>
                {removing === n.id ? (
                  <>
                    <span className="grow small">Unpair it? It stops at once.</span>
                    <button
                      className="tbtn err"
                      onClick={() => {
                        atlas.send({ type: "atlas.node.remove", id: n.id });
                        setRemoving(null);
                      }}
                    >
                      Remove
                    </button>
                    <button className="tbtn" onClick={() => setRemoving(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <span className="grow">
                      Paired {dayName(n.paired_at)}
                      {at("developer") ? ` · ${n.id}` : ""}. Remove it here and it stops at once.
                    </span>
                    <button className="tbtn" onClick={() => setRemoving(n.id)}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {owntracks && (
          <div className="card2 pad dev">
            <div className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
              <Logo of="owntracks" size={34} />
              <span style={{ display: "flex", flexDirection: "column" }} className="grow">
                <span style={{ fontWeight: 600 }}>Your phone</span>
                <span className="aside">OwnTracks, for where you are</span>
              </span>
            </div>
            {owntracks.state === "on" ? (
              <div className="lines">
                <Location atlas={atlas} view={view} />
              </div>
            ) : (
              <span className="small muted">
                OwnTracks on your phone tells Atlas where you are, so it knows when to leave and where you've arrived.
              </span>
            )}
            <span className="row" style={{ marginTop: "auto" }}>
              <button className="btn s" onClick={() => go(`services:ext:${owntracks.id}`)}>
                {view.location.set_up ? "Set it up again" : "Set it up"}
              </button>
            </span>
          </div>
        )}
      </div>
      {!view.nodes.length && !owntracks && (
        <Empty title="No devices yet">Install Atlas for Mac, and it shows a code to pair it here.</Empty>
      )}

      <div className="card2 dash pad add-device">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
          <span className="h2" style={{ fontSize: 14 }}>
            Add a device
          </span>
          <span className="muted">Scan the code the desktop app shows with your phone, or type it here.</span>
          <span className="row" style={{ paddingTop: 4 }}>
            <input
              className="mono"
              value={code}
              placeholder="K7Q2-M9XA"
              onChange={(e) => setCode(e.target.value)}
              style={{ width: 160, letterSpacing: "0.14em" }}
              aria-label="The code from the device"
            />
            <a
              className="btnp s"
              href={`#/pair/${encodeURIComponent(code.trim())}`}
              aria-disabled={!code.trim()}
              onClick={(e) => !code.trim() && e.preventDefault()}
              style={{ textDecoration: "none" }}
            >
              Pair
            </a>
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 300, maxWidth: "100%" }}>
          <span style={{ fontWeight: 600 }}>Get the apps</span>
          <span className="muted">Atlas for Mac, and OwnTracks on your phone for where you are.</span>
          <span className="row" style={{ paddingTop: 4 }}>
            <a className="btn s" href={MAC_APP} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              Atlas for Mac
            </a>
            <a className="btn s" href={OWNTRACKS} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              OwnTracks
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Pairing a device (§16.3): what's asking, and a yes or no. The device shows the code; this is where it lands when scanned. */
export function Pair({ atlas, code }: { atlas: Atlas; code: string }) {
  const s = atlas.state;
  const [said, setSaid] = useState<boolean | null>(null);
  useEffect(() => {
    if (atlas.voice.connected && code) atlas.send({ type: "atlas.node.pairing", code });
  }, [code, atlas.voice.connected]);
  const asked = code in s.pairing ? { pairing: s.pairing[code] ?? null } : null;
  const done = said == null ? null : { yes: said, name: code in s.paired ? s.paired[code]! : null };
  const p = asked?.pairing;
  return (
    <Stage label="Pair a device">
      <Sheet>
        <div className="sheet-in" style={{ maxWidth: 560 }}>
          <div className="sheet-title">
            <h1 className="disp">
              {done ? (done.yes ? (done.name ? `Paired ${done.name}` : "Pairing") : "Not paired") : "Pair this device?"}
            </h1>
          </div>
          {done ? (
            <p>
              {done.yes && done.name
                ? `${done.name} connects in a moment. What it offers is in Abilities → Devices, with the sensitive things off until you turn them on.`
                : "Nothing was paired."}{" "}
              <a className="link" href="#/abilities/devices">
                Abilities → Devices
              </a>
            </p>
          ) : !asked ? (
            <p className="muted">{s.view ? "Looking up the code." : "Connecting to Atlas."}</p>
          ) : !p ? (
            <p className="err">
              That code isn't waiting to pair: it may be mistyped, or it ran out (codes last ten minutes). Start again on the device.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 15, marginBottom: 8 }}>
                <b>{p.name}</b> ({p.platform ?? p.kind}) wants to connect to your Atlas with code{" "}
                <span className="mono">{code.toUpperCase()}</span>.
              </p>
              <p className="muted small" style={{ marginBottom: 16 }}>
                Pair only a device you're setting up yourself, right now. Once paired, Atlas can use what it offers while it's online;
                anything that acts on it asks you first, and sensitive things start off. You can remove it any time.
              </p>
              <div className="row">
                <button
                  className="btnp"
                  onClick={() => {
                    setSaid(true);
                    atlas.send({ type: "atlas.node.pair", code, yes: true });
                  }}
                >
                  Pair
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setSaid(false);
                    atlas.send({ type: "atlas.node.pair", code, yes: false });
                  }}
                >
                  Not now
                </button>
              </div>
            </>
          )}
        </div>
      </Sheet>
    </Stage>
  );
}
