// A tiny, tolerant XML reader for WebDAV multistatus replies. Workers has no
// DOMParser. Namespace prefixes are dropped, so <d:href>, <D:href> and <href>
// all read as "href". Good enough for CalDAV; not a general XML parser.

export interface XmlNode {
  name: string;
  /** Attributes by local name (prefix dropped), entities decoded. */
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const localName = (qname: string) => qname.slice(qname.indexOf(":") + 1);

function parseAttrs(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!raw) return attrs;
  for (const m of raw.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[localName(m[1]!)] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

/** Parses `xml` into a tree under a synthetic "#root" node. Throws on badly broken input. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag =
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    const top = stack[stack.length - 1]!;
    top.text += decodeEntities(xml.slice(last, m.index));
    last = tag.lastIndex;
    if (m[1] !== undefined) {
      top.text += m[1];
      continue;
    }
    const qname = m[3];
    if (!qname) continue; // comment, declaration or doctype
    const name = localName(qname);
    if (m[2] === "/") {
      if (top.name !== name || stack.length === 1) throw new Error(`unexpected </${qname}>`);
      stack.pop();
      continue;
    }
    const node: XmlNode = { name, attrs: parseAttrs(m[4]), children: [], text: "" };
    top.children.push(node);
    if (m[5] !== "/") stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack[stack.length - 1]!.name}>`);
  return root;
}

/** All descendants named `name`, depth first. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function find(node: XmlNode, name: string): XmlNode | undefined {
  return findAll(node, name)[0];
}

/** The trimmed text of the first descendant named `name`, if any. */
export function textOf(node: XmlNode, name: string): string | undefined {
  const n = find(node, name);
  return n ? n.text.trim() : undefined;
}

export interface DavResponse {
  href: string;
  /** Props from propstat blocks whose status is 2xx (or that carry no status). */
  props: XmlNode;
  status?: number;
}

/** The <response> entries of a multistatus reply, with only the successful props. */
export function multistatus(xml: string): DavResponse[] {
  const root = parseXml(xml);
  if (!find(root, "multistatus")) throw new Error("not a multistatus reply");
  return findAll(root, "response").map((r) => {
    const props: XmlNode = { name: "prop", attrs: {}, children: [], text: "" };
    for (const ps of r.children.filter((c) => c.name === "propstat")) {
      const status = statusCode(textOf(ps, "status"));
      if (status !== undefined && (status < 200 || status >= 300)) continue;
      for (const p of ps.children.filter((c) => c.name === "prop")) props.children.push(...p.children);
    }
    const own = r.children.find((c) => c.name === "status");
    const href = r.children.find((c) => c.name === "href")?.text.trim() ?? "";
    return { href, props, status: statusCode(own?.text) };
  });
}

function statusCode(line: string | undefined): number | undefined {
  const m = line ? /\s(\d{3})\b/.exec(line) : null;
  return m ? Number(m[1]) : undefined;
}
