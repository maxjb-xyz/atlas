// The parts every page is built from (docs/ui/README.md §5, §8): icons, the
// stage frame and its sheet, pill tabs, the app's own controls (toggles,
// segmented choices, pickers), real logos, area chips and avatars in their
// area's color, and the living ASCII diamond.

import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AreaView } from "../../core/src/protocol";
import { LOGOS } from "./logos";
import { stillMotion } from "./theme";

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
  back: "M15 18l-6-6 6-6",
  left: "M19 12H5M12 19l-7-7 7-7",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  abilities: "M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-2h12v2",
  place: "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  layers: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  memory: "M12 2 2 12l10 10 10-10z",
  diamond: "M12 3 5 11l7 10 7-10z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  play: "M6 4l14 8-14 8z",
  jobs: "M4 6h16M4 12h10M4 18h6",
  brains:
    "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 9h6v6H9z",
  senses: "M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2M12 12h.01",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  terminal: "M4 17l6-6-6-6M12 19h8",
  plug: "M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z",
  skills: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM9 9l2 2 4-4",
  devices: "M2 18h20M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  browser: "M3 5h18v14H3zM3 9h18",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
  key: "M15 7a4 4 0 1 1-3.5 6L5 19.5V22H2v-3l6.5-6.5A4 4 0 0 1 15 7z",
  money: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  phone: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  pencil: "M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  hand: "M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0",
  sun: "M12 4V2M12 22v-2M4.9 4.9 3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z",
  book: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: React.CSSProperties }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden style={style}>
      <path d={ICONS[name]} />
    </svg>
  );
}

/** The line icons an area can take (core's AREA_ICONS), drawn in the area's color. */
export const AREA_ICON_PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  work: "M3 7h18v13H3zM8 7V4h8v3M3 12h18",
  school: "M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z",
  health: "M9 3h6v6h6v6h-6v6H9v-6H3V9h6z",
  camera: "M3 7h4l2-3h6l2 3h4v13H3zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  film: "M3 3h18v18H3zM7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4",
  music: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  money: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  plane: "M2 16l20-7-4-3-7 3-5-2-2 1 4 4-4 2z M8 21h8",
  leaf: "M11 20A7 7 0 0 1 4 13C4 7 9 3 20 3c0 11-4 16-9 17zM4 21c4-6 8-9 12-11",
  dumbbell: "M6 5v14M18 5v14M3 9v6M21 9v6M6 12h12",
  people: ICONS.people,
  star: "M12 2l3 7 7 .6-5.3 4.7L18.4 22 12 18l-6.4 4 1.7-7.7L2 9.6 9 9z",
  paw: "M12 13c-3 0-6 3-6 5.5S8 21 12 21s6-.5 6-2.5S15 13 12 13zM5 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM9 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM15 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
};

// --- real logos (docs/ui §8) ------------------------------------------------------------

/** Which logo an extension, MCP server or provider wears, by its id or name. */
const LOGO_OF: Record<string, string> = {
  "claude-code": "claude",
  osm: "openstreetmap",
  openstreetmap: "openstreetmap",
  chatgpt: "openai",
  openai: "openai",
  "workers-ai": "cloudflare",
  cloudflare: "cloudflare",
  anthropic: "anthropic",
  claude: "claude",
  "home-assistant": "homeassistant",
  homeassistant: "homeassistant",
  google: "google",
  "google-calendar": "google",
};

/** The logo for something by its id or name, or null when Atlas has none for it. */
export function logoFor(idOrName: string | null | undefined): string | null {
  if (!idOrName) return null;
  const k = idOrName.toLowerCase().trim();
  if (LOGO_OF[k]) return LOGO_OF[k]!;
  if (LOGOS[k]) return k;
  const word = k.split(/[\s._-]+/)[0]!;
  if (LOGO_OF[word]) return LOGO_OF[word]!;
  return LOGOS[word] ? word : null;
}

