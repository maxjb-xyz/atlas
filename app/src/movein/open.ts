// Opening what the owner picks for moving in (§23.3), on their own device:
// a zip (ChatGPT's and Claude's exports, a `hermes backup`), a tar.gz (an
// `openclaw backup`), a folder, or loose files. Only the files a reader
// names are ever read out of it and sent to Atlas; the rest (another
// assistant's keys and sign-ins, images, chat.html) never leaves the device.
// Nothing here knows any one format: the readers' manifests say what to take.

/** What was picked, as paths, each opened only when it's needed. */
export interface Picked {
  /** What it was, for the page: "OpenAI-export.zip", "hermes". */
  name: string;
  paths: string[];
  size(path: string): number;
  open(path: string): Promise<ReadableStream<Uint8Array>>;
}

const enc = new TextDecoder();

/** Where an archive came from: the picked file, or a folder's files by their paths. */
type Item = { file: File; path: string };

/** Folders nobody's memory is in, left out while walking a picked folder so a big one stays quick. */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "site-packages",
  ".cache",
  "browser_profiles",
  "hermes-agent",
]);
/** The most files a picked folder is walked for. */
const MAX_FILES = 40_000;

/** Files dropped on the page: folders walked (skipping the heavy ones), archives and loose files as they are. */
export async function fromDrop(dt: DataTransfer): Promise<Item[]> {
  const out: Item[] = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => Boolean(e));
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  const walk = async (e: FileSystemEntry, at: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: at ? `${at}/${e.name}` : e.name });
      return;
    }
    if (SKIP.has(e.name)) return;
    const reader = (e as FileSystemDirectoryEntry).createReader();
    const here = at ? `${at}/${e.name}` : e.name;
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const c of batch) await walk(c, here);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

/** Files from a picker: a folder's with their paths inside it, or loose ones. */
export function fromInput(files: FileList | File[]): Item[] {
  return [...files]
    .map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
    .filter((i) => !i.path.split("/").some((p) => SKIP.has(p)));
}

/** A folder chosen with the browser's folder picker where it has one (no "upload every file" warning), walked here. */
export async function fromDirectoryPicker(): Promise<Item[] | null> {
  const pick = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!pick) return null;
  const root = await pick({ mode: "read" });
  const out: Item[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, at: string): Promise<void> => {
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (out.length >= MAX_FILES) return;
      if (h.kind === "file") out.push({ file: await (h as FileSystemFileHandle).getFile(), path: `${at}/${name}` });
      else if (!SKIP.has(name)) await walk(h as FileSystemDirectoryHandle, `${at}/${name}`);
    }
  };
  await walk(root, root.name);
  return out;
}

/** What a file is, by its first bytes: names lie (Claude's export can come without ".zip"). */
async function kindOf(file: File): Promise<"zip" | "gzip" | "tar" | "plain"> {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) return "zip";
  if (head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  if (head.length >= 262 && enc.decode(head.slice(257, 262)) === "ustar") return "tar";
  return "plain";
}

/** Everything picked, as one set of paths: an archive's own paths under its name, a folder's files under theirs. */
export async function open(items: Item[], wanted: (path: string) => boolean): Promise<Picked> {
  const parts: Picked[] = [];
  const loose: Item[] = [];
  for (const it of items) {
    const kind = it.file.size > 0 ? await kindOf(it.file) : "plain";
    if (kind === "zip") parts.push(await zip(it.file, items.length > 1 ? it.path : ""));
    else if (kind === "gzip" || kind === "tar") parts.push(await tar(it.file, kind === "gzip", wanted, items.length > 1 ? it.path : ""));
    else loose.push(it);
  }
  if (loose.length) {
    const byPath = new Map(loose.map((i) => [i.path, i.file]));
    parts.push({
      name: loose.length === 1 ? loose[0]!.file.name : (loose[0]!.path.split("/")[0] ?? "files"),
      paths: [...byPath.keys()],
      size: (p) => byPath.get(p)?.size ?? 0,
      open: async (p) => byPath.get(p)!.stream(),
    });
  }
  if (parts.length === 1) return parts[0]!;
  const owner = new Map<string, Picked>();
  for (const p of parts) for (const path of p.paths) owner.set(path, p);
  return {
    name: items.map((i) => i.file.name).join(", "),
    paths: [...owner.keys()],
    size: (p) => owner.get(p)?.size(p) ?? 0,
    open: (p) => owner.get(p)!.open(p),
  };
}

// --- zip ------------------------------------------------------------------------------------------------

