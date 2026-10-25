// The contrast check (VISION §21.9, M7 smoke step 37): every built-in theme's
// text reads against every surface it sits on. Text needs 4.5:1 (WCAG AA for
// body text), and High contrast 7:1 (AAA); the accent and the OK color, which
// mark controls and states, need 3:1. Runs in `npm run check`.

import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/src/styles.css", import.meta.url), "utf8");

/** Each theme's first block of tokens: the one that sets --bg. */
const themes = {};
for (const m of css.matchAll(/((?:[:\w]+,\s*)?\[data-theme="([\w-]+)"\])\s*\{([^}]*)\}/g)) {
  const [, , name, body] = m;
  if (themes[name] || !/--bg:/.test(body)) continue;
  themes[name] = Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,8})\b/gi)].map((t) => [t[1], t[2].toLowerCase()]));
}

const rgb = (hex) => {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
};
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const TEXT = ["tx", "tx2", "tx3"];
const SURFACES = ["bg", "win", "side", "hover", "sel"];
const failures = [];
const names = Object.keys(themes);
for (const name of names) {
  const t = themes[name];
  const text = name === "high-contrast" ? 7 : 4.5;
  const pairs = [
    ...TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg, text])),
    ["btntx", "btn", text],
    // Atlas's selection tag: mono text on ember.
    ["actx", "ac", 4.5],
    ["ac", "win", 3],
    ["ac", "bg", 3],
    ["ok", "win", 3],
  ];
  for (const [fg, bg, need] of pairs) {
    if (!t[fg] || !t[bg]) {
      failures.push(`${name}: --${fg} or --${bg} isn't a plain hex color`);
      continue;
    }
    const r = ratio(t[fg], t[bg]);
    if (r < need) failures.push(`${name}: --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1, needs ${need}:1`);
  }
}
const want = ["graphite", "daylight", "terminal", "midnight", "high-contrast"];
for (const w of want) if (!themes[w]) failures.push(`${w}: no theme block in app/src/styles.css`);

if (failures.length) {
  console.error(`The contrast check failed:\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`Contrast: ${names.length} themes pass (${names.join(", ")}).`);