/** A service's own logo, in its box; a letter when Atlas has no logo for it. */
export function Logo({ of, size = 34, img, name }: { of: string | null; size?: number; img?: number; name?: string }) {
  const key = logoFor(of);
  const l = key ? LOGOS[key] : null;
  const inner = img ?? Math.round(size * 0.58);
  return (
    <span className="logo" style={{ width: size, height: size, borderRadius: size > 40 ? 11 : 8 }}>
      {l ? (
        <img className={`lg ${l.inv ? "inv" : ""}`} src={l.uri} width={inner} height={inner} alt="" />
      ) : (
        <span className="disp" style={{ fontSize: Math.round(size * 0.42) }}>
          {(name ?? of ?? "?").slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

/** A bare logo at text size, for lists; null when there's none. */
export function LogoMark({ of, size = 15 }: { of: string | null; size?: number }) {
  const key = logoFor(of);
  const l = key ? LOGOS[key] : null;
  if (!l) return null;
  return <img className={`lg ${l.inv ? "inv" : ""}`} src={l.uri} width={size} height={size} alt="" />;
}

// --- the app's own controls (docs/ui §8) ---------------------------------------------------

/** A toggle: the app's own, never a browser checkbox. */
export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange?: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`tg ${on ? "on" : ""}`}
      disabled={disabled || !onChange}
      onClick={() => onChange?.(!on)}
    />
  );
}

/** A segmented choice: one of a few, all in view. */
export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  small,
  label,
  locked,
}: {
  value: T;
  options: Array<readonly [T, ReactNode]>;
  onChange?: (v: T) => void;
  small?: boolean;
  label?: string;
  locked?: boolean;
}) {
  return (
    <div className={`seg ${small ? "sm" : ""} ${locked ? "lock" : ""}`} role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={v === value}
          className={v === value ? "on" : ""}
          disabled={locked || !onChange}
          onClick={() => onChange?.(v)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export interface PickOption<T> {
  value: T;
  label: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  lead?: ReactNode;
}

/** A picker: the choice in a button, the options in a list that opens under it. */
export function Picker<T extends string>({
  value,
  options,
  onPick,
  label,
  head,
  foot,
  width = 260,
}: {
  value: T;
  options: PickOption<T>[];
  onPick: (v: T) => void;
  label: string;
  head?: ReactNode;
  foot?: ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const cur = options.find((o) => o.value === value);
  return (
    <span className="picker" ref={ref}>
      <button type="button" className="pick-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        {cur?.lead}
        <span className="grow">{cur?.label ?? value}</span>
        <Icon name="down" size={12} style={{ color: "var(--tx3)" }} />
      </button>
      {open && (
        <span className="pop rise" style={{ left: 0, width }} role="listbox" aria-label={label}>
          {head && <span className="head">{head}</span>}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`item ${o.value === value ? "on" : ""}`}
              onClick={() => {
                onPick(o.value);
                setOpen(false);
              }}
            >
              {o.lead}
              <span className="grow" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span>
                  {o.label}
                  {o.value === value && <Icon name="check" size={12} style={{ color: "var(--ok)", marginLeft: 6 }} />}
                </span>
                {o.sub && <span className="faint small">{o.sub}</span>}
              </span>
              {o.right}
            </button>
          ))}
          {foot && <span className="foot">{foot}</span>}
        </span>
      )}
    </span>
  );
}

/** A state dot: on, asleep, needs you, or off (the map's legend). */
export function StateDot({ state }: { state: "on" | "asleep" | "needs" | "off" }) {
  return <span className={`sdot ${state}`} aria-hidden />;
}

// --- the stage --------------------------------------------------------------------------

export interface Tab<T extends string> {
  id: T;
  label: string;
  badge?: number | string | null;
}

/** The scoped area's color, for the stage's rails (docs/ui §8: scoped, the rails take the area's color). */
export const ScopeColor = createContext<string | null>(null);

