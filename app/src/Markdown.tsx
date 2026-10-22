// Atlas's words, as the model wrote them, shown with their markdown:
// paragraphs, headings, lists, quotes, code, tables, bold, italic, links.
// Nothing is changed (VISION rule 1), only displayed. It builds React
// elements, never HTML, so text from the model or an invite can't inject
// anything, and links open only http and https addresses.

import type { ReactNode } from "react";

const INLINE = new RegExp(
  [
    "(`[^`\\n]+`)", // 1 code
    "(\\*\\*[^*\\n]+?\\*\\*|__[^_\\n]+?__)", // 2 bold
    "(~~[^~\\n]+?~~)", // 3 strikethrough
    "\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)", // 4, 5 link
    "(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?'\"])", // 6 bare address
    "((?<![\\w*])\\*(?![\\s*])[^*\\n]+?(?<!\\s)\\*(?![\\w*]))", // 7 italic with stars
    "((?<!\\w)_(?![\\s_])[^_\\n]+?(?<!\\s)_(?!\\w))", // 8 italic with underscores
  ].join("|"),
  "g",
);

function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}.${n++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<s key={k}>{inline(m[3].slice(2, -2), k)}</s>);
    else if (m[4] && m[5]) out.push(link(m[5], inline(m[4], k), k));
    else if (m[6]) out.push(link(m[6], shortAddress(m[6]), k));
    else if (m[7]) out.push(<em key={k}>{inline(m[7].slice(1, -1), k)}</em>);
    else if (m[8]) out.push(<em key={k}>{inline(m[8].slice(1, -1), k)}</em>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * A long bare address (a sign-in link with its query) is shown by its host
 * and the start of its path; the link itself is the whole address.
 */
function shortAddress(href: string): string {
  if (href.length <= 60) return href;
  try {
    const u = new URL(href);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path.length > 30 ? `${path.slice(0, 29)}…` : path}${u.search || u.hash ? "…" : ""}`;
  } catch {
    return `${href.slice(0, 57)}…`;
  }
}

/** One line of text with its links and emphasis, for notes and results outside a message. */
export function InlineText({ text }: { text: string }) {
  return <>{inline(text)}</>;
}

function link(href: string, children: ReactNode, key: string): ReactNode {
  return (
    <a key={key} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** Lines joined inside one paragraph keep their breaks. */
function lines(ls: string[], key: string): ReactNode[] {
  return ls.flatMap((l, i) => (i ? [<br key={`${key}.br${i}`} />, ...inline(l, `${key}.${i}`)] : inline(l, `${key}.${i}`)));
}

const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function blocks(text: string): ReactNode[] {
  const src = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < src.length) {
    const line = src[i]!;
    const key = `b${b++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code: everything up to the closing fence (or the end, while it's still streaming).
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < src.length && !/^\s*```/.test(src[i]!)) body.push(src[i++]!);
      i++;
      out.push(
        <pre key={key}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6);
      const H = `h${level}` as "h3" | "h4" | "h5" | "h6";
      out.push(<H key={key}>{inline(heading[2]!, key)}</H>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < src.length && /^\s*>/.test(src[i]!)) body.push(src[i++]!.replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key}>{blocks(body.join("\n"))}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < src.length && TABLE_RULE.test(src[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < src.length && src[i]!.includes("|") && src[i]!.trim()) rows.push(cells(src[i++]!));
      out.push(
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${key}.h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j}>{inline(r[j] ?? "", `${key}.${ri}.${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = NUMBER.test(line);
      const start = ordered ? Number(NUMBER.exec(line)![2]) : 1;
      const items: Array<{ depth: number; text: string[] }> = [];
      while (i < src.length) {
        const l = src[i]!;
        const m = ordered ? NUMBER.exec(l) : BULLET.exec(l);
        const other = ordered ? BULLET.exec(l) : NUMBER.exec(l);
        if (m) {
          items.push({ depth: m[1]!.length >= 2 ? 1 : 0, text: [ordered ? m[3]! : m[2]!] });
        } else if (other && other[1]!.length >= 2 && items.length) {
          // A nested list of the other kind reads as an indented item.
          items.push({ depth: 1, text: [ordered ? other[2]! : other[3]!] });
        } else if (l.trim() && /^\s+/.test(l) && items.length) {
          items.at(-1)!.text.push(l.trim());
        } else break;
        i++;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key} {...(ordered && start !== 1 ? { start } : {})}>
          {items.map((it, j) => (
            <li key={j} className={it.depth ? "sub" : undefined}>
              {lines(it.text, `${key}.${j}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    // A paragraph: lines up to a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < src.length &&
      src[i]!.trim() &&
      !/^\s*```/.test(src[i]!) &&
      !/^#{1,6}\s/.test(src[i]!) &&
      !/^\s*>/.test(src[i]!) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(src[i]!) &&
      !(para.length && (BULLET.test(src[i]!) || NUMBER.test(src[i]!)))
    ) {
      para.push(src[i++]!);
    }
    if (!para.length) para.push(src[i++]!); // never stall on a line no rule took
    out.push(<p key={key}>{lines(para, key)}</p>);
  }
  return out;
}

/** Atlas's text, rendered from its markdown. */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`md ${className}`}>{blocks(text)}</div>;
}
