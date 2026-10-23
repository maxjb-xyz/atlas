// The workspace (§9.1): a container per person, with a shell, Python, Node,
// git and files, driven by its own Durable Object (Sandbox SDK 1.0's way:
// `ctx.container`, no SDK class). It starts from Cloudflare's managed
// Debian image, so deploying needs no Docker; the first start installs
// Python and the rest once and keeps that as a snapshot to start from.
//
// Nothing leaves it unless the owner said yes to that website: the
// container has no internet of its own, and every request goes through
// `WorkspaceEgress`, which lets through only approved sites and adds a
// vault key to a site's requests outside the container (§15). /workspace
// is kept in R2 after each command and put back when a new container
// starts, so files outlive the container.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { BRIDGE_JS, BRIDGE_KEY_HEADER, BRIDGE_PATH, BRIDGE_PORT, BRIDGE_VERSION } from "./bridge";

const IMAGE = "cloudflare/debian-trixie";
/** How long the container stays up after the last use. Container time is billed while it waits. */
const IDLE_MS = 10 * 60_000;
/** What the first start installs. Changing it changes BASE, so the next start makes a new snapshot. */
const PACKAGES = [
  "python3",
  "python3-pip",
  "python3-venv",
  "python3-pandas",
  "python3-openpyxl",
  "python3-docx",
  "python3-reportlab",
  "python3-matplotlib",
  "python3-requests",
  "git",
  "curl",
  "ca-certificates",
  "zip",
  "unzip",
  "jq",
  "sqlite3",
  "file",
  "tmux",
];
const BASE = `atlas-base-1:${PACKAGES.join(",")}`;
/** Where the setup's packages come from: allowed only while setting up. */
const SETUP_HOSTS = ["deb.debian.org", "security.debian.org"];
/** /workspace bigger than this isn't kept between containers (it says so). */
const KEEP_LIMIT = 200_000_000;
/** The most of a command's output that comes back. */
const OUTPUT_LIMIT = 200_000;
const BACKUP = (ws: string) => `workspace/${ws}.tgz`;
/**
 * A job's own folder: its repo, its agent's home, the agent's log. Outside
 * /workspace (a job keeps itself, jobSave), and owned by the job's own user:
 * its agent and every command Atlas runs on its work run as that user, which
 * can't read /workspace, other jobs or root's processes.
 */
const JOBS = "/srv/jobs";
const jobDir = (id: string) => `${JOBS}/${id}`;
/** Where Atlas copies a job's commits to push them: root's only. */
const PUSH = "/srv/push";
/** A job's user: its own name and ids, made the first time it's needed in a container. */
const userOf = (id: string) => `aj${id.replace(/[^a-z0-9]/g, "").slice(-12)}`;
const JOB_SAVE = (ws: string, id: string, what: "repo.bundle" | "home.tgz") => `jobs/${ws}/${id}/${what}`;
/** A job's saved home bigger than this isn't kept (it says so). */
const HOME_LIMIT = 50_000_000;
/** Where coding agents are installed: outside /workspace, so they don't count against its copy. */
const AGENTS = "/opt/atlas/agents";
/** npm's registry, opened to the workspace while an agent installs. */
const NPM_HOSTS = ["registry.npmjs.org"];
/** A job's work kept in R2 bigger than this isn't kept (it says so): it's read into memory to keep it. */
const SAVE_LIMIT = 40_000_000;
/** A job's entry on the gate lasts this long unless its agent is read again. */
const JOB_GATE_MS = 20 * 60_000;
const safeId = (id: string) => {
  if (!/^[a-z0-9_]{3,64}$/.test(id)) throw new Error(`"${id}" isn't a job id the workspace takes.`);
  return id;
};

/** A coding agent to run: the npm package with its ACP server, and the command it installs. */
export interface AgentSpec {
  package: string;
  /** More packages to install beside it, pinned (the agent's own binary, so its version can't drift). */
  with?: string[];
  bin: string;
  args?: string[];
}

/** How a job's agent is doing, as the bridge says. */
export interface AgentStatus {
  running: boolean;
  exit: number | null;
  signal: string | null;
  /** The last line's number. */
  last: number;
  /** The end of what it printed on stderr: the reason, when it ended. */
  stderr: string;
}

export type JobRead =
  | ({ ok: true; lines: Array<{ seq: number; text: string }> } & AgentStatus)
  /** The container (or its bridge, or this job's agent) is gone: asleep, restarted or lost. */
  | { ok: false; gone: true; why: string };

const CERTS = "/etc/ssl/certs/ca-certificates.crt";
const GATE_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** Written last when a container is fully set up, so a half-set-up one is never mistaken for ready. */
const READY = "/etc/atlas-ready";

/** Debian's package sources over HTTP, for setting up before there's a CA bundle. */
const HTTP_SOURCES =
  "for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do " +
  '[ -f "$f" ] && sed -i \'s#https://deb.debian.org#http://deb.debian.org#g; s#https://security.debian.org#http://security.debian.org#g\' "$f"; done; true';

/**
 * Trusts the gate's certificate: waits for it, adds it to the system bundle
 * (with update-ca-certificates when there is one, else straight into the
 * bundle), and checks the bundle is there. Each failure says which step.
 */
const TRUST = [
  `for i in $(seq 1 50); do [ -s ${GATE_CA} ] && break; sleep 0.2; done`,
  `[ -s ${GATE_CA} ] || { echo "The gate's certificate never appeared at ${GATE_CA}."; exit 1; }`,
  `mkdir -p /usr/local/share/ca-certificates /etc/ssl/certs /workspace`,
  `cp ${GATE_CA} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt`,
  `if command -v update-ca-certificates >/dev/null 2>&1; then out=$(update-ca-certificates 2>&1) || { echo "update-ca-certificates failed: $out" | tail -5; exit 1; }; ` +
    `else grep -qF "$(sed -n 2p ${GATE_CA})" ${CERTS} 2>/dev/null || cat ${GATE_CA} >> ${CERTS}; fi`,
  `grep -q "BEGIN CERTIFICATE" ${CERTS} || { echo "${CERTS} has no certificates after trusting the gate."; exit 1; }`,
].join("; ");
/** Every command's environment: the container's CA trusted everywhere (the egress gate re-signs HTTPS). */
const ENV: Record<string, string> = {
  HOME: "/root",
  LANG: "C.UTF-8",
  TERM: "dumb",
  PYTHONUNBUFFERED: "1",
  DEBIAN_FRONTEND: "noninteractive",
  SSL_CERT_FILE: CERTS,
  REQUESTS_CA_BUNDLE: CERTS,
  PIP_CERT: CERTS,
  NODE_EXTRA_CA_CERTS: GATE_CA,
  GIT_SSL_CAINFO: CERTS,
  // Codex's own binary reads its certificates from here.
  CODEX_CA_CERTIFICATE: CERTS,
};