/** A page: its label, pill tabs and metadata on top, then the body; the dock (composer or console) floats over its foot. */
export function Stage<T extends string>({
  label,
  tabs,
  tab,
  onTab,
  meta,
  children,
  dock,
}: {
  label: string;
  tabs?: Tab<T>[];
  tab?: T;
  onTab?: (t: T) => void;
  meta?: ReactNode;
  /** Home's stage; kept for callers, the space under the body now follows the dock itself. */
  home?: boolean;
  children: ReactNode;
  dock?: ReactNode;
}) {
  const scope = useContext(ScopeColor);
  const section = useRef<HTMLElement>(null);
  const [room, setRoom] = useState(96);
  // The body leaves room for whatever the dock is showing now (a banner, an answer, the voice strip), so it never covers the page's foot.
  useEffect(() => {
    const sec = section.current;
    const el = sec?.querySelector<HTMLElement>(":scope > .dock");
    if (!sec || !el) return;
    const measure = () => {
      const space = Math.ceil(sec.getBoundingClientRect().bottom - el.getBoundingClientRect().top) + 20;
      setRoom((r) => (Math.abs(r - space) > 1 ? space : r));
    };
    measure();
    const o = new ResizeObserver(measure);
    o.observe(el);
    o.observe(sec);
    return () => o.disconnect();
  });
  return (
    <section
      className={`stage ${scope ? "scoped" : ""}`}
      aria-label={label}
      ref={section}
      style={scope ? ({ "--rail": scope } as React.CSSProperties) : undefined}
    >
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
                  title={t.label}
                >
                  <span className="tab-label">{t.label}</span>
                  {t.badge != null && t.badge !== 0 && <span className="mono">{t.badge}</span>}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="grow" />
        <span className="lab meta">{meta}</span>
      </div>
      <div className="stage-body" style={dock ? { paddingBottom: room } : undefined}>
        {children}
      </div>
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

/** An area's color: the owner's own, or its place in the deep palette. */
export const areaColor = (a: (Pick<AreaView, "color"> & Partial<Pick<AreaView, "custom_color">>) | undefined | null) =>
  a ? (a.custom_color ?? `var(--a${a.color % 8})`) : "var(--tx3)";

/** Closes a popover on a tap or click outside it, or on Escape; works the same by touch, mouse and keyboard. */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return ref;
}

/** Makes a row that opens on click reachable by keyboard too: focusable, and Enter or Space opens it. */
export function pressable(fn: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      fn();
    },
  } as const;
}

/**
 * An area's mark: its icon in its color (a line icon, or the logo the owner
 * uploaded), or a dot when it has none. `plain` keeps it a dot, for tight rows of dots.
 */
export function AreaDot({ area, square, plain, size = 12 }: { area?: AreaView; square?: boolean; plain?: boolean; size?: number }) {
  const icon = plain ? null : area?.icon;
  if (icon?.startsWith("file:"))
    return <img className="area-logo" src={`/api/files/${icon.slice(5)}?inline=1`} width={size} height={size} alt="" />;
  if (icon && AREA_ICON_PATHS[icon])
    return (
      <svg className="ic" width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ color: areaColor(area), flex: "none" }}>
        <path d={AREA_ICON_PATHS[icon]} />
      </svg>
    );
  return <span className={`dot ${square ? "sq" : ""}`} style={{ background: areaColor(area) }} />;
}

/** An area's name as a tinted chip in its color. */
export function AreaTag({ area }: { area?: AreaView }) {
  if (!area) return null;
  return (
    <span className="ach" style={{ "--c": areaColor(area) } as React.CSSProperties}>
      {area.icon && <AreaDot area={area} size={11} />}
      {area.name}
    </span>
  );
}

