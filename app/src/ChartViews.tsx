// M3's composed views (§21.6): chart, compare, the custom kit, and small
// apps. Each draws from the contract the agent checked (core/src/stage.ts),
// in the current theme. Charts follow the dataviz method: one axis, series
// colors in fixed order (--s1…--s8, validated for both themes), a legend for
// two or more series, direct labels on up to four lines, a hover tooltip,
// and a table view.

import { useEffect, useMemo, useRef, useState } from "react";
import type { StageView } from "../../core/src/stage";
import { Markdown } from "./Markdown";

type Chart = Pick<Extract<StageView, { kind: "chart" }>, "style" | "x" | "series" | "unit">;
type Compare = Pick<Extract<StageView, { kind: "compare" }>, "options" | "rows" | "pick" | "why">;
type Kit = Extract<StageView, { kind: "kit" }>;

const color = (i: number) => `var(--s${(i % 8) + 1})`;

/** Units short enough to sit on every tick: currency before the number, percent after. */
const tight = (unit?: string) => unit === "$" || unit === "€" || unit === "£" || unit === "%";

/** A number as people read it, with its unit (or without, on an axis whose unit is said once). */
function fmt(v: number | null | undefined, unit?: string, bare = false): string {
  if (v == null) return "–";
  const n = Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100);
  if (!unit || (bare && !tight(unit))) return n;
  return unit === "%" ? `${n}%` : tight(unit) ? `${unit}${n}` : `${n} ${unit}`;
}

/** Text width in px, near enough for 11px type, to size margins. */
const textWidth = (s: string) => s.length * 6.8;

/** Direct labels at the ends of lines, pushed apart so none overlap. */
function spread(ys: number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const [y, i] of order) {
    prev = Math.max(y, prev + gap);
    out[i] = prev;
  }
  // If the stack ran off the bottom, slide it back up.
  const over = Math.max(...out) - hi;
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] = Math.max(lo, out[i]! - over);
  return out;
}

/** Round tick steps (1, 2, 2.5, 5 × 10ⁿ) covering [lo, hi] in about four steps. */
function ticks(lo: number, hi: number): number[] {
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 0.001; t += step) out.push(Math.round(t * 1e6) / 1e6);
  if (out[out.length - 1]! < hi) out.push(out[out.length - 1]! + step);
  return out;
}

