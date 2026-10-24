// Minimal local renderer for .dc.html files, for screenshots only.
// Usage: node preview.cjs out.png file.dc.html [stateJSON] [propsJSON]
const fs = require('fs');
const { chromium } = require('playwright');
const [out, file, stateArg, propsArg] = process.argv.slice(2);
const src = fs.readFileSync(file, 'utf8');
const helmet = (src.match(/<helmet>([\s\S]*?)<\/helmet>/) || [, ''])[1];
const tpl = src.match(/<\/helmet>([\s\S]*?)<\/x-dc>/)[1];
const m0 = src.match(/<script type="text\/x-dc"[^>]*data-props=(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/script>/);
const scriptTag = [m0[0], m0[2], m0[3]];
const decode = s => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const propsDef = JSON.parse(decode(scriptTag[1]));
const props = {};
for (const k of Object.keys(propsDef)) if (k[0] !== '$') props[k] = propsDef[k].default;
Object.assign(props, propsArg ? JSON.parse(propsArg) : {});
const code = scriptTag[2];
const preview = propsDef.$preview || { width: 1440, height: 900 };

const runtime = `
class DCLogic { constructor(p){ this.props = p; this.state = {}; } setState(s){ Object.assign(this.state, s); window.__render(); } }
${code}
const comp = new Component(${JSON.stringify(props)});
Object.assign(comp.state, ${stateArg || '{}'});
function look(scope, expr){
  expr = expr.trim();
  if (expr === 'true') return true; if (expr === 'false') return false;
  if (/^-?\\d+(\\.\\d+)?$/.test(expr)) return Number(expr);
  return expr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
}
function interp(str, scope){
  const m = str.match(/^\\s*\\{\\{([^}]+)\\}\\}\\s*$/);
  if (m) { const v = look(scope, m[1]); return v; }
  return str.replace(/\\{\\{([^}]+)\\}\\}/g, (_, e) => { const v = look(scope, e); return v == null ? '' : v; });
}
function proc(node, scope, parent){
  if (node.nodeType === 3) { parent.appendChild(document.createTextNode(String(node.nodeValue.replace(/\{\{([^}]+)\}\}/g, (_, e) => { const v = look(scope, e); return v == null ? '' : v; })))); return; }
  if (node.nodeType !== 1) return;
  const tag = node.localName;
  if (tag === 'sc-for') {
    const list = interp(node.getAttribute('list'), scope) || [];
    const as = node.getAttribute('as');
    list.forEach((it, i) => { const s = Object.assign(Object.create(scope), { [as]: it, $index: i }); node.childNodes.forEach(c => proc(c, s, parent)); });
    return;
  }
  if (tag === 'sc-if') {
    const v = interp(node.getAttribute('value'), scope);
    if (v && v !== 'false') node.childNodes.forEach(c => proc(c, scope, parent));
    return;
  }
  const el = node.namespaceURI === 'http://www.w3.org/2000/svg' ? document.createElementNS(node.namespaceURI, node.localName) : document.createElement(node.localName);
  for (const a of node.attributes) {
    if (/^on[A-Z]/.test(a.name) || /^on[a-z]/.test(a.name)) { const fn = interp(a.value, scope); if (typeof fn === 'function') el.addEventListener(a.name.slice(2).toLowerCase(), fn); continue; }
    if (a.name.startsWith('hint-')) continue;
    const v = interp(a.value, scope);
    el.setAttribute(a.name, v == null ? '' : v);
  }
  const kids = node.localName === 'template' ? node.content.childNodes : node.childNodes;
  kids.forEach(c => proc(c, scope, el));
  parent.appendChild(el);
}
window.__render = function(){
  const vals = comp.renderVals();
  const root = document.getElementById('root'); root.innerHTML = '';
  const t = document.getElementById('tpl');
  t.content.childNodes.forEach(c => proc(c, vals, root));
};
window.__render();
`;
const html = `<!doctype html><html><head><meta charset="utf-8">${helmet}</head><body><div id="root"></div><template id="tpl">${tpl}</template><script>${runtime}<\/script></body></html>`;
(async () => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({ proxy: proxy ? { server: proxy } : undefined });
  const page = await browser.newPage({ viewport: { width: preview.width, height: preview.height }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.setContent(html, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('load', e.message));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log('ok', out);
})();