const u16 = (b: DataView, o: number) => b.getUint16(o, true);
const u32 = (b: DataView, o: number) => b.getUint32(o, true);
const u64 = (b: DataView, o: number) => Number(b.getBigUint64(o, true));

/**
 * A zip's table of contents, from its end: each entry's name, sizes and where
 * its data starts. Zip64 (an export over 4 GB, or with over 65,535 files) too.
 */
async function zip(file: File, prefix: string): Promise<Picked> {
  const tailLen = Math.min(file.size, 65_557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--)
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error(`${file.name} isn't a whole zip: its end is missing. Download it again and drop the new one.`);
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error(`${file.name} is a zip64 file Atlas can't read the end of.`);
    const at = u64(tail, loc + 8);
    const z = new DataView(await file.slice(at, at + 56).arrayBuffer());
    if (u32(z, 0) !== 0x06064b50) throw new Error(`${file.name} is a zip64 file whose table of contents isn't where it says.`);
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = new Map<string, { method: number; csize: number; size: number; offset: number; flags: number }>();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    const name = (flags & 0x800 ? enc : new TextDecoder("latin1")).decode(nameBytes);
    // Zip64's extra field holds the sizes and offset that didn't fit, in this order.
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) ((size = u64(cd, q)), (q += 8));
        if (csize === 0xffffffff) ((csize = u64(cd, q)), (q += 8));
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    p = end + commentLen;
    if (!name.endsWith("/")) entries.set(prefix ? `${prefix}/${name}` : name, { method, csize, size, offset, flags });
  }
  return {
    name: file.name,
    paths: [...entries.keys()],
    size: (path) => entries.get(path)?.size ?? 0,
    async open(path) {
      const x = entries.get(path)!;
      if (x.flags & 1) throw new Error(`${path} in ${file.name} is locked with a password, so Atlas can't read it.`);
      const local = new DataView(await file.slice(x.offset, x.offset + 30).arrayBuffer());
      if (u32(local, 0) !== 0x04034b50) throw new Error(`${file.name} is damaged around ${path}. Download it again.`);
      const start = x.offset + 30 + u16(local, 26) + u16(local, 28);
      const raw = file.slice(start, start + x.csize).stream();
      if (x.method === 0) return raw;
      if (x.method === 8)
        return raw.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      throw new Error(`${path} in ${file.name} is packed a way Atlas can't open (method ${x.method}).`);
    },
  };
}

// --- tar and tar.gz ---------------------------------------------------------------------------------------

/** The most a tar's wanted files may hold together, since a tar is read once from start to end and kept. */
const TAR_KEEP = 64_000_000;

/** A tar (gzipped or not), read once: every path listed, and the wanted ones' bytes kept. */
async function tar(file: File, gz: boolean, wanted: (path: string) => boolean, prefix: string): Promise<Picked> {
  let stream: ReadableStream<Uint8Array> = file.stream();
  if (gz) stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const r = new Bytes(stream.getReader());
  const kept = new Map<string, Uint8Array>();
  const sizes = new Map<string, number>();
  let longName: string | null = null;
  let paxPath: string | null = null;
  let total = 0;
  for (;;) {
    const h = await r.read(512);
    if (!h || h.every((b) => b === 0)) break;
    const str = (a: number, b: number) => enc.decode(h.slice(a, b)).replace(/\0.*$/s, "");
    const size = sizeOf(h);
    const type = String.fromCharCode(h[156]!);
    const name = (longName ?? paxPath ?? [str(345, 500), str(0, 100)].filter(Boolean).join("/")).replace(/^\.\//, "");
    const body = Math.ceil(size / 512) * 512;
    if (type === "L" || type === "x") {
      const data = await r.read(body);
      const text = enc.decode(data?.slice(0, size)).replace(/\0+$/, "");
      if (type === "L") longName = text;
      else paxPath = /(?:^|\n)\d+ path=([^\n]*)/.exec(text)?.[1] ?? null;
      continue;
    }
    longName = null;
    paxPath = null;
    const path = prefix ? `${prefix}/${name}` : name;
    if ((type === "0" || type === "\0") && name && !name.endsWith("/")) {
      sizes.set(path, size);
      if (wanted(path) && total + size <= TAR_KEEP) {
        const data = await r.read(body);
        kept.set(path, data!.slice(0, size));
        total += size;
        continue;
      }
    }
    await r.skip(body);
  }
  return {
    name: file.name,
    paths: [...sizes.keys()],
    size: (p) => sizes.get(p) ?? 0,
    async open(p) {
      const b = kept.get(p);
      if (!b) throw new Error(`${p} in ${file.name} is too big to read from a tar here; take it out and drop it on its own.`);
      return new Blob([b as Uint8Array<ArrayBuffer>]).stream();
    },
  };
}

/** A tar header's size: octal, or base-256 for a big file. */
function sizeOf(h: Uint8Array): number {
  if (h[124]! & 0x80) {
    let n = 0;
    for (let i = 125; i < 136; i++) n = n * 256 + h[i]!;
    return n;
  }
  return parseInt(enc.decode(h.slice(124, 136)).replace(/[^0-7]/g, "") || "0", 8);
}

/** Reads a stream by counts of bytes. */
class Bytes {
  #buf: Uint8Array[] = [];
  #have = 0;
  #done = false;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}
  async #fill(n: number): Promise<void> {
    while (this.#have < n && !this.#done) {
      const { done, value } = await this.reader.read();
      if (done) this.#done = true;
      else if (value?.length) {
        this.#buf.push(value);
        this.#have += value.length;
      }
    }
  }
  async read(n: number): Promise<Uint8Array | null> {
    await this.#fill(n);
    if (this.#have < n) return null;
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const b = this.#buf[0]!;
      const take = Math.min(b.length, n - o);
      out.set(b.subarray(0, take), o);
      o += take;
      if (take === b.length) this.#buf.shift();
      else this.#buf[0] = b.subarray(take);
    }
    this.#have -= n;
    return out;
  }
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      await this.#fill(Math.min(left, 1 << 20));
      if (!this.#have) return;
      const take = Math.min(left, this.#have);
      await this.read(take);
      left -= take;
    }
  }
}

