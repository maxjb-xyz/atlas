// Sending what a reader takes from what the owner picked (§23.3): its files
// in parts, the skill folders as they are, then asking Atlas to read it all.

import type { MoveInView } from "../../../core/src/protocol";
import { cleanPath, fit, readerTakes, skillFolders } from "../../../core/src/readers";
import { base64Of, open, type Picked, parts, textOf } from "./open";

type Reader = MoveInView["readers"][number];

export interface Sending {
  reader: Reader;
  /** What was picked, by name. */
  name: string;
  /** Bytes of the reader's files read so far, of all of them. */
  done: number;
  of: number;
  /** What Atlas found in it so far. */
  seen: number;
  notes: number;
  skills: number;
  /** The file being read now. */
  file: string | null;
}

/** Every path any reader might want, so a tar keeps those bytes on its one pass. */
export function anyWanted(readers: Reader[]) {
  return (path: string) =>
    readers.some((r) => readerTakes(r.reads, path) || (r.reads.skills ?? []).some((s) => cleanPath(path).split("/").includes(s)));
}

/** The reader that fits what was picked best, or null when none does. */
export function guess(readers: Reader[], paths: string[]): Reader | null {
  let best: Reader | null = null;
  let score = 0;
  for (const r of readers) {
    const n = fit(r.reads, paths);
    if (n > score) ((best = r), (score = n));
  }
  return best;
}

async function post(path: string, q: Record<string, string>, body: string, type: string) {
  const res = await fetch(`${path}?${new URLSearchParams(q)}`, { method: "POST", headers: { "content-type": type }, body });
  const out = (await res.json().catch(() => null)) as {
    ok?: boolean;
    text?: string;
    builtin_skills?: string[];
    seen?: number;
    notes?: number;
  } | null;
  if (!res.ok || !out?.ok) throw new Error(out?.text ?? `Atlas answered ${res.status} for ${path}.`);
  return out;
}

/**
 * Opens what was picked and sends the reader's part of it. Says how it's
 * going through `progress`; throws in words the owner can act on.
 */
export async function send(
  items: Parameters<typeof open>[0],
  readers: Reader[],
  chosen: Reader | null,
  progress: (s: Sending) => void,
): Promise<Sending> {
  const picked: Picked = await open(items, anyWanted(readers));
  // The one they picked, unless what they dropped is plainly another's (a Claude export dropped on ChatGPT).
  const best = guess(readers, picked.paths);
  const reader =
    chosen && fit(chosen.reads, picked.paths) > 0 && fit(chosen.reads, picked.paths) >= (best ? fit(best.reads, picked.paths) : 0)
      ? chosen
      : best;
  if (!reader)
    throw new Error(
      chosen
        ? `There's nothing in ${picked.name} that ${chosen.name} reads. ${chosen.reads.how}`
        : `Atlas can't tell what ${picked.name} is from. Pick where it's from above, then drop it again.`,
    );
  const spec = reader.reads;
  const folders = skillFolders(spec, picked.paths);
  // Another assistant's list of its own skills goes first, so they aren't sent as the owner's.
  const files = picked.paths
    .filter((p) => readerTakes(spec, p, folders))
    .sort((a, b) => Number(!a.includes(".bundled_manifest")) - Number(!b.includes(".bundled_manifest")) || picked.size(a) - picked.size(b));
  if (!files.length && !folders.length) throw new Error(`There's nothing in ${picked.name} that ${reader.name} reads. ${spec.how}`);
  const s: Sending = {
    reader,
    name: picked.name,
    done: 0,
    of: files.reduce((n, p) => n + picked.size(p), 0),
    seen: 0,
    notes: 0,
    skills: 0,
    file: null,
  };
  progress({ ...s });
  const builtin = new Set<string>();
  for (const path of files) {
    s.file = path;
    progress({ ...s });
    let part = 0;
    for await (const text of parts(await picked.open(path), /\.json$/i.test(path), undefined, (n) => {
      s.done += n;
      progress({ ...s });
    })) {
      part += 1;
      const out = await post("/api/movein/read", { reader: reader.id, path, part: String(part) }, text, "text/plain; charset=utf-8");
      s.seen += out.seen ?? 0;
      s.notes += out.notes ?? 0;
      for (const b of out.builtin_skills ?? []) builtin.add(b);
      progress({ ...s });
    }
  }
  for (const folder of folders) {
    const base = folder.split("/").pop() ?? folder;
    const mdPath = `${folder}/SKILL.md`;
    const md = await textOf(await picked.open(mdPath));
    const name = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(md)?.[1]?.trim();
    // A skill that came with the other assistant stays there.
    if (builtin.has(base) || (name && builtin.has(name))) continue;
    s.file = folder;
    progress({ ...s });
    const inside = picked.paths.filter(
      (p) =>
        p.startsWith(`${folder}/`) &&
        !p
          .slice(folder.length + 1)
          .split("/")
          .some((x) => x.startsWith(".")),
    );
    const out: Array<{ path: string; base64: string }> = [];
    let bytes = 0;
    for (const p of inside.slice(0, 80)) {
      if (picked.size(p) > 1_000_000 || bytes > 8_000_000) continue;
      const { b64, size } = await base64Of(await picked.open(p));
      bytes += size;
      out.push({ path: p.slice(folder.length + 1), base64: b64 });
    }
    await post(
      "/api/movein/skill",
      { reader: reader.id },
      JSON.stringify({ folder: folder.replace(/^[^/]*?\/(?=skills\/)/, ""), files: out }),
      "application/json",
    );
    s.skills += 1;
    progress({ ...s });
  }
  s.file = null;
  progress({ ...s });
  return s;
}