/** The area chip on anything tagged, tinted in its area's color; tapping it moves the item (§6.3). */
export function AreaChip({ ids, areas, onMove }: { ids: string[]; areas: AreaView[]; onMove?: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const shown = ids.map((id) => areas.find((a) => a.id === id)).filter((a): a is AreaView => a != null);
  if (!onMove) {
    return shown.length ? (
      <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        {shown.map((a) => (
          <AreaTag key={a.id} area={a} />
        ))}
      </span>
    ) : null;
  }
  return (
    <span style={{ position: "relative", display: "inline-flex", gap: 6 }} ref={ref}>
      <button className="chip-move" onClick={() => setOpen(!open)} title="Move to another area" aria-expanded={open}>
        {shown.length ? shown.map((a) => <AreaTag key={a.id} area={a} />) : <span className="ach none">No area</span>}
      </button>
      {open && (
        <span className="pop rise" style={{ left: 0, top: 26 }}>
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

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** A person's avatar: their photo when the address book has one, else initials in the color of the area you know them from. */
export function Avatar({ name, area, photo, size = 28 }: { name: string; area?: AreaView; photo?: string | null; size?: number }) {
  if (photo) return <img className="avatar-img" src={photo} width={size} height={size} alt="" />;
  return (
    <span
      className="avc"
      style={
        { width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.36)), "--c": areaColor(area ?? null) } as React.CSSProperties
      }
      aria-hidden
    >
      {initials(name)}
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

export type DiamondState = "idle" | "listening" | "thinking" | "speaking";

// The mark's geometry, from brand/atlas-mark.svg: top (512,176), left (318,430), right (706,430), bottom (512,848),
// and where the facets meet (512,506), as fractions of its box.
type Pt = readonly [number, number];
const D_TOP: Pt = [0.5, 0];
const D_LEFT: Pt = [0, 0.378];
const D_RIGHT: Pt = [1, 0.378];
const D_BOT: Pt = [0.5, 1];
const D_MID: Pt = [0.5, 0.491];
const D_FACETS: Array<[Pt, Pt, Pt]> = [
  [D_TOP, D_LEFT, D_MID],
  [D_TOP, D_MID, D_RIGHT],
  [D_BOT, D_LEFT, D_MID],
  [D_BOT, D_MID, D_RIGHT],
];
/** Where each facet faces, as if cut from stone: up-left, up-right, down-left, down-right. */
const D_NORMALS = [
  [-0.62, -0.52, 0.6],
  [0.62, -0.52, 0.6],
  [-0.5, 0.62, 0.6],
  [0.5, 0.62, 0.6],
] as const;
const D_RAMP = ".:-=+*#%@";
/** The mark's shading: lightest at the top left to darkest at the bottom right. */
const D_SHADE = [1, 0.8, 0.6, 0.46];
const D_ROWS = 56;
const D_COLS = 55; // a character is 0.6 as wide as it is tall, and the mark is 0.577

interface DCell {
  f: number;
  u: number;
  v: number;
  r: number;
  seed: number;
  edge?: string;
}

const side = (p: Pt, a: Pt, b: Pt) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
function inside(p: Pt, t: readonly [Pt, Pt, Pt]): boolean {
  const d1 = side(p, t[0], t[1]);
  const d2 = side(p, t[1], t[2]);
  const d3 = side(p, t[2], t[0]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

let dCells: DCell[][] | null = null;
/** The mark in characters, worked out once: each cell's facet, with hairline seams, and its outline in slanted characters. */
function diamondCells(): DCell[][] {
  if (dCells) return dCells;
  const seams: Array<[Pt, Pt]> = [
    [D_MID, D_TOP],
    [D_MID, D_LEFT],
    [D_MID, D_RIGHT],
    [D_MID, D_BOT],
  ];
  const seamDist = (px: number, py: number) => {
    let best = 9;
    for (const [a, b] of seams) {
      const ax = a[0] * D_COLS * 0.6;
      const ay = a[1] * D_ROWS;
      const dx = b[0] * D_COLS * 0.6 - ax;
      const dy = b[1] * D_ROWS - ay;
      const x = px * 0.6;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(x - (ax + t * dx), py - (ay + t * dy)));
    }
    return best;
  };
  const cells: DCell[][] = [];
  for (let y = 0; y < D_ROWS; y++) {
    const row: DCell[] = [];
    for (let x = 0; x < D_COLS; x++) {
      const p: Pt = [(x + 0.5) / D_COLS, (y + 0.5) / D_ROWS];
      let f = D_FACETS.findIndex((t) => inside(p, t));
      if (f >= 0 && seamDist(x + 0.5, y + 0.5) < 0.34) f = -1;
      row.push({ f, u: p[0], v: p[1], r: Math.hypot(p[0] - D_MID[0], (p[1] - D_MID[1]) * 1.6), seed: (x * 73856093) ^ (y * 19349663) });
    }
    cells.push(row);
  }
  const whole = (x: number, y: number) => {
    const p: Pt = [(x + 0.5) / D_COLS, (y + 0.5) / D_ROWS];
    return inside(p, [D_TOP, D_LEFT, D_BOT]) || inside(p, [D_TOP, D_RIGHT, D_BOT]);
  };
  for (let y = 0; y < D_ROWS; y++)
    for (let x = 0; x < D_COLS; x++) {
      const c = cells[y]![x]!;
      if (c.f < 0) continue;
      const leftHalf = c.u < 0.5;
      const upper = c.v < D_LEFT[1];
      if (leftHalf ? !whole(x - 1, y) : !whole(x + 1, y)) c.edge = leftHalf === upper ? "/" : "\\";
    }
  dCells = cells;
  return cells;
}

function dHash(n: number, t: number): number {
  let h = (n ^ Math.imul(t, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** One frame of the diamond at `t` seconds, as HTML: each character colored by its facet (--d1 to --d4), lit by a circling light. */
function diamondFrame(t: number, state: DiamondState, lv: number): string {
  const cells = diamondCells();
  const a = t * (state === "thinking" ? 1.1 : 0.32);
  let L = [Math.cos(a), Math.sin(a) * 0.8, 1.05];
  const ln = Math.hypot(L[0]!, L[1]!, L[2]!);
  L = L.map((x) => x / ln);
  const breathe = 0.88 + 0.12 * Math.sin(t * 1.25);
  const tick = Math.floor(t * (state === "thinking" ? 14 : 5));
  // While idle, a band of light crosses the mark every 7 seconds.
  const sweep = ((t % 7) / 1.6) * 1.8 - 0.4;
  let html = "";
  for (const row of cells) {
    for (const c of row) {
      if (c.f < 0) {
        html += " ";
        continue;
      }
      const N = D_NORMALS[c.f]!;
      let b = Math.max(0, N[0] * L[0]! + N[1] * L[1]! + N[2] * L[2]!);
      b = D_SHADE[c.f]! * (0.78 + 0.3 * b) * breathe;
      if (state === "idle" && t % 7 < 1.6) {
        const d = c.u + c.v - sweep;
        b += 0.55 * Math.exp(-(d * d) / 0.012);
      }
      if (state === "listening") b += 0.32 * lv * Math.sin(c.r * 22 - t * 7) * Math.exp(-c.r * 1.4);
      if (state === "speaking") b *= 0.62 + 0.62 * lv;
      b += (dHash(c.seed, tick) - 0.5) * (state === "thinking" ? 0.5 : 0.14);
      b = Math.min(1, Math.max(0, b));
      const ch = c.edge ?? D_RAMP[Math.min(D_RAMP.length - 1, Math.max(1, Math.round(b * (D_RAMP.length - 1))))];
      html += `<span class="d${c.f + 1}" style="opacity:${c.edge ? 1 : (0.55 + 0.45 * b).toFixed(2)}">${ch === "\\" ? "&#92;" : ch}</span>`;
    }
    html += "\n";
  }
  return html;
}

/**
 * The living diamond (§21.8, docs/ui/source/diamond.html): the real mark in
 * ember, drawn in characters, lit by a light that circles it. It sweeps now
 * and then while idle, ripples with your voice while listening, shimmers
 * while thinking and pulses with its voice while speaking. `level` (0 to 1)
 * is the audio. With reduced motion it's one still frame.
 */
export function AsciiDiamond({ height = 280, level = 0, state = "idle" }: { height?: number; level?: number; state?: DiamondState }) {
  const el = useRef<HTMLPreElement>(null);
  const lv = useRef(0);
  // The voice's level is small; this brings speech up to most of the range.
  lv.current = Math.min(1, level * 5);
  const font = useMemo(() => Math.max(1, height / D_ROWS), [height]);
  useEffect(() => {
    const pre = el.current;
    if (!pre) return;
    if (stillMotion()) {
      pre.innerHTML = diamondFrame(1.2, state, 0.5);
      return;
    }
    let raf = 0;
    let last = 0;
    const loop = (ms: number) => {
      // About 30 frames a second is plenty for characters.
      if (ms - last > 33) {
        pre.innerHTML = diamondFrame(ms / 1000, state, lv.current);
        last = ms;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state]);
  return <pre ref={el} className="ascii" aria-hidden style={{ fontSize: font, lineHeight: `${font}px`, height: font * D_ROWS }} />;
}

// --- time ---------------------------------------------------------------------------------

export const clock = (at: number | Date) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const dayName = (at: number | Date) => new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
/** A day and a time, once: "7:54 PM" today, "Yesterday, 7:54 PM", "Tue, 7:54 PM". */
export const dayTime = (at: number | Date) => {
  const day = shortDay(at);
  const time = clock(new Date(at));
  return day === time ? time : `${day}, ${time}`;
};

export const shortDay = (at: number | Date) => {
  const d = new Date(at);
  const today = new Date();
  const diff = Math.round((startOfDay(today).getTime() - startOfDay(d).getTime()) / 86_400_000);
  if (diff === 0) return clock(d);
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};
/** How long ago, in words: "just now", "4 min ago", "3 h ago", then the day. */
export const ago = (at: number, now = Date.now()) => {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 12 * 60) return `${Math.round(m / 60)} h ago`;
  return shortDay(at);
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

export type Place = "home" | "inbox" | "agenda" | "automations" | "library" | "people" | "abilities" | "history" | "settings" | "pair";
const PLACES: Place[] = ["home", "inbox", "agenda", "automations", "library", "people", "abilities", "history", "settings", "pair"];

/** The place, and an optional detail ("library/areas"), kept in the address so back and forward work. */
export function useRoute(): [Place, string, (p: Place, detail?: string) => void] {
  const read = (): [Place, string] => {
    const [p = "home", d = ""] = location.hash.replace(/^#\/?/, "").split("/");
    return [PLACES.includes(p as Place) ? (p as Place) : "home", decodeURIComponent(d)];
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

// --- QR codes ------------------------------------------------------------------------------

/** A QR code for a link, drawn in the theme's colours on a light square so any camera reads it. */
export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const [cells, setCells] = useState<boolean[][] | null>(null);
  useEffect(() => {
    let gone = false;
    void import("qrcode-generator").then(({ default: qrcode }) => {
      const qr = qrcode(0, "L");
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      if (!gone) setCells(Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c))));
    });
    return () => {
      gone = true;
    };
  }, [text]);
  if (!cells) return <div style={{ width: size, height: size }} />;
  const n = cells.length + 4;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label="QR code" style={{ borderRadius: 8 }}>
      <rect width={n} height={n} fill="#ffffff" />
      <path fill="#191817" d={cells.flatMap((row, r) => row.map((dark, c) => (dark ? `M${c + 2} ${r + 2}h1v1h-1z` : ""))).join("")} />
    </svg>
  );
}
