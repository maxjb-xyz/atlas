// Screenshots of each board rendered by the canvas's own runtime (support.js = dc-runtime.js).
// Usage: node shoot_real.cjs outDir [onlyName]
const { chromium } = require('playwright');
const out = process.argv[2];
const only = process.argv[3];
const BASE = 'https://atlas.local/';
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..'); // the .dc.html files, plus support.js (the canvas runtime) copied in
// name, file, steps (each: text to click, or {theme:'Light'})
const SHOTS = [
  ['01-home-week', 'StageHome.dc.html', []],
  ['02-home-now', 'StageHome.dc.html', [['role', 'tab', 'Now']]],
  ['03-home-draft', 'StageHome.dc.html', [['role', 'tab', 'Draft']]],
  ['04-home-jobs', 'StageHome.dc.html', [['role', 'tab', 'Jobs']]],
  ['05-home-jobs-code', 'StageHome.dc.html', [['text', '2 jobs running'], ['text', 'Claude Code · tests 41/58']]],
  ['06-voice', 'StageVoice.dc.html', []],
  ['07-inbox', 'Inbox.dc.html', []],
  ['08-inbox-spend', 'Inbox.dc.html', [['text', 'Book the Lensrentals FX3 kit for $302']]],
  ['09-agenda', 'Agenda.dc.html', []],
  ['10-agenda-week', 'Agenda.dc.html', [['role', 'tab', 'Week']]],
  ['11-automations', 'Automations.dc.html', []],
  ['12-automation-goodnight', 'Automations.dc.html', [['stext', 'Goodnight']]],
  ['13-library', 'Library.dc.html', []],
  ['14-library-areas', 'Library.dc.html', [['role', 'tab', 'Areas']]],
  ['15-history', 'History.dc.html', []],
  ['16-settings', 'Settings.dc.html', []],
  ['17-settings-brains', 'Settings.dc.html', [['stext', 'Brains', 1]]],
  ['18-inbox-light', 'Inbox.dc.html', [], 'Light'],
];
(async () => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({ proxy: proxy ? { server: proxy } : undefined });
  for (const [name, file, steps, theme] of SHOTS) {
    if (only && !name.includes(only)) continue;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.route('https://atlas.local/**', r => {
      const f = path.join(ROOT, new URL(r.request().url()).pathname);
      if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
      r.fulfill({ status: 200, body: fs.readFileSync(f), contentType: f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
    });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(BASE + file, { waitUntil: 'networkidle', timeout: 60000 });
    if (theme) {
      await page.evaluate(([f, t]) => window.__dcSetProps && window.__dcSetProps(window.__dcRootName(), { theme: t }), [file, theme]);
    }
    await page.waitForTimeout(1200);
    for (const s of steps) {
      if (s[0] === 'stext') await page.locator('section').getByText(s[1], { exact: true }).nth(s[2] || 0).click();
      else if (s[0] === 'role') await page.getByRole(s[1], { name: s[2] }).first().click();
      else await page.getByText(s[1], { exact: !!s[2] }).first().click();
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/${name}.png` });
    console.log(name, errs.length ? 'ERR ' + errs.slice(0, 3).join(' | ') : 'ok');
    await page.close();
  }
  await browser.close();
})();