// --- sending in parts ---------------------------------------------------------------------------------------

/** The most text one request carries; the core takes up to 12 MB. */
export const PART_CHARS = 4_000_000;

/**
 * A file's text in parts of at most `max` characters. A JSON file whose top
 * level is a list is cut between its items, each part a list of its own; any
 * other text is cut between lines. Read as a stream, so a 300 MB export is
 * never held whole.
 */
export async function* parts(
  stream: ReadableStream<Uint8Array>,
  json: boolean,
  max = PART_CHARS,
  onBytes?: (n: number) => void,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const chunks = async function* () {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes?.(value.length);
      yield dec.decode(value, { stream: true });
    }
    const last = dec.decode();
    if (last) yield last;
  };
  if (!json) {
    let buf = "";
    for await (const c of chunks()) {
      buf += c;
      while (buf.length > max) {
        const cut = buf.lastIndexOf("\n", max) > 0 ? buf.lastIndexOf("\n", max) + 1 : max;
        yield buf.slice(0, cut);
        buf = buf.slice(cut);
      }
    }
    if (buf) yield buf;
    return;
  }
  // A list's items are found by depth, outside strings; anything else is sent whole.
  let started = false;
  let list = false;
  let whole = "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  let item = "";
  let batch: string[] = [];
  let size = 0;
  const flush = () => {
    const out = `[${batch.join(",")}]`;
    batch = [];
    size = 0;
    return out;
  };
  for await (const c of chunks()) {
    let i = 0;
    if (!started) {
      const t = c.replace(/^﻿/, "");
      const first = /\S/.exec(t);
      if (!first) continue;
      started = true;
      list = t[first.index] === "[";
      if (!list) {
        whole = t;
        continue;
      }
      i = c.indexOf("[") + 1;
      depth = 1;
    } else if (!list) {
      whole += c;
      if (whole.length > max * 3) throw new Error("It's one big JSON object, too big to send in one go.");
      continue;
    }
    let from = i;
    for (; i < c.length; i++) {
      const ch = c[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          const last = (item + c.slice(from, i)).trim();
          if (last) batch.push(last);
          item = "";
          from = i + 1;
          break;
        }
      } else if (ch === "," && depth === 1) {
        const el = (item + c.slice(from, i)).trim();
        item = "";
        from = i + 1;
        if (el) {
          if (size && size + el.length > max) yield flush();
          batch.push(el);
          size += el.length + 1;
        }
      }
    }
    if (depth > 0) item += c.slice(from);
  }
  if (!list) {
    if (whole) yield whole;
    return;
  }
  if (batch.length) yield flush();
}

/** A file's bytes as base64, for a skill's folder. */
export async function base64Of(stream: ReadableStream<Uint8Array>): Promise<{ b64: string; size: number }> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { b64: btoa(s), size: bytes.length };
}

/** A whole small file as text. */
export const textOf = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
