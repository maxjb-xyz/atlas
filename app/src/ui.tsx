// The parts every page is built from (docs/ui/README.md §5): icons, the stage
// frame and its sheet, pill tabs, area chips, and the ASCII diamond.

import { type ReactNode, useEffect, useState } from "react";
import type { AreaView } from "../../core/src/protocol";

// --- icons (the locked line set) ----------------------------------------------------------

export const ICONS = {
  home: "M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 15h18",
  inbox:
    "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  agenda: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  automations: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  library: "M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  settings: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5",
  mic: "M9 2h6v12H9zM5 10a7 7 0 0 0 14 0M12 17v4",
  up: "M12 19V5M5 12l7-7 7 7",
  down: "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  place: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  layers: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  memory: "M12 2 2 12l10 10 10-10z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  play: "M6 4l14 8-14 8z",
  jobs: "M4 6h16M4 12h10M4 18h6",
} as const;

export function Icon({ name, size = 16, style }: { name: keyof typeof ICONS; size?: number; style?: React.CSSProperties }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden style={style}>
      <path d={ICONS[name]} />
    </svg>
  );
}

// --- the stage --------------------------------------------------------------------------

export interface Tab<T extends string> {
  id: T;
  label: string;
  badge?: number | string | null;
}

/** A page: its label, pill tabs and metadata on top, then the body. */
export function Stage<T extends string>({
  label,
  tabs,
  tab,
  onTab,
  meta,
  home,
  children,
  dock,
}: {
  label: string;
  tabs?: Tab<T>[];
  tab?: T;
  onTab?: (t: T) => void;
  meta?: ReactNode;
  home?: boolean;
  children: ReactNode;
  dock?: ReactNode;
}) {
  return (
    <section className="stage" aria-label={label}>
      <div className="rail l" aria-hidden />
      <div className="rail r" aria-hidden />
      <div className="rail-h" aria-hidden />
      <span className="node" aria-hidden style={{ left: 40, top: 56 }} />
      <span className="node" aria-hidden style={{ left: "calc(100% - 40px)", top: 56 }} />
      <div className="stage-head">
        <span className="lab" style={{ color: "var(--tx2)" }}>
          {label}
        </span>
        {tabs && (
          <>
            <span className="lab" style={{ color: "var(--sep2)" }}>
              /
            </span>
            <div className="tabs" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === tab}
                  className={t.id === tab ? "on" : ""}
                  onClick={() => onTab?.(t.id)}
                >
                  {t.label}
                  {t.badge != null && t.badge !== 0 && <span className="mono">{t.badge}</span>}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="grow" />
        <span className="lab meta">{meta}</span>
      </div>
      <div className={`stage-body ${home ? "home" : ""}`}>{children}</div>
      {dock}
    </section>
  );
}

/** One sheet on the stage, with square nodes on its corners. */
export function Sheet({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`sheet ${className ?? ""}`} style={style}>
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      <span className="node" aria-hidden />
      {children}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Diamond size={18} />
      <h2 className="disp">{title}</h2>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

// --- areas ------------------------------------------------------------------------------

export const areaColor = (a: Pick<AreaView, "color"> | undefined) => (a ? `var(--a${a.color % 8})` : "var(--tx3)");

export function AreaDot({ area, square }: { area?: AreaView; square?: boolean }) {
  return <span className={`dot ${square ? "sq" : ""}`} style={{ background: areaColor(area) }} />;
}

/** The area chip on anything tagged; tapping it moves the item (§6.3). */
export function AreaChip({ ids, areas, onMove }: { ids: string[]; areas: AreaView[]; onMove?: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const shown = ids.map((id) => areas.find((a) => a.id === id)).filter((a): a is AreaView => a != null);
  const label = shown.length ? shown.map((a) => a.name).join(", ") : "No area";
  if (!onMove) {
    return shown.length ? (
      <span className="chip">
        <AreaDot area={shown[0]} />
        {label}
      </span>
    ) : null;
  }
  return (
    <span style={{ position: "relative" }}>
      <button className="chip" onClick={() => setOpen(!open)} title="Move to another area">
        <AreaDot area={shown[0]} />
        {label}
      </button>
      {open && (
        <span className="pop rise" style={{ left: 0, top: 22 }} onMouseLeave={() => setOpen(false)}>
          <span className="head">
            <span className="lab">Move to</span>
          </span>
          {areas
            .filter((a) => a.state !== "archived")
            .map((a) => {
              const on = ids.includes(a.id);
              return (
                <button
                  key={a.id}
                  className={`item ${on ? "on" : ""}`}
                  onClick={() => {
                    onMove(on ? ids.filter((x) => x !== a.id) : [...ids, a.id]);
                    setOpen(false);
                  }}
                >
                  <AreaDot area={a} />
                  <span className="grow">{a.name}</span>
                  {on && <Icon name="check" size={13} />}
                </button>
              );
            })}
          {areas.length === 0 && <span className="foot">No areas yet. Atlas starts them as things come up, or add one in Library.</span>}
        </span>
      )}
    </span>
  );
}

// --- the diamond --------------------------------------------------------------------------

/** The flat mark, its four facets following the theme. */
export function Diamond({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="290 128 444 768" width={(size * 444) / 768} height={size} aria-hidden style={{ flex: "none" }}>
      <polygon points="512,128.96 290.84,418.52 512,505.16" style={{ fill: "var(--m1)" }} />
      <polygon points="512,128.96 512,505.16 733.16,418.52" style={{ fill: "var(--m2)" }} />
      <polygon points="512,895.04 290.84,418.52 512,505.16" style={{ fill: "var(--m3)" }} />
      <polygon points="512,895.04 512,505.16 733.16,418.52" style={{ fill: "var(--m4)" }} />
    </svg>
  );
}

/**
 * The ASCII diamond (§21.8): four facet layers drawn in characters, which
 * breathe on Now and in voice. `level` (0 to 1) makes it move with the audio.
 */
export function AsciiDiamond({ rows = 22, level = 0, breathe = true }: { rows?: number; level?: number; breathe?: boolean }) {
  const top = Math.round(rows * 0.42);
  const lines: ReactNode[] = [];
  const glyph = (facet: number, x: number, y: number) => {
    // Dense glyphs throughout; each facet's shade comes from its color (--m1 to --m4).
    const set = ["@#%&", "#%*+", "%#*@", "*+#="][facet - 1]!;
    return set[(x * 7 + y * 3 + Math.round(level * 6)) % set.length];
  };
  for (let y = 0; y < rows; y++) {
    const half = y < top ? (y + 1) / top : (rows - y) / (rows - top);
    const w = Math.max(1, Math.round(half * 9));
    const left: string[] = [];
    const right: string[] = [];
    for (let x = 0; x < w; x++) {
      left.push(glyph(y < top ? 1 : 3, x, y)!);
      right.push(glyph(y < top ? 2 : 4, x, y)!);
    }
    const pad = " ".repeat(9 - w);
    lines.push(
      <span key={y}>
        {pad}
        <span className={y < top ? "f1" : "f3"}>{left.join("")}</span>
        <span className={y < top ? "f2" : "f4"}>{right.join("")}</span>
        {"\n"}
      </span>,
    );
  }
  return (
    <pre
      className={`ascii ${breathe ? "breathe" : ""}`}
      aria-hidden
      style={level ? { transform: `scale(${1 + level * 0.25})` } : undefined}
    >
      {lines}
    </pre>
  );
}

// --- time ---------------------------------------------------------------------------------

export const clock = (at: number | Date) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const dayName = (at: number | Date) => new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
export const shortDay = (at: number | Date) => {
  const d = new Date(at);
  const today = new Date();
  const diff = Math.round((startOfDay(today).getTime() - startOfDay(d).getTime()) / 86_400_000);
  if (diff === 0) return clock(d);
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** A local date as YYYY-MM-DD, the form the agent reads in the owner's time zone. */
export const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Re-renders every `ms`, for clocks and countdowns. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// --- routing ------------------------------------------------------------------------------

export type Place = "home" | "inbox" | "agenda" | "automations" | "library" | "history" | "settings";

/** The place, and an optional detail ("library/areas"), kept in the address so back and forward work. */
export function useRoute(): [Place, string, (p: Place, detail?: string) => void] {
  const read = (): [Place, string] => {
    const [p = "home", d = ""] = location.hash.replace(/^#\/?/, "").split("/");
    const places: Place[] = ["home", "inbox", "agenda", "automations", "library", "history", "settings"];
    return [places.includes(p as Place) ? (p as Place) : "home", decodeURIComponent(d)];
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (p: Place, detail = "") => {
    location.hash = `/${p}${detail ? `/${encodeURIComponent(detail)}` : ""}`;
  };
  return [route[0], route[1], go];
}