/** One line of a run's stream. */
export type RunEvent =
  { note: string } | { out: string } | { done: { exit: number; ms: number; blocked: string[]; kept: string } } | { error: string };

/**
 * A key the gate adds to a site's requests, in the header that site reads
 * (`authorization` for most, `x-api-key` for some). With `nonce`, only a
 * request carrying it in `x-atlas-key` gets the key: Atlas's own git steps
 * carry one, so a coding agent running beside them can't use the token.
 */
export interface KeyRule {
  host: string;
  header: string;
  value: string;
  nonce?: string;
  /** Only requests to this exact host whose path starts with this (one repo's git address): not its subdomains or other paths. */
  path?: string;
}

/** What a running job adds to the gate while it runs: its agent's model site, with its key. */
export interface JobGate {
  allow: string[];
  rules: KeyRule[];
}

interface Gate {
  /** The workspace's name, so a refusal can be noted there. */
  ws: string;
  /** Hostnames it may reach; "example.com" also covers its subdomains. */
  allow: string[];
  /** A header value to add to a host's requests (a vault key, as "Bearer …"). */
  inject: Record<string, string>;
  /** Keys in other headers, or only for requests that carry a nonce. */
  rules?: KeyRule[];
}

const allowed = (host: string, allow: string[]) => allow.some((a) => host === a || host.endsWith(`.${a}`));
const covers = (host: string, h: string) => host === h || host.endsWith(`.${h}`);
/**
 * What a command carrying keys adds to the gate while it runs: the keys, and
 * their sites, which it has to reach (a clone needs the code host even when
 * the owner never opened it to the workspace). The site is open to anything
 * in the container for that while; the key still goes only with the nonce.
 */
export function carrying(rules: KeyRule[]): { allow: string[]; rules: KeyRule[] } {
  return { allow: [...new Set(rules.map((r) => r.host))], rules };
}

/** The header Atlas's own commands carry their nonce in. The gate takes it off before the request leaves. */
export const NONCE_HEADER = "x-atlas-key";

/**
 * Every request the container makes comes here (§9.1, §15). An approved
 * site goes through, with its vault key added when there is one; anything
 * else is refused with a reason the command can print, and noted, so Atlas
 * knows which site to ask about.
 */
export class WorkspaceEgress extends WorkerEntrypoint<Env, Gate> {
  override async fetch(req: Request): Promise<Response> {
    const out = throughGate(req, this.ctx.props);
    if ("refused" in out) {
      await this.env.WORKSPACE.getByName(this.ctx.props.ws)
        .noteBlocked(out.refused)
        .catch(() => {});
      return new Response(`Atlas's workspace can't reach ${out.refused}: the owner hasn't allowed it yet.\n`, { status: 403 });
    }
    return fetch(out.request);
  }
}

/**
 * What the gate does to one request: refuses a site that isn't allowed, or
 * lets it out with its keys put in. A key behind a nonce goes only with a
 * request carrying that nonce, and the nonce never leaves the gate.
 */
export function throughGate(req: Request, gate: Omit<Gate, "ws">): { refused: string } | { request: Request } {
  const host = new URL(req.url).hostname.toLowerCase();
  if (!allowed(host, gate.allow)) return { refused: host };
  const nonce = req.headers.get(NONCE_HEADER);
  const path = new URL(req.url).pathname;
  const rules = (gate.rules ?? []).filter(
    (r) => (r.path ? host === r.host && path.startsWith(r.path) : covers(host, r.host)) && (!r.nonce || r.nonce === nonce),
  );
  const key = Object.entries(gate.inject).find(([h]) => covers(host, h))?.[1];
  if (!key && !rules.length && nonce == null) return { request: req };
  const r = new Request(req);
  r.headers.delete(NONCE_HEADER);
  if (key) r.headers.set("authorization", key);
  for (const rule of rules) r.headers.set(rule.header, rule.value);
  return { request: r };
}

interface Saved {
  snapshot: { id: string; base: string } | null;
}

/** A preview link: a port in the container, reachable at /preview/<token>/ until it expires. */
interface Preview {
  port: number;
  expires: number;
}

/** How long a preview link works. Anyone with the link can open it, like Cloudflare's own preview URLs. */
const PREVIEW_MS = 24 * 3600_000;

