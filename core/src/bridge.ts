// The bridge (VISION §8.2): a small program in the workspace container that
// runs coding agents for the core. The core can't hold an agent's stdin and
// stdout itself: a deploy restarts the agent object and drops its
// connections, while the container and its processes keep running. So the
// bridge starts each job's agent, numbers every line the agent prints, and
// keeps them until the core has read them; the core asks for the lines after
// the last one it saw, and writes to the agent's stdin through it. A deploy
// costs nothing but a reconnect.
//
// It listens on a port inside the container and answers only requests that
// carry its key, which the workspace's Durable Object gave it in its
// environment: no agent can read root's environment, so none can drive it.
// Each agent runs as its job's own user, in its own process group, with
// exactly the environment the core gives it, nothing inherited, so it can't
// pick up a credential it wasn't meant to have; stopping a job stops all it
// started. What it prints on stderr goes to a log in the job's folder, and
// its last lines come back with its status, so a failure explains itself.
//
// It's plain JavaScript for the container's Node, kept here as text: the
// workspace writes it into the container when it first needs it. No
// backticks inside, so it can live in a template string.

export const BRIDGE_PORT = 7701;
export const BRIDGE_PATH = "/opt/atlas/bridge.mjs";
/** Changing the bridge changes this, so a container running an older one starts the new one. */
export const BRIDGE_VERSION = "2";
/** The header every request to the bridge carries its key in. */
export const BRIDGE_KEY_HEADER = "x-atlas-bridge-key";

export const BRIDGE_JS = String.raw`// Atlas's bridge: runs coding agents and keeps what they print until it's read.
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";

const VERSION = "${BRIDGE_VERSION}";
const PORT = ${BRIDGE_PORT};
const KEY = process.env.ATLAS_BRIDGE_KEY || "";
/** The most of an agent's lines one read hands back, in characters: a long session's replay comes in several reads. */
const READ_LIMIT = 2000000;
/** Lines kept per job before the oldest unread ones are dropped (the core reads every minute or faster). */
const KEEP = 20000;
const jobs = new Map();

function job(id) {
  return jobs.get(id) || null;
}

function status(j) {
  return {
    running: j.exit === null,
    exit: j.exit,
    signal: j.signal,
    pid: j.child ? j.child.pid : null,
    started: j.started,
    last: j.seq,
    stderr: j.err.slice(-4000),
  };
}

function start(o) {
  const was = job(o.id);
  if (was && was.exit === null) return { already: true, ...status(was) };
  fs.mkdirSync(o.cwd, { recursive: true });
  if (o.log) fs.mkdirSync(o.log.replace(/\/[^/]*$/, ""), { recursive: true });
  const child = spawn(o.command[0], o.command.slice(1), {
    cwd: o.cwd,
    env: o.env || {},
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    ...(o.uid != null ? { uid: o.uid, gid: o.gid } : {}),
  });
  const j = { id: o.id, child, lines: [], seq: was ? was.seq : 0, exit: null, signal: null, started: Date.now(), err: "", buf: "", waiters: [] };
  jobs.set(o.id, j);
  const log = o.log ? fs.createWriteStream(o.log, { flags: "a" }) : null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    j.buf += d;
    let i;
    while ((i = j.buf.indexOf("\n")) >= 0) {
      const text = j.buf.slice(0, i);
      j.buf = j.buf.slice(i + 1);
      if (!text.trim()) continue;
      j.seq += 1;
      j.lines.push({ seq: j.seq, text });
      if (j.lines.length > KEEP) j.lines.splice(0, j.lines.length - KEEP);
    }
    wake(j);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    j.err = (j.err + d).slice(-20000);
    if (log) log.write(d);
  });
  child.on("error", (e) => {
    j.err += "\n" + String(e && e.message ? e.message : e);
    if (j.exit === null) j.exit = -1;
    wake(j);
  });
  child.on("exit", (code, signal) => {
    j.exit = code === null ? -1 : code;
    j.signal = signal;
    if (log) log.end();
    wake(j);
  });
  child.stdin.on("error", () => {});
  return { already: false, ...status(j) };
}

function wake(j) {
  const w = j.waiters;
  j.waiters = [];
  for (const f of w) f();
}

function read(j, after, wait) {
  // What the core has seen is no longer kept.
  while (j.lines.length && j.lines[0].seq <= after) j.lines.shift();
  const out = () => {
    const lines = [];
    let size = 0;
    for (const l of j.lines) {
      if (l.seq <= after) continue;
      if (lines.length && size + l.text.length > READ_LIMIT) break;
      lines.push(l);
      size += l.text.length;
    }
    return { lines, ...status(j) };
  };
  if (j.lines.some((l) => l.seq > after) || j.exit !== null || !wait) return Promise.resolve(out());
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(out()), Math.min(wait, 25000));
    j.waiters.push(() => {
      clearTimeout(t);
      resolve(out());
    });
  });
}

/** Stops the agent and everything it started: its whole process group. */
function stop(j) {
  const group = (sig) => {
    try {
      process.kill(-j.child.pid, sig);
    } catch {}
  };
  group("SIGTERM");
  setTimeout(() => group("SIGKILL"), 3000);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (s += d));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res, code, value) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://bridge");
      if (!KEY || req.headers["x-atlas-bridge-key"] !== KEY) return send(res, 403, { error: "The bridge answers only Atlas." });
      const id = url.searchParams.get("id") || "";
      if (req.method === "POST" && url.pathname === "/exit") {
        send(res, 200, { ok: true });
        return setTimeout(() => process.exit(0), 100);
      }
      if (url.pathname === "/health") return send(res, 200, { ok: true, version: VERSION, jobs: [...jobs.keys()] });
      if (req.method === "POST" && url.pathname === "/start") return send(res, 200, start(await body(req)));
      const j = job(id);
      if (!j) return send(res, 404, { error: "No agent is running for job " + id + " in the workspace." });
      if (url.pathname === "/read") {
        return send(res, 200, await read(j, Number(url.searchParams.get("after") || 0), Number(url.searchParams.get("wait") || 0)));
      }
      if (req.method === "POST" && url.pathname === "/send") {
        const b = await body(req);
        if (j.exit !== null) return send(res, 409, { error: "The agent has ended (exit " + j.exit + ").", ...status(j) });
        for (const l of b.lines || []) j.child.stdin.write(String(l).replace(/\n/g, " ") + "\n");
        return send(res, 200, status(j));
      }
      if (req.method === "POST" && url.pathname === "/stop") {
        stop(j);
        return send(res, 200, status(j));
      }
      return send(res, 404, { error: "The bridge has no " + url.pathname + "." });
    } catch (e) {
      return send(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  })
  .listen(PORT, "0.0.0.0");
`;