/** Bars or lines with one axis, a legend, hover, and a table view. */
export function ChartBody({ chart }: { chart: Chart }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  // Drawn at the size it's shown, so type stays 11px on a phone and on a wide screen.
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const o = new ResizeObserver(() => setW(Math.max(260, Math.round(el.clientWidth))));
    o.observe(el);
    return () => o.disconnect();
  }, [table]);
  const { style, x, series, unit } = chart;
  const values = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  // Bars measure from zero; lines show change, so they fit the data.
  const lo = values.length ? (style === "bar" ? Math.min(0, ...values) : Math.min(...values)) : 0;
  const hi = values.length ? (style === "bar" ? Math.max(0, ...values) : Math.max(...values)) : 1;
  const ys = useMemo(() => ticks(lo, hi), [lo, hi]);
  const labelled = style === "line" && series.length <= 4;
  const H = W < 480 ? 220 : 260;
  const caption = unit && !tight(unit) ? unit : "";
  const name = (s: string) => (s.length > 14 ? `${s.slice(0, 13)}…` : s);
  const m = {
    l: Math.ceil(Math.max(...ys.map((t) => textWidth(fmt(t, unit, true))))) + 12,
    r: labelled ? Math.min(110, Math.ceil(Math.max(...series.map((s) => textWidth(name(s.name))))) + 14) : 8,
    t: caption ? 22 : 10,
    b: 28,
  };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const y0 = ys[0]!;
  const y1 = ys[ys.length - 1]!;
  const Y = (v: number) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;
  const band = pw / x.length;
  const X = (i: number) => m.l + band * i + band / 2;
  const everyNth = Math.ceil(x.length / Math.max(2, Math.floor(pw / Math.max(48, ...x.map((l) => textWidth(l.slice(0, 12)) + 12)))));
  const ends = series.map((s) => {
    const i = s.values.findLastIndex((v) => v != null);
    return i < 0 ? null : { i, y: Y(s.values[i]!) };
  });
  const placed = labelled
    ? spread(
        ends.map((e) => e?.y ?? 0),
        14,
        m.t,
        m.t + ph,
      )
    : [];

  if (table)
    return (
      <>
        <div className="row" style={{ justifyContent: "flex-end", marginBottom: 6 }}>
          <button className="link small" onClick={() => setTable(false)}>
            Chart
          </button>
        </div>
        <div className="scroll-x">
          <table className="grid stage-table">
            <thead>
              <tr>
                <th className="lab" />
                {series.map((s) => (
                  <th key={s.name} className="lab" style={{ textAlign: "right" }}>
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {x.map((label, i) => (
                <tr key={i}>
                  <td>{label}</td>
                  {series.map((s) => (
                    <td key={s.name} className="mono" style={{ textAlign: "right" }}>
                      {fmt(s.values[i], unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.floor((px - m.l) / band);
    setHover(i >= 0 && i < x.length ? i : null);
  };
  const tipLeft = hover == null ? 0 : (X(hover) / W) * (box.current?.clientWidth ?? W);

  return (
    <div className="chart" ref={box}>
      <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
        {series.length >= 2 ? (
          <div className="chart-legend grow">
            {series.map((s, i) => (
              <span key={s.name}>
                <span className="sw" style={{ background: color(i) }} />
                {s.name}
              </span>
            ))}
          </div>
        ) : (
          <span className="grow" />
        )}
        <button className="link small" style={{ flex: "none" }} onClick={() => setTable(true)}>
          Table
        </button>
      </div>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${style === "bar" ? "Bar" : "Line"} chart of ${series.map((s) => s.name).join(", ")}`}
      >
        {caption && (
          <text className="axis" x={m.l - 8} y={10} textAnchor="end">
            {caption}
          </text>
        )}
        {ys.map((t) => (
          <g key={t}>
            <line className={t === 0 || t === y0 ? "baseline" : "grid-line"} x1={m.l} x2={W - m.r} y1={Y(t)} y2={Y(t)} />
            <text className="axis" x={m.l - 8} y={Y(t) + 4} textAnchor="end">
              {fmt(t, unit, true)}
            </text>
          </g>
        ))}
        {x.map((label, i) =>
          i % everyNth === 0 ? (
            <text key={i} className="axis" x={X(i)} y={H - 10} textAnchor="middle">
              {label.length > 12 ? `${label.slice(0, 11)}…` : label}
            </text>
          ) : null,
        )}
        {hover != null && style === "line" && <line className="crosshair" x1={X(hover)} x2={X(hover)} y1={m.t} y2={m.t + ph} />}
        {style === "bar"
          ? x.map((_, i) => {
              const group = band * 0.72;
              const w = Math.max(2, group / series.length - 2);
              return series.map((s, k) => {
                const v = s.values[i];
                if (v == null) return null;
                const bx = X(i) - group / 2 + k * (w + 2);
                const top = Y(Math.max(v, 0));
                const bottom = Y(Math.min(v, 0));
                const h = Math.max(1, bottom - top);
                const r = Math.min(4, w / 2, h);
                // Rounded at the data end only: the end away from the baseline.
                const d =
                  v >= 0
                    ? `M${bx},${bottom}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + w - r}Q${bx + w},${top} ${bx + w},${top + r}V${bottom}Z`
                    : `M${bx},${top}V${bottom - r}Q${bx},${bottom} ${bx + r},${bottom}H${bx + w - r}Q${bx + w},${bottom} ${bx + w},${bottom - r}V${top}Z`;
                return <path key={`${i}-${k}`} d={d} fill={color(k)} opacity={hover == null || hover === i ? 1 : 0.45} />;
              });
            })
          : series.map((s, k) => {
              const pts = s.values.map((v, i) => (v == null ? null : ([X(i), Y(v)] as const)));
              let d = "";
              let pen = false;
              for (const p of pts) {
                if (!p) {
                  pen = false;
                  continue;
                }
                d += `${pen ? "L" : "M"}${p[0]},${p[1]}`;
                pen = true;
              }
              const end = ends[k];
              return (
                <g key={s.name}>
                  <path d={d} fill="none" stroke={color(k)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {x.length <= 24 &&
                    pts.map((p, i) =>
                      p ? (
                        <circle key={i} cx={p[0]} cy={p[1]} r={hover === i ? 5 : 4} fill={color(k)} stroke="var(--win)" strokeWidth={2} />
                      ) : null,
                    )}
                  {labelled && end && (
                    <text className="direct-label" x={X(end.i) + 10} y={placed[k]! + 4}>
                      {name(s.name)}
                    </text>
                  )}
                </g>
              );
            })}
        <rect x={m.l} y={m.t} width={pw} height={ph} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: Math.min(tipLeft + 12, (box.current?.clientWidth ?? W) - 160), top: 28 }}>
          <div className="lab">{x[hover]}</div>
          {series.map((s, k) => (
            <div className="row" key={s.name}>
              <span className="sw" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: color(k) }} />
              <span className="grow">{s.name}</span>
              <span className="mono">{fmt(s.values[hover], unit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Options side by side on what matters, with the pick marked and why. */
export function CompareBody({ compare }: { compare: Compare }) {
  const { options, rows, pick, why } = compare;
  const picked = options.findIndex((o) => o.name === pick);
  return (
    <>
      <div className="scroll-x">
        <table className="grid stage-table">
          <thead>
            <tr>
              <th className="lab" />
              {options.map((o, i) => (
                <th key={o.name} className={i === picked ? "compare-pick" : ""} style={{ textAlign: "left", verticalAlign: "bottom" }}>
                  {i === picked && <span className="tag ac">Pick</span>}
                  <div style={{ fontWeight: 600, marginTop: 4 }}>
                    {o.url ? (
                      <a className="link" href={o.url} target="_blank" rel="noopener noreferrer">
                        {o.name}
                      </a>
                    ) : (
                      o.name
                    )}
                  </div>
                  {o.note && <div className="muted small">{o.note}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="lab">{r.label}</td>
                {options.map((o, i) => (
                  <td key={o.name} className={i === picked ? "compare-pick" : ""}>
                    {r.values[i] == null ? <span className="faint">·</span> : <span className="cell-text">{String(r.values[i])}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {why && (
        <p style={{ marginTop: 12 }}>
          {pick && <strong>{pick}: </strong>}
          {why}
        </p>
      )}
    </>
  );
}

/** A layout Atlas composed from parts, top to bottom. */
export function KitBody({ kit }: { kit: Kit }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {kit.blocks.map((b, i) => (
        <section key={i}>
          {"title" in b && b.title && (
            <p className="lab" style={{ marginBottom: 8 }}>
              {b.title}
            </p>
          )}
          {b.type === "text" && <Markdown text={b.text} />}
          {b.type === "stats" && (
            <div className="stat-tiles">
              {b.items.map((s, k) => (
                <div className="stat-tile" key={k}>
                  <div className="lab">{s.label}</div>
                  <div className="value">{s.value}</div>
                  {s.note && <div className="muted small">{s.note}</div>}
                </div>
              ))}
            </div>
          )}
          {b.type === "list" && (
            <div className="rows">
              {b.items.map((it, k) => (
                <div className="r" key={k} style={{ alignItems: "flex-start" }}>
                  <span className="mono faint small" style={{ flex: "none", width: 22 }}>
                    {b.numbered ? k + 1 : it.done ? "✓" : "·"}
                  </span>
                  <span className="grow">
                    <span className={it.done ? "faint" : ""}>{it.text}</span>
                    {it.note && (
                      <span className="muted small" style={{ display: "block" }}>
                        {it.note}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {b.type === "table" && (
            <div className="scroll-x">
              <table className="grid stage-table">
                <thead>
                  <tr>
                    {b.columns.map((c, k) => (
                      <th key={k} className="lab">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, k) => (
                    <tr key={k}>
                      {b.columns.map((_, j) => (
                        <td key={j}>
                          {r[j] == null ? <span className="faint">·</span> : <span className="cell-text">{String(r[j])}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {b.type === "chart" && <ChartBody chart={b} />}
          {b.type === "compare" && <CompareBody compare={b} />}
        </section>
      ))}
    </div>
  );
}

/**
 * A small app (§21.6): its HTML in a sandboxed frame with no network (a
 * Content-Security-Policy that allows nothing outside the page) and no
 * access to Atlas (no same-origin). Its data is window.ATLAS_DATA; the
 * theme's colors are CSS variables (--bg, --text, --muted, --line,
 * --accent); the frame follows its body's height.
 */
export function AppFrame({ app }: { app: Pick<Extract<StageView, { kind: "app" }>, "html" | "data" | "title"> }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(240);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const m = e.data as { atlas?: string; height?: number };
      if (m?.atlas === "height" && typeof m.height === "number") setHeight(Math.max(120, Math.min(2_000, Math.round(m.height))));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  const doc = useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const head = [
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`,
      `<style>:root{--bg:${v("--win")};--text:${v("--tx")};--muted:${v("--tx2")};--line:${v("--sep")};--accent:${v("--ac")};color-scheme:${v("color-scheme") || "dark"}}body{margin:0;padding:12px;background:var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,sans-serif}</style>`,
      `<script>window.ATLAS_DATA=${JSON.stringify(app.data ?? null).replace(/</g, "\\u003c")};`,
      // The frame grows and shrinks with the app, so apps needn't ask.
      `addEventListener("DOMContentLoaded",function(){var b=document.body,s=function(){parent.postMessage({atlas:"height",height:Math.ceil(b.getBoundingClientRect().height)},"*")};s();new ResizeObserver(s).observe(b)});</script>`,
    ].join("");
    return /<head[^>]*>/i.test(app.html)
      ? app.html.replace(/<head[^>]*>/i, (h) => h + head)
      : `<!doctype html><html><head>${head}</head><body>${app.html}</body></html>`;
  }, [app.html, app.data]);
  return (
    <iframe
      ref={frame}
      className="app-frame"
      title={app.title}
      sandbox="allow-scripts allow-forms allow-modals"
      srcDoc={doc}
      style={{ height }}
    />
  );
}