/** Quotes a string for bash. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class Workspace extends DurableObject<Env> {
  #blocked = new Set<string>();
  #starting: Promise<void> | null = null;
  /** The running container got all the way through setting up (see READY). */
  #ready = false;

  /** Stops the container, so the next command starts it fresh. /workspace and the setup snapshot are kept. */
  async restart(): Promise<void> {
    await this.#stop("restarted by the owner");
  }

  /** Stops the container and waits until it has, so the next start doesn't find it still going. */
  async #stop(why: string): Promise<void> {
    this.#ready = false;
    const c = this.ctx.container;
    if (!c?.running) return;
    await c.destroy(why).catch(() => {});
    for (let i = 0; i < 50 && c.running; i++) await new Promise((r) => setTimeout(r, 200));
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const c = ctx.container;
    if (c?.running) void ctx.blockConcurrencyWhile(() => c.setInactivityTimeout(IDLE_MS));
  }

  get #c(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("This deployment has no workspace container (the Workspace class isn't bound to a container application).");
    return c;
  }

  get #name(): string {
    return this.ctx.id.name ?? "owner";
  }

  async #saved(): Promise<Saved> {
    return (await this.ctx.storage.get<Saved>("saved")) ?? { snapshot: null };
  }

  /** A site the gate refused during a command. */
  async noteBlocked(host: string): Promise<void> {
    this.#blocked.add(host);
  }

  /** Whether the container is up now. */
  async status(): Promise<{ running: boolean; ready: boolean }> {
    const saved = await this.#saved();
    return { running: Boolean(this.ctx.container?.running), ready: saved.snapshot?.base === BASE };
  }

  /** Runs a command and waits for all it prints. `stderr: "pipe"` keeps errors out of what it prints, for bytes kept as they are (a bundle, a tarball). */
  async #exec(
    cmd: string,
    o: { stdin?: ReadableStream; timeoutS?: number; stderr?: "pipe"; as?: string } = {},
  ): Promise<{ exit: number; out: string; bytes: ArrayBuffer; err: string }> {
    const timed = o.timeoutS ? `timeout -k 5 ${o.timeoutS} bash -lc ${sh(cmd)}` : cmd;
    const user = o.as ? await this.#jobUser(o.as) : null;
    const p = await this.#c.exec(["bash", "-lc", user ? `runuser -u ${user.name} -- bash -lc ${sh(timed)}` : timed], {
      env: { ...ENV, ...(user ? { HOME: `${jobDir(o.as!)}/home` } : {}) },
      cwd: "/",
      stderr: o.stderr ?? "combined",
      ...(o.stdin ? { stdin: o.stdin } : {}),
    });
    const r = (await p.output()) as { exitCode: number; stdout: ArrayBuffer; stderr?: ArrayBuffer };
    return {
      exit: r.exitCode,
      out: new TextDecoder().decode(r.stdout),
      bytes: r.stdout,
      err: r.stderr ? new TextDecoder().decode(r.stderr) : "",
    };
  }

  /**
   * The container has one gate, made of: the owner's sites and vault keys;
   * what each command running now adds (an install's npm, a git step's key
   * behind its nonce), until it ends; and each running job's model site and
   * key, while its entry's lease holds (renewed as the job's agent is read).
   */
  async #gate(): Promise<void> {
    this.#base ??= (await this.ctx.storage.get<{ allow: string[]; inject: Record<string, string> }>("base_gate")) ?? {
      allow: [],
      inject: {},
    };
    const now = Date.now();
    const jobs = Object.values((await this.ctx.storage.get<Record<string, JobGate & { until?: number }>>("job_gates")) ?? {}).filter(
      (j) => (j.until ?? 0) > now,
    );
    const extra = [...this.#extra.values()];
    // The gate can't tell who's asking, so while a job's agent runs, the owner's vault keys stay off it: an agent could
    // otherwise reach their sites with them. The owner's own commands then reach those sites without the key.
    this.#keysOff = jobs.length > 0 && Object.keys(this.#base.inject).length > 0;
    if (jobs.length) {
      const next = Math.min(...jobs.map((j) => j.until ?? now));
      await this.ctx.storage.setAlarm(next + 1_000).catch(() => {});
    }
    const gw = (this.ctx.exports as unknown as { WorkspaceEgress(o: { props: Gate }): Fetcher }).WorkspaceEgress({
      props: {
        ws: this.#name,
        allow: [...new Set([...this.#base.allow, ...extra.flatMap((e) => e.allow), ...jobs.flatMap((j) => j.allow)])],
        inject: jobs.length ? {} : this.#base.inject,
        rules: [...extra.flatMap((e) => e.rules), ...jobs.flatMap((j) => j.rules)],
      },
    });
    await this.#c.interceptOutboundHttps("*", gw);
    await this.#c.interceptAllOutboundHttp(gw);
    this.#gated = true;
  }

  /**
   * Starts the container if it isn't up: from the setup snapshot when there
   * is one, else from the managed image, installing the packages and
   * keeping a snapshot. Then trusts the gate's certificate and puts
   * /workspace back from R2.
   */
  async #up(say: (note: string) => Promise<void>): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.ctx.container?.running) {
      // Running isn't ready: a start that failed partway leaves a container without its packages.
      // Only one that got all the way through (and left the marker) is used; any other starts over.
      if (this.#ready) return;
      const marked = await this.#exec(`grep -qxF ${sh(BASE)} ${READY}`).then(
        (r) => (r.exit === 0 ? "yes" : "no"),
        () => "gone",
      );
      if (marked === "yes") {
        this.#ready = true;
        return;
      }
      // "gone": it's stopping (or stuck) and didn't answer; "no": it answered without the marker.
      if (marked === "no") await say("The workspace was left half set up, so it's starting over.");
      await this.#stop(marked === "no" ? "left half set up" : "didn't answer");
    }
    this.#starting ??= (async () => {
      const saved = await this.#saved();
      const fromSnapshot = saved.snapshot?.base === BASE ? saved.snapshot : null;
      const start = async (snap: { id: string } | null) => {
        this.#c.start({
          ...(snap ? { containerSnapshot: { id: snap.id } } : { image: IMAGE }),
          entrypoint: ["sleep", "infinity"],
          enableInternet: false,
          // A coding job builds and tests real projects: half a vCPU and 4 GB (the smallest, lite, has 256 MB).
          instance: "standard-1",
        });
        await this.#c.setInactivityTimeout(IDLE_MS);
        const ok = await this.#exec("true").then(
          (r) => r.exit === 0,
          () => false,
        );
        return ok;
      };
      await say(fromSnapshot ? "Starting the workspace." : "Setting up the workspace for the first time (a minute or two).");
      let ok = await start(fromSnapshot);
      if (!ok && fromSnapshot) {
        // The snapshot ran out (they last 30 days unused): set up again from the image.
        await this.#c.destroy("snapshot expired").catch(() => {});
        await this.ctx.storage.put<Saved>("saved", { snapshot: null });
        await say("The workspace's saved setup was gone, so it's setting up again.");
        ok = await start(null);
      }
      if (!ok) throw new Error("The workspace container didn't start.");
      // The gate's certificate appears once a gate is registered, so register one (setup's package sites, or nothing) first.
      const settingUp = !(await this.#saved()).snapshot;
      // Setting up reaches Debian's package sites only, for this step.
      if (settingUp) this.#extra.set("setup", { allow: SETUP_HOSTS, rules: [] });
      await this.#gate();
      this.#extra.delete("setup");
      if (settingUp) {
        // The managed image has no CA bundle (no ca-certificates package), so the packages come first,
        // over plain HTTP: apt checks every package's signature, and HTTPS would need the bundle it's installing.
        const setup = await this.#exec(
          `${HTTP_SOURCES} && apt-get update -qq >/tmp/setup.log 2>&1 && apt-get install -y -qq --no-install-recommends ${PACKAGES.join(" ")} >>/tmp/setup.log 2>&1 || (tail -40 /tmp/setup.log; exit 1)`,
          { timeoutS: 900 },
        );
        if (setup.exit !== 0) throw new Error(`Setting up the workspace failed: ${setup.out.slice(-1_500)}`);
      }
      // Then the gate's certificate (it re-signs HTTPS), into the system bundle every tool reads.
      const trust = await this.#exec(TRUST);
      if (trust.exit !== 0) throw new Error(`The workspace couldn't trust its gate's certificate: ${trust.out.slice(-500)}`);
      if (settingUp) {
        const snap = await this.#c.snapshotContainer({ name: "atlas-base" });
        await this.ctx.storage.put<Saved>("saved", { snapshot: { id: snap.id, base: BASE } });
      }
      const backup = await this.env.FILES.get(BACKUP(this.#name));
      if (backup) {
        const r = await this.#exec("tar xzf - -C /", { stdin: backup.body });
        if (r.exit !== 0) await say(`Couldn't put /workspace back from its copy: ${r.out.slice(-300)}`);
      }
      // Jobs' users can't read the owner's files, each other's folders, or where Atlas pushes from.
      const fence = await this.#exec(`chmod 700 /workspace && mkdir -p ${JOBS} ${PUSH} && chmod 711 ${JOBS} && chmod 700 ${PUSH}`);
      if (fence.exit !== 0) throw new Error(`The workspace couldn't set its folders' rights: ${fence.out.slice(-300)}`);
      const mark = await this.#exec(`echo ${sh(BASE)} > ${READY}`);
      if (mark.exit !== 0) throw new Error(`The workspace couldn't mark itself ready: ${mark.out.slice(-300)}`);
      this.#ready = true;
    })()
      .catch(async (err: unknown) => {
        // A start that failed doesn't leave a half-set-up container behind for the next command to trust.
        this.#ready = false;
        console.error(JSON.stringify({ at: "workspace.up", error: err instanceof Error ? err.message : String(err) }));
        await this.ctx.container?.destroy("setup failed").catch(() => {});
        throw err;
      })
      .finally(() => {
        this.#starting = null;
      });
    await this.#starting;
  }

  /** Keeps /workspace in R2, so it outlives the container. Says what happened. */
  async #keep(): Promise<string> {
    const size = await this.#exec("du -sb /workspace | cut -f1");
    const n = Number(size.out.trim());
    if (!Number.isFinite(n)) return "";
    if (n > KEEP_LIMIT)
      return `/workspace is ${Math.round(n / 1e6)} MB, over the ${KEEP_LIMIT / 1e6} MB that's kept between sessions; big files there are lost when the workspace sleeps.`;
    const tar = await this.#exec("tar czf - -C / workspace");
    if (tar.exit !== 0) return `Couldn't keep /workspace: ${new TextDecoder().decode(tar.bytes).slice(-200)}`;
    await this.env.FILES.put(BACKUP(this.#name), tar.bytes);
    return "";
  }

  /**
   * Runs a command in /workspace with bash, at most `timeout_s` seconds,
   * and streams what it prints as lines of JSON (RunEvent), ending with its
   * exit code, how long it took and which sites the gate refused.
   */
  async run(o: {
    command: string;
    timeout_s: number;
    allow: string[];
    inject: Record<string, string>;
    /** Where it runs: /workspace, or a job's folder. */
    cwd?: string;
    /** Keys for this command only, such as a git token behind a nonce. */
    rules?: KeyRule[];
    /** More environment for this command (a git setting carrying a nonce: the environment, unlike the command line, only root can read). */
    env?: Record<string, string>;
    /** Runs as this job's user, in its folder: anything the job's agent wrote runs with no more than the agent's rights. */
    as?: string;
  }): Promise<ReadableStream<Uint8Array>> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    const enc = new TextEncoder();
    const send = (e: RunEvent) => w.write(enc.encode(`${JSON.stringify(e)}\n`));
    const key = `run:${crypto.randomUUID()}`;
    void (async () => {
      const t0 = Date.now();
      try {
        await this.#up((note) => send({ note }));
        const cwd = o.cwd ?? "/workspace";
        if (cwd !== "/workspace" && !cwd.startsWith(`${JOBS}/`) && !cwd.startsWith(`${PUSH}/`))
          throw new Error(`Commands run in /workspace or a job's folder, not ${cwd}.`);
        if (o.as && !cwd.startsWith(`${jobDir(safeId(o.as))}`)) throw new Error("A job's commands run in its own folder.");
        // What's in a command's own environment (a nonce) never goes to a job's user.
        if (o.as && o.env && Object.keys(o.env).length) throw new Error("A job's commands don't take an environment of their own.");
        await this.#setBase({ allow: o.allow, inject: o.inject });
        if (o.rules?.length) this.#extra.set(key, carrying(o.rules));
        await this.#gate();
        this.#blocked.clear();
        const inner = `cd ${sh(cwd)} && timeout -k 5 ${o.timeout_s} bash -lc ${sh(o.command)}`;
        const user = o.as ? await this.#jobUser(o.as) : null;
        const p = await this.#c.exec(
          ["bash", "-lc", user ? `runuser -u ${user.name} -- bash -lc ${sh(inner)}` : `mkdir -p ${sh(cwd)} && ${inner}`],
          {
            env: { ...ENV, ...(user ? { HOME: `${jobDir(o.as!)}/home` } : {}), ...(o.env ?? {}) },
            stderr: "combined",
          },
        );
        let sent = 0;
        const reader = p.stdout!.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (sent < OUTPUT_LIMIT) {
            const text = dec.decode(value, { stream: true });
            sent += text.length;
            await send({ out: sent > OUTPUT_LIMIT ? `${text.slice(0, text.length - (sent - OUTPUT_LIMIT))}\n… (output cut)` : text });
          }
        }
        const exit = await p.exitCode;
        // A key behind a nonce is for this command only.
        if (this.#extra.delete(key)) await this.#gate();
        const kept = await this.#keep();
        if (this.#keysOff) await send({ note: "Your vault keys aren't added to the workspace's requests while a coding job runs." });
        await send({ done: { exit, ms: Date.now() - t0, blocked: [...this.#blocked], kept } });
      } catch (err) {
        console.error(JSON.stringify({ at: "workspace.run", error: err instanceof Error ? err.message : String(err) }));
        await send({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        if (this.#extra.delete(key)) await this.#gate().catch(() => {});
        await w.close().catch(() => {});
      }
    })();
    return readable;
  }

  // --- coding jobs (§8.2) -------------------------------------------------------------------------------

  /** The bridge in the container (core/src/bridge.ts), started if it isn't running. Only while the container is up. */
  async #bridge(): Promise<Fetcher> {
    const port = this.#c.getTcpPort(BRIDGE_PORT);
    const key = await this.#bridgeKey();
    const health = async () =>
      port
        .fetch("http://bridge/health", { headers: { [BRIDGE_KEY_HEADER]: key } })
        .then(async (r) => (r.ok ? ((await r.json()) as { version: string; jobs: string[] }) : null))
        .catch(() => null);
    const h = await health();
    // An older bridge with agents running keeps going until they end; replacing it would stop them.
    if (h && (h.version === BRIDGE_VERSION || h.jobs.length)) return port;
    const write = await this.#exec(`mkdir -p /opt/atlas && cat > ${BRIDGE_PATH} && chmod 700 ${BRIDGE_PATH}`, {
      stdin: new Response(BRIDGE_JS).body!,
    });
    if (write.exit !== 0) throw new Error(`Couldn't put the bridge in the workspace: ${write.out.slice(-300)}`);
    if (h) {
      await port
        .fetch("http://bridge/exit", { method: "POST", headers: { [BRIDGE_KEY_HEADER]: await this.#bridgeKey() } })
        .catch(() => null);
      await new Promise((r) => setTimeout(r, 500));
    }
    // Started on its own, with nothing of this command's held open: only the exit code is waited for, never the
    // bridge, which runs until the container stops.
    const p = await this.#c.exec(
      [
        "bash",
        "-lc",
        `command -v node >/dev/null || { echo "The workspace has no node to run the bridge."; exit 1; }; setsid nohup node ${BRIDGE_PATH} </dev/null >/var/log/atlas-bridge.log 2>&1 &`,
      ],
      // Its key goes in its environment, which only root can read: no job's agent can drive it.
      { env: { ...ENV, ATLAS_BRIDGE_KEY: await this.#bridgeKey() }, cwd: "/" },
    );
    const exit = await p.exitCode;
    if (exit !== 0) throw new Error("The workspace has no node to run the bridge.");
    for (let i = 0; i < 40; i++) {
      if ((await health())?.version === BRIDGE_VERSION) return port;
      await new Promise((r) => setTimeout(r, 250));
    }
    const log = await this.#exec("tail -20 /var/log/atlas-bridge.log");
    throw new Error(`The bridge didn't start in the workspace: ${log.out.slice(-500) || "it printed nothing"}`);
  }

  async #bridgeCall<T>(path: string, init?: { body: unknown }): Promise<T> {
    const port = await this.#bridge();
    const headers = { [BRIDGE_KEY_HEADER]: await this.#bridgeKey() };
    const res = await port.fetch(`http://bridge${path}`, init ? { method: "POST", body: JSON.stringify(init.body), headers } : { headers });
    const out = (await res.json().catch(() => ({ error: `The bridge answered ${res.status} with something that isn't JSON.` }))) as T & {
      error?: string;
    };
    if (!res.ok || out.error) throw new Error(out.error ?? `The bridge answered ${res.status}.`);
    return out;
  }

  /** The bridge's key, made once and kept. */
  async #bridgeKey(): Promise<string> {
    this.#key ??= await this.ctx.storage.get<string>("bridge_key");
    if (!this.#key) {
      this.#key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
      await this.ctx.storage.put("bridge_key", this.#key);
    }
    return this.#key;
  }

  #key: string | undefined;

  /** A job's own user, made the first time it's needed in this container. */
  async #jobUser(id: string): Promise<{ name: string; uid: number; gid: number }> {
    const name = userOf(safeId(id));
    const r = await this.#exec(
      `id -u ${name} >/dev/null 2>&1 || useradd -M -U -d ${sh(`${jobDir(id)}/home`)} -s /bin/bash ${name} 2>&1; echo "$(id -u ${name}) $(id -g ${name})"`,
    );
    const [uid, gid] = r.out.trim().split("\n").at(-1)!.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || !uid)
      throw new Error(`The workspace couldn't make the job's user: ${r.out.slice(-300)}`);
    return { name, uid: uid!, gid: gid! };
  }

  /** Installs a coding agent if this container doesn't have it yet, and says where its command is. */
  async #install(agent: AgentSpec, say: (note: string) => Promise<void>): Promise<string> {
    const pinned = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9A-Za-z.+-]+$/;
    const all = [agent.package, ...(agent.with ?? [])];
    if (!all.every((x) => pinned.test(x)) || !/^[a-z0-9._-]+$/.test(agent.bin))
      throw new Error(`The coding agent ${agent.package} isn't named as pinned npm packages and a command.`);
    const dir = `${AGENTS}/${agent.package.replace(/[^a-zA-Z0-9.-]+/g, "_")}`;
    const bin = `${dir}/node_modules/.bin/${agent.bin}`;
    if ((await this.#exec(`test -x ${sh(bin)}`)).exit === 0) return bin;
    await say(`Installing ${agent.package} in the workspace (a minute or two, the first time after it sleeps).`);
    const key = `install:${crypto.randomUUID()}`;
    this.#extra.set(key, { allow: NPM_HOSTS, rules: [] });
    try {
      await this.#gate();
      const r = await this.#exec(
        `mkdir -p ${sh(dir)} && cd ${sh(dir)} && npm install --no-audit --no-fund --loglevel=error ${all.map(sh).join(" ")} 2>&1 | tail -30; test -x ${sh(bin)}`,
        { timeoutS: 900 },
      );
      if (r.exit !== 0) throw new Error(`Installing ${agent.package} in the workspace failed: ${r.out.slice(-800)}`);
      return bin;
    } finally {
      this.#extra.delete(key);
      await this.#gate().catch(() => {});
    }
  }

  /**
   * Starts a job's coding agent through the bridge, unless it's already
   * running there. The job's folder must be ready (its repo cloned or put
   * back). The agent runs with exactly `env`, plus the container's own
   * certificate settings, and the gate carries its key while the job runs.
   */
  async jobAgent(o: {
    id: string;
    agent: AgentSpec;
    env: Record<string, string>;
    gate: JobGate;
  }): Promise<AgentStatus & { already: boolean; notes: string[] }> {
    const id = safeId(o.id);
    const notes: string[] = [];
    const say = async (n: string) => void notes.push(n);
    await this.#up(say);
    await this.#setJobGate(id, o.gate);
    const bin = await this.#install(o.agent, say);
    await this.#gate();
    const dir = jobDir(id);
    const user = await this.#jobUser(id);
    const own = await this.#exec(
      // Only the folder and its home are given to the user here, never a tree it could have planted links in: the repo
      // was made by root in a staging folder and handed over there (jobClone).
      `mkdir -p ${sh(`${dir}/home`)} && chown -h ${user.uid}:${user.gid} ${sh(dir)} ${sh(`${dir}/home`)} && chmod 700 ${sh(dir)}`,
    );
    if (own.exit !== 0) throw new Error(`The workspace couldn't give the job its folder: ${own.out.slice(-300)}`);
    const env: Record<string, string> = {
      ...ENV,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: `${dir}/home`,
      ...o.env,
    };
    const out = await this.#bridgeCall<AgentStatus & { already: boolean }>("/start", {
      body: { id, command: [bin, ...(o.agent.args ?? [])], cwd: `${dir}/repo`, env, log: `${dir}/agent.log`, uid: user.uid, gid: user.gid },
    });
    return { ...out, notes };
  }

  /** Writes lines to a job's agent. */
  async jobSend(id: string, lines: string[]): Promise<AgentStatus> {
    return this.#bridgeCall<AgentStatus>(`/send?id=${safeId(id)}`, { body: { lines } });
  }

  /**
   * The lines a job's agent printed after `after`, waiting up to `wait_ms`
   * for one. Never starts the container: when it's asleep or the agent is
   * gone, says so. `gate` keeps the job's key on the gate (a sign-in's token
   * that was renewed, and the entry's lease); each read is also the
   * Durable Object's activity that keeps the container up while the job works.
   */
  async jobRead(id: string, after: number, wait_ms: number, gate?: JobGate): Promise<JobRead> {
    safeId(id);
    if (!this.ctx.container?.running) return { ok: false, gone: true, why: "The workspace is asleep, so the agent isn't running." };
    if (gate) {
      const had = (await this.ctx.storage.get<Record<string, JobGate & { until?: number }>>("job_gates"))?.[id];
      const changed = JSON.stringify({ allow: had?.allow, rules: had?.rules }) !== JSON.stringify({ allow: gate.allow, rules: gate.rules });
      if (changed || !had?.until || had.until - Date.now() < JOB_GATE_MS / 2) await this.#setJobGate(id, gate);
      // After a deploy, the gate's handler is still the old version's until it's set again.
      if (changed || !this.#gated) await this.#gate();
    }
    try {
      const r = await this.#bridgeCall<{ lines: Array<{ seq: number; text: string }> } & AgentStatus>(
        `/read?id=${id}&after=${after}&wait=${Math.max(0, Math.min(25_000, wait_ms))}`,
      );
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, gone: true, why: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Stops a job's agent and everything it started, and takes its key off the gate. Its folder stays until the job is dropped. */
  async jobStop(id: string): Promise<void> {
    safeId(id);
    await this.#setJobGate(id, null);
    if (!this.ctx.container?.running) return;
    await this.#gate().catch(() => {});
    await this.#bridgeCall(`/stop?id=${id}`, { body: {} }).catch(() => {});
    // Anything of the job's user still running (a server it left behind, a process that left its group) goes too,
    // so nothing of the agent's runs beside Atlas's next command.
    const name = userOf(id);
    await this.#exec(
      `uid=$(id -u ${name} 2>/dev/null) || exit 0; for i in 1 2 3 4 5; do left=""; for p in /proc/[0-9]*; do [ "$(stat -c %u "$p" 2>/dev/null)" = "$uid" ] && { kill -9 "\${p#/proc/}" 2>/dev/null; left=1; }; done; [ -z "$left" ] && break; sleep 0.3; done; true`,
    ).catch(() => {});
  }

  /**
   * Keeps a job where a new container can find it: its commits since `base`
   * and the work not yet committed (as a commit of its own, `refs/atlas/wip`)
   * in a git bundle, and its agent's home as a tarball, both in R2.
   */
  async jobSave(id: string, o: { base: string }): Promise<{ ok: boolean; note: string }> {
    safeId(id);
    if (!/^[0-9a-f]{7,64}$/.test(o.base)) throw new Error(`"${o.base}" isn't a commit.`);
    if (!this.ctx.container?.running) return { ok: false, note: "The workspace is asleep; nothing new to keep." };
    const dir = jobDir(id);
    const file = `${dir}/keep.bundle`;
    const bundle = await this.#exec(
      [
        `cd ${sh(`${dir}/repo`)}`,
        // Everything in the folder, as git sees it (ignored files stay out), as a commit beside the branch.
        `export GIT_INDEX_FILE=${dir}/keep.index`,
        `rm -f "$GIT_INDEX_FILE" && git read-tree HEAD && git -c core.hooksPath=/dev/null add -A >/dev/null 2>&1`,
        `tree=$(git write-tree) && wip=$(git -c user.name=Atlas -c user.email=atlas@localhost commit-tree "$tree" -p HEAD -m "Work in progress, kept by Atlas") && git update-ref refs/atlas/wip "$wip"`,
        `rm -f "$GIT_INDEX_FILE" && unset GIT_INDEX_FILE`,
        `(git bundle create ${file} --branches refs/atlas/wip ^${o.base} >/dev/null 2>&1 || git bundle create ${file} --branches refs/atlas/wip >/dev/null 2>&1)`,
        `s=$(stat -c %s ${file}) && if [ "$s" -gt ${SAVE_LIMIT} ]; then rm -f ${file}; echo "The job's work is $((s / 1000000)) MB, over the ${SAVE_LIMIT / 1_000_000} MB that's kept; ignore big generated files in .gitignore." >&2; exit 3; fi`,
        `cat ${file}; rm -f ${file}`,
      ].join(" && "),
      { timeoutS: 120, stderr: "pipe", as: id },
    );
    if (bundle.exit !== 0) return { ok: false, note: `Couldn't keep the job's repo: ${bundle.err.slice(-300) || `exit ${bundle.exit}`}` };
    await this.env.FILES.put(JOB_SAVE(this.#name, id, "repo.bundle"), bundle.bytes);
    const size = Number((await this.#exec(`du -sb ${sh(`${dir}/home`)} 2>/dev/null | cut -f1`, { as: id })).out.trim()) || 0;
    if (size > HOME_LIMIT)
      return {
        ok: true,
        note: `The agent's home is ${Math.round(size / 1e6)} MB, too big to keep; a new container starts its session over.`,
      };
    // The agent may be writing its session as this reads it: a file that changed meanwhile is still kept (tar's exit 1).
    const home = await this.#exec(`mkdir -p ${sh(`${dir}/home`)} && tar czf - --warning=no-file-changed -C ${sh(dir)} home; [ $? -le 1 ]`, {
      timeoutS: 60,
      stderr: "pipe",
      as: id,
    });
    if (home.exit !== 0)
      return { ok: true, note: `The agent's home wasn't kept this time: ${home.err.slice(-200) || `exit ${home.exit}`}` };
    await this.env.FILES.put(JOB_SAVE(this.#name, id, "home.tgz"), home.bytes);
    return { ok: true, note: "" };
  }

  /**
   * Puts a job back after its container was lost: into a repo already
   * cloned at the job's base, its saved commits, its branch checked out
   * with the work in progress on top (files the agent deleted stay
   * deleted), and its agent's home. Says whether there was anything to put back.
   */
  async jobRestore(id: string, o: { branch: string }): Promise<{ restored: boolean; note: string }> {
    safeId(id);
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(o.branch)) throw new Error(`"${o.branch}" isn't a branch name.`);
    await this.#up(async () => {});
    const dir = jobDir(id);
    const bundle = await this.env.FILES.get(JOB_SAVE(this.#name, id, "repo.bundle"));
    if (!bundle) return { restored: false, note: "Nothing of this job was kept yet." };
    // Its folder is the job's user's; what was kept is put back as that user, never as root.
    const user = await this.#jobUser(id);
    const own = await this.#exec(
      `mkdir -p ${sh(`${dir}/home`)} && chown -h ${user.uid}:${user.gid} ${sh(dir)} ${sh(`${dir}/home`)} && chmod 700 ${sh(dir)}`,
    );
    if (own.exit !== 0) throw new Error(`The workspace couldn't give the job its folder: ${own.out.slice(-300)}`);
    const put = await this.#exec(
      [
        `cd ${sh(`${dir}/repo`)}`,
        `cat > ${sh(`${dir}/keep.bundle`)}`,
        `git fetch -q --update-head-ok ${sh(`${dir}/keep.bundle`)} '+refs/heads/*:refs/heads/*' '+refs/atlas/wip:refs/atlas/wip'`,
        `git checkout -q -f -B ${sh(o.branch)} refs/heads/${sh(o.branch)}`,
        `git read-tree -u --reset refs/atlas/wip && git reset -q`,
        `rm -f ${sh(`${dir}/keep.bundle`)}`,
      ].join(" && "),
      { stdin: bundle.body, timeoutS: 120, as: id },
    );
    if (put.exit !== 0) throw new Error(`Couldn't put the job's work back: ${put.out.slice(-400)}`);
    const home = await this.env.FILES.get(JOB_SAVE(this.#name, id, "home.tgz"));
    if (home) {
      const h = await this.#exec(`tar xzf - -C ${sh(dir)}`, { stdin: home.body, as: id });
      if (h.exit !== 0)
        return { restored: true, note: `The agent's home didn't come back (${h.out.slice(-200)}), so its session starts over.` };
    }
    return { restored: true, note: home ? "" : "The agent's home wasn't kept, so its session starts over." };
  }

  /**
   * Pushes a job's commit to its code host, from a copy of root's own: the
   * commit's objects copied out of the job's repo as data (no command of the
   * repo's, no config, no alternates), into a fresh repo only root can
   * reach, pushed to the code host's address with git's key behind a nonce
   * that's in git's environment, not on any command line. The job's agent is
   * stopped first.
   */
  async jobPush(o: {
    id: string;
    sha: string;
    url: string;
    branch: string;
    env: Record<string, string>;
    rules: KeyRule[];
  }): Promise<{ exit: number; out: string }> {
    const id = safeId(o.id);
    if (!/^[0-9a-f]{40}$/.test(o.sha)) throw new Error(`"${o.sha}" isn't a commit.`);
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(o.branch)) throw new Error(`"${o.branch}" isn't a branch name.`);
    if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(o.url)) throw new Error(`"${o.url}" isn't a git address Atlas pushes to.`);
    await this.jobStop(id);
    const d = `${PUSH}/${id}-${crypto.randomUUID().slice(0, 8)}`;
    const git = jobDir(id) + "/repo/.git";
    const key = `push:${d}`;
    this.#extra.set(key, carrying(o.rules));
    try {
      await this.#gate();
      const p = await this.#c.exec(
        [
          "bash",
          "-lc",
          [
            `set -e; mkdir -p -m 700 ${PUSH}; git init -q --bare ${sh(d)}`,
            `cp -r --no-dereference ${sh(`${git}/objects/.`)} ${sh(`${d}/objects/`)}`,
            `rm -rf ${sh(`${d}/objects/info`)}; find ${sh(`${d}/objects`)} -type l -delete`,
            `if [ -f ${sh(`${git}/shallow`)} ]; then grep -E '^[0-9a-f]{40}$' ${sh(`${git}/shallow`)} > ${sh(`${d}/shallow`)} || true; fi`,
            `git --git-dir=${sh(d)} update-ref refs/atlas/publish ${o.sha}`,
            `git --git-dir=${sh(d)} -c core.hooksPath=/dev/null push -q --force ${sh(o.url)} ${sh(`refs/atlas/publish:refs/heads/${o.branch}`)} 2>&1; s=$?; rm -rf ${sh(d)}; exit $s`,
          ].join("\n"),
        ],
        { env: { ...ENV, ...o.env }, cwd: "/", stderr: "combined" },
      );
      const r = await p.output();
      return { exit: r.exitCode, out: new TextDecoder().decode(r.stdout).slice(-2_000) };
    } finally {
      this.#extra.delete(key);
      await this.#gate().catch(() => {});
    }
  }

  /**
   * Gets a job's repo: fetched by root in a staging folder only root can
   * reach (git's key behind its nonce, in git's environment), given to the
   * job's user there, then moved into the job's folder in place of whatever
   * was there. Nothing of the job's user runs meanwhile. Says the commit it's at.
   */
  async jobClone(o: {
    id: string;
    url: string;
    /** A branch or a commit. */
    what: string;
    branch: string;
    name: string;
    email: string;
    env: Record<string, string>;
    rules: KeyRule[];
  }): Promise<{ exit: number; out: string }> {
    const id = safeId(o.id);
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(o.branch) || !/^[A-Za-z0-9._/-]{1,120}$/.test(o.what))
      throw new Error("That isn't a branch or commit.");
    if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(o.url)) throw new Error(`"${o.url}" isn't a git address Atlas clones from.`);
    await this.#up(async () => {});
    await this.jobStop(id);
    const user = await this.#jobUser(id);
    const dir = jobDir(id);
    const stage = `${PUSH}/clone-${id}-${crypto.randomUUID().slice(0, 8)}`;
    const key = `clone:${stage}`;
    this.#extra.set(key, carrying(o.rules));
    try {
      await this.#gate();
      const p = await this.#c.exec(
        [
          "bash",
          "-lc",
          [
            `set -e; mkdir -p -m 700 ${PUSH}; mkdir -m 700 ${sh(stage)}; cd ${sh(stage)}`,
            `git init -q repo; cd repo; git remote add origin ${sh(o.url)}`,
            `timeout -k 5 600 git -c core.hooksPath=/dev/null fetch -q --depth 50 origin ${sh(o.what)} 2>&1`,
            `git checkout -q -b ${sh(o.branch)} FETCH_HEAD`,
            `git config user.name ${sh(o.name)}; git config user.email ${sh(o.email)}`,
            `git rev-parse HEAD; cd ${sh(stage)}`,
            `chown -R -h ${user.uid}:${user.gid} repo`,
            `mkdir -p ${sh(dir)}; chown -h ${user.uid}:${user.gid} ${sh(dir)}; chmod 700 ${sh(dir)}`,
            `rm -rf ${sh(`${dir}/repo`)}; mv repo ${sh(`${dir}/repo`)}; cd /; rm -rf ${sh(stage)}`,
          ].join("\n"),
        ],
        { env: { ...ENV, ...o.env }, cwd: "/", stderr: "combined" },
      );
      const r = await p.output();
      if (r.exitCode !== 0) await this.#exec(`rm -rf ${sh(stage)}`).catch(() => {});
      return { exit: r.exitCode, out: new TextDecoder().decode(r.stdout).slice(-2_000) };
    } finally {
      this.#extra.delete(key);
      await this.#gate().catch(() => {});
    }
  }

  /** Whether the job's folder is in the running container, so it doesn't need putting back. */
  async jobHere(id: string): Promise<boolean> {
    safeId(id);
    if (!this.ctx.container?.running) return false;
    return (await this.#exec(`test -d ${sh(`${jobDir(id)}/repo/.git`)}`)).exit === 0;
  }

  /** Forgets a job: its agent, its folder and what was kept of it. */
  async jobDrop(id: string): Promise<void> {
    safeId(id);
    await this.jobStop(id);
    if (this.ctx.container?.running) await this.#exec(`rm -rf ${sh(jobDir(id))}`);
    await this.env.FILES.delete([JOB_SAVE(this.#name, id, "repo.bundle"), JOB_SAVE(this.#name, id, "home.tgz")]);
  }

  async #setJobGate(id: string, gate: JobGate | null): Promise<void> {
    const all = (await this.ctx.storage.get<Record<string, JobGate & { until?: number }>>("job_gates")) ?? {};
    if (gate) all[id] = { ...gate, until: Date.now() + JOB_GATE_MS };
    else delete all[id];
    await this.ctx.storage.put("job_gates", all);
  }

  /** The gate for what the owner does in the terminal: the same sites and keys as Atlas's commands. */
  async setGate(gate: { allow: string[]; inject: Record<string, string> }): Promise<void> {
    await this.#setBase(gate);
  }

  /** The owner's sites and vault keys, as Atlas's last command had them: kept, since a deploy forgets what's in memory. */
  async #setBase(gate: { allow: string[]; inject: Record<string, string> }): Promise<void> {
    if (JSON.stringify(gate) === JSON.stringify(this.#base)) return;
    this.#base = gate;
    await this.ctx.storage.put("base_gate", gate);
  }

  #base: { allow: string[]; inject: Record<string, string> } | null = null;
  /** What running commands add to the gate while they run (an install's npm, a git step's key), by command. */
  #extra = new Map<string, { allow: string[]; rules: KeyRule[] }>();
  /** The gate was set by this instance (a deploy leaves the old version's handler until it's set again). */
  #gated = false;
  /** The owner's vault keys are off the gate while a job runs. */
  #keysOff = false;

  /** A job's entry on the gate ran out: the gate is set again without it. */
  override async alarm(): Promise<void> {
    if (this.ctx.container?.running) await this.#gate().catch(() => {});
  }

  /** A link to a server listening on `port` in the workspace, for a day. */
  async preview(port: number): Promise<{ token: string; expires: number }> {
    if (port === BRIDGE_PORT) throw new Error("That port is Atlas's own, not something to preview.");
    const token = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const expires = Date.now() + PREVIEW_MS;
    const all = ((await this.ctx.storage.get<Record<string, Preview>>("previews")) ?? {}) as Record<string, Preview>;
    for (const [t, p] of Object.entries(all)) if (p.expires < Date.now()) delete all[t];
    all[token] = { port, expires };
    await this.ctx.storage.put("previews", all);
    return { token, expires };
  }

  /**
   * The terminal (a WebSocket at /terminal, the owner's, through the Worker)
   * and previews (/preview/<token>/…). The terminal is tmux in a PTY, so
   * reopening it finds the same shell. Keystrokes arrive as binary
   * messages, a resize as JSON text: { cols, rows }.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pv = /^\/preview\/([0-9a-f]{36})(\/.*)?$/.exec(url.pathname);
    if (pv) return this.#preview(request, pv[1]!, pv[2] ?? "/");
    if (url.pathname !== "/terminal" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("Not found", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const say = (text: string) => server.send(new TextEncoder().encode(`\r\n\x1b[2m${text}\x1b[0m\r\n`));
    say("Connecting to the workspace…");
    void (async () => {
      try {
        await this.#up(async (note) => say(note));
        await this.#gate();
        const cols = Number(url.searchParams.get("cols")) || 100;
        const rows = Number(url.searchParams.get("rows")) || 30;
        const p = await this.#c.exec(["tmux", "new-session", "-A", "-s", "main"], {
          env: { ...ENV, TERM: "xterm-256color" },
          cwd: "/workspace",
          pty: { cols, rows },
        });
        const stdin = p.stdin!.getWriter();
        // Keystrokes go in in order, one write after another.
        let writes: Promise<void> = Promise.resolve();
        server.addEventListener("message", (e) => {
          if (typeof e.data === "string") {
            try {
              const m = JSON.parse(e.data) as { cols?: number; rows?: number };
              if (m.cols && m.rows) p.resize(Math.min(500, m.cols), Math.min(200, m.rows));
            } catch {
              // Not a resize: ignore.
            }
            return;
          }
          // Binary messages can arrive as an ArrayBuffer, a view or a Blob, depending on the runtime.
          const d = e.data as ArrayBuffer | ArrayBufferView | Blob;
          const bytes =
            d instanceof Blob
              ? d.arrayBuffer().then((b) => new Uint8Array(b))
              : Promise.resolve(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
          writes = writes.then(() => bytes.then((b) => stdin.write(b))).catch(() => {});
        });
        // Closing the page detaches from tmux; the shell keeps running until the workspace sleeps.
        server.addEventListener("close", () => {
          void stdin.close().catch(() => {});
        });
        const reader = p.stdout!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          server.send(value);
        }
        server.close(1000, "The shell ended.");
      } catch (err) {
        say(`The terminal couldn't start: ${err instanceof Error ? err.message : String(err)}`);
        server.close(1011, "Couldn't start.");
      }
    })();
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A preview: the request goes to the port its token names, with the
   * token's prefix taken off. It's served sandboxed (its own origin), so a
   * page built in the workspace can't reach Atlas with the owner's sign-in.
   */
  async #preview(request: Request, token: string, path: string): Promise<Response> {
    const all = (await this.ctx.storage.get<Record<string, Preview>>("previews")) ?? {};
    const p = all[token];
    if (!p || p.expires < Date.now()) return new Response("This preview link has run out. Ask Atlas for a new one.", { status: 404 });
    if (!this.ctx.container?.running)
      return new Response("The workspace is asleep, so the server behind this preview isn't running. Ask Atlas to start it again.", {
        status: 503,
      });
    const url = new URL(request.url);
    const target = new URL(`http://localhost:${p.port}${path}${url.search}`);
    let res: Response;
    try {
      res = await this.#c.getTcpPort(p.port).fetch(new Request(target, request));
    } catch (err) {
      return new Response(`Nothing is answering on port ${p.port} in the workspace: ${err instanceof Error ? err.message : String(err)}`, {
        status: 502,
      });
    }
    const headers = new Headers(res.headers);
    headers.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
    headers.set("x-robots-tag", "noindex");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  /** A file's bytes, from /workspace. */
  async read(path: string): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; error: string }> {
    try {
      await this.#up(async () => {});
      const r = await this.#exec(`cat -- ${sh(path)}`);
      return r.exit === 0
        ? { ok: true, bytes: r.bytes }
        : { ok: false, error: new TextDecoder().decode(r.bytes).slice(-300) || `Couldn't read ${path}.` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** What's in /workspace, three levels deep, at most 300 entries. Only while the container is up: listing doesn't start it. */
  async list(): Promise<Array<{ path: string; size: number; dir: boolean }> | null> {
    if (!this.ctx.container?.running) return null;
    const r = await this.#exec("cd /workspace && find . -maxdepth 3 -not -path '*/.*' -printf '%y %s %P\\n' | head -300");
    if (r.exit !== 0) return [];
    return r.out
      .split("\n")
      .filter((l) => l.trim() && !l.endsWith(" "))
      .map((l) => {
        const [y, size, ...p] = l.split(" ");
        return { path: p.join(" "), size: Number(size), dir: y === "d" };
      })
      .filter((e) => e.path);
  }
}
