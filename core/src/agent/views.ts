// What the app's places read (§21.2): Library's records, History's log,
// Inbox's waiting items. Each is a read of the one log or the records, shaped
// for its page; nothing here changes anything except marking Inbox items done.

import { codingJobs } from "./coding";
import { ownedJobs } from "./jobs";
import { getPage, pageVersion, pageVersions, segments } from "../pages";
import type { ApprovalView, HistoryFilter, HistoryStats, InboxItem, RecordView } from "../protocol";
import { FIELDS, findEntry } from "../vault";
import { type Action, actionsOf, ASKS, kindOf, needsHold, TRUST_AFTER, trustTable, waitingApprovals } from "../approvals";
import type { AgendaItem } from "../store/agenda";
import { scrub } from "../outbox";
import { readSettings, secretValues } from "../store/settings";
import { here, pinOf } from "../location";
import { mapsCredit } from "../providers";
import { situationPage, weatherPage } from "../situation";
import { sensesPage } from "../intake";
import { webhooks, webhookView } from "../webhooks";
import type { AreaPage, AutomationView, PersonPage, PlacePage, StageMessage, StagePage, StageView } from "../stage";
import { type Automation, getAutomation, needsTest, stepText, whenText } from "../automations";
import { getArea } from "../store/areas";
import { parse, type Sql } from "../store/db";
import { get as getRow, type LogKind, type LogRow } from "../store/log";
import { indexNewMessages, keywordSearch } from "../store/memory";
import { type AtlasRecord, getRecord, linked, RECORD_TYPES, type RecordType, recordHistory } from "../store/records";
import { getState, setState } from "../store/state";
import { channelsOf, lastTouch, trustOf } from "../contacts";
import { photoUrl } from "../photos";
import { personInfo } from "../tools/people";
import { openTasks } from "../tasks";
import { openLoops } from "../loops";
import { zoneOf } from "../time";

// --- Library -----------------------------------------------------------------------------

export function recordView(sql: Sql, r: AtlasRecord): RecordView {
  const { fact, is_owner: _o, channels: _c, trust: _t, ...details } = r.fields;
  const from = r.source.log_id ? getRow(sql, r.source.log_id) : null;
  const history = recordHistory(sql, r.id);
  const last = history[history.length - 1];
  const photo = r.type === "person" ? photoUrl(sql, r.id) : undefined;
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    fact: typeof fact === "string" ? fact : "",
    details: details as Record<string, unknown>,
    areas: r.areas,
    learned_at: r.learned_at,
    // Written down by Atlas from something said or done (a run, a message, setup), not brought in by an import or seen on mail.
    learned: Boolean(r.source.run_id || r.source.log_id || r.source.via === "setup"),
    updated_at: r.updated_at,
    confidence: r.confidence,
    source: from
      ? { via: r.source.via, text: String(from.body.text ?? "").slice(0, 200), at: from.at, surface: from.surface }
      : { via: r.source.via },
    corrections: history.length,
    was: last ? { name: last.name ?? r.name, fact: typeof last.fields.fact === "string" ? last.fields.fact : "", at: last.at } : null,
    shared: r.visibility === "shared",
    ...(r.type === "person"
      ? {
          channels: channelsOf(r).map((c) => ({ kind: c.kind, value: c.value, via: c.via })),
          trust: trustOf(r),
          ...(photo ? { photo } : {}),
        }
      : {}),
  };
}

/** A row is tagged with an area: its `areas` JSON array holds the id. */
export const TAGGED = `EXISTS (SELECT 1 FROM json_each(areas) WHERE value = ?)`;

export function listRecords(
  sql: Sql,
  q: { type?: RecordType | "all"; area?: string | null; text?: string; limit?: number; learned?: boolean },
): { records: RecordView[]; counts: Record<string, number> } {
  const where = [`state = 'active'`, `NOT (type = 'person' AND coalesce(json_extract(fields, '$.is_owner'), 0) = 1)`];
  const args: unknown[] = [];
  if (q.type && q.type !== "all") {
    where.push(`type = ?`);
    args.push(q.type);
  }
  if (q.area) {
    where.push(`${TAGGED}`);
    args.push(q.area);
  }
  if (q.text?.trim()) {
    where.push(`(instr(lower(name), lower(?)) > 0 OR instr(lower(fields), lower(?)) > 0)`);
    args.push(q.text.trim(), q.text.trim());
  }
  // Learned, as recordView says: from a run, a message or setup, newest first.
  if (q.learned)
    where.push(
      `(json_extract(source, '$.run_id') IS NOT NULL OR json_extract(source, '$.log_id') IS NOT NULL OR json_extract(source, '$.via') = 'setup')`,
    );
  const rows = sql
    .exec<{ id: string }>(
      `SELECT id FROM records WHERE ${where.join(" AND ")} ORDER BY ${q.learned ? "learned_at" : "updated_at"} DESC LIMIT ?`,
      ...args,
      q.limit ?? 100,
    )
    .toArray();
  const counts: Record<string, number> = { all: 0 };
  for (const t of RECORD_TYPES) counts[t] = 0;
  const areaWhere = q.area ? ` AND ${TAGGED}` : "";
  for (const c of sql
    .exec<{ type: string; n: number }>(
      `SELECT type, count(*) AS n FROM records WHERE state = 'active' AND NOT (type = 'person' AND coalesce(json_extract(fields, '$.is_owner'), 0) = 1)${areaWhere} GROUP BY type`,
      ...(q.area ? [q.area] : []),
    )
    .toArray()) {
    counts[c.type] = c.n;
    counts.all! += c.n;
  }
  return { records: rows.map((r) => recordView(sql, getRecord(sql, r.id)!)), counts };
}

// --- the stage's area and person pages (§21.6) -------------------------------------------

/** What a view on the stage needs from the agent: an area's or a person's page, built live. Lists and tables carry their own. */
export function stagePage(sql: Sql, view: StageView): StagePage | null {
  if (view.kind === "area") return areaPage(sql, view.area);
  if (view.kind === "person") return personPage(sql, view.person);
  if (view.kind === "automation") {
    const a = getAutomation(sql, view.automation);
    return a ? { kind: "automation", automation: automationView(sql, a) } : { kind: "missing", why: "That automation was deleted." };
  }
  if (view.kind === "page") return pagePage(sql, view.page, view.version);
  if (view.kind === "situation") return situationPage(sql, readSettings(sql));
  if (view.kind === "senses") return sensesPage(sql, readSettings(sql));
  if (view.kind === "weather") return weatherPage(sql, readSettings(sql));
  if (view.kind === "place") return placePage(sql, view.place);
  return null;
}

/** A saved place's page: what Atlas knows, its pin, and the owner's visits from the log. */
export function placePage(sql: Sql, id: string): PlacePage | { kind: "missing"; why: string } {
  const r = getRecord(sql, id);
  if (!r || r.state !== "active") return { kind: "missing", why: "That place isn't saved any more." };
  const pin = pinOf(r);
  const rows = sql
    .exec<{ at: number; body: string }>(
      `SELECT at, body FROM log WHERE kind = 'sense' AND json_extract(body, '$.place.id') = ? AND json_extract(body, '$.event') IN ('arrived', 'left') ORDER BY seq DESC LIMIT 200`,
      r.id,
    )
    .toArray()
    .map((x) => ({ at: x.at, body: parse<{ event?: string; stayed_ms?: number }>(x.body, {}) }));
  const visits: PlacePage["visits"] = [];
  // Newest first: a departure is paired with the arrival before it.
  let stayed: number | null = null;
  for (const x of rows) {
    if (x.body.event === "left") stayed = x.body.stayed_ms ?? null;
    else {
      visits.push({ at: x.at, stayed_ms: stayed });
      stayed = null;
    }
  }
  return {
    kind: "place",
    place: recordView(sql, r),
    pin: pin ? { lat: pin.lat, lon: pin.lon, radius_m: pin.radius_m } : null,
    visits: visits.slice(0, 50),
    here: here(sql).place?.id === r.id,
    credit: mapsCredit(sql, readSettings(sql).maps.provider),
  };
}

/** A page at one version, with its parts and every version's line (§21.7). */
export function pagePage(sql: Sql, id: string, n?: number): StagePage {
  const p = getPage(sql, id);
  if (!p) return { kind: "missing", why: "That page was deleted." };
  const v = pageVersion(sql, p.id, n) ?? pageVersion(sql, p.id);
  if (!v) return { kind: "missing", why: "That page has no versions." };
  return {
    kind: "page",
    page: {
      id: p.id,
      name: p.name,
      made_by: p.made_by,
      created_at: p.created_at,
      version: p.version,
      shown: { n: v.n, at: v.at, by: v.by, note: v.note },
      segments: segments(v.body),
      versions: pageVersions(sql, p.id),
    },
  };
}

/** An automation as the app shows it: its parts in words, when it runs next, and its last runs. */
export function automationView(sql: Sql, a: Automation): AutomationView {
  const next = sql
    .exec<{ due_at: number }>(
      `SELECT due_at FROM agenda WHERE kind = 'automation' AND state IN ('scheduled', 'running') AND json_extract(source, '$.detail.automation') = ? LIMIT 1`,
      a.id,
    )
    .toArray()[0];
  const runs = sql
    .exec<{ id: string }>(
      `SELECT id FROM log WHERE kind = 'automation.run' AND json_extract(body, '$.automation_id') = ? ORDER BY seq DESC LIMIT 12`,
      a.id,
    )
    .toArray()
    .map((r) => getRow(sql, r.id)!)
    .map((r) => {
      const b = r.body as Record<string, unknown>;
      const usage = (b.usage ?? {}) as { input?: number; output?: number };
      return {
        id: r.id,
        at: r.at,
        why: String(b.why ?? ""),
        test: b.test === true,
        ok: b.ok !== false,
        quiet: b.quiet === true,
        text: String(b.text ?? ""),
        error: typeof b.error === "string" ? b.error : null,
        ms: typeof b.ms === "number" ? b.ms : null,
        brain: typeof b.brain === "string" ? b.brain : null,
        tokens: (usage.input ?? 0) + (usage.output ?? 0),
        results: (Array.isArray(b.results) ? b.results : []) as AutomationView["runs"][number]["results"],
      };
    });
  return {
    id: a.id,
    name: a.name,
    about: a.about,
    state: a.state,
    made_by: a.made_by,
    when: a.when,
    when_text: whenText(a.when, (id) => getAutomation(sql, id)?.name ?? null),
    steps: a.do.map((step) => ({ step, text: stepText(step) })),
    report: a.report,
    to: a.to,
    can_turn_on: !needsTest(a),
    tested_at: a.tested_at,
    fails: a.fails,
    paused_why: a.paused_why,
    next_at: next?.due_at ?? null,
    runs,
  };
}

const PAGE_GROUP = 30;

export function areaPage(sql: Sql, id: string): StagePage {
  const a = getArea(sql, id);
  if (!a) return { kind: "missing", why: "That area isn't there any more." };
  if (a.state === "archived") {
    const into = mergedInto(sql, a.id);
    if (into) return { kind: "missing", why: `${a.name} was merged into ${into}.` };
  }
  const records = sql
    .exec<{ id: string }>(
      `SELECT id FROM records WHERE state = 'active' AND ${TAGGED} AND NOT (type = 'person' AND coalesce(json_extract(fields, '$.is_owner'), 0) = 1) ORDER BY updated_at DESC LIMIT 400`,
      a.id,
    )
    .toArray()
    .map((r) => recordView(sql, getRecord(sql, r.id)!));
  const of = (types: string[]) => records.filter((r) => types.includes(r.type)).slice(0, PAGE_GROUP);
  const recent = sql
    .exec<{ id: string }>(`SELECT id FROM log WHERE kind IN ('message.in', 'message.out') AND ${TAGGED} ORDER BY seq DESC LIMIT 8`, a.id)
    .toArray()
    .map((r) => stageMessage(getRow(sql, r.id)!));
  const messages = sql
    .exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE kind IN ('message.in', 'message.out') AND ${TAGGED}`, a.id)
    .one().n;
  const page: AreaPage = {
    kind: "area",
    area: { id: a.id, name: a.name, about: a.about, state: a.state, color: a.color, tone: a.settings.tone },
    people: of(["person"]),
    plans: of(["goal", "task", "commitment", "event"]),
    places: of(["place", "organization"]),
    notes: of(["note", "preference", "document"]),
    recent,
    counts: { messages, records: records.length },
  };
  return page;
}

function mergedInto(sql: Sql, id: string): string | null {
  const r = sql
    .exec<{ target: string | null }>(
      `SELECT json_extract(body, '$.merged_into') AS target FROM log WHERE kind = 'area.change' AND json_extract(body, '$.area_id') = ? AND json_extract(body, '$.merged_into') IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      id,
    )
    .toArray()[0];
  return r?.target ? (getArea(sql, r.target)?.name ?? null) : null;
}

export function personPage(sql: Sql, id: string): StagePage {
  const r = getRecord(sql, id);
  if (!r || r.type !== "person") return { kind: "missing", why: "Atlas doesn't have that person any more." };
  if (r.state !== "active") return { kind: "missing", why: `You asked Atlas to forget ${r.name}.` };
  // The last few messages may not be in the index yet.
  while (indexNewMessages(sql) > 0);
  const mentions = keywordSearch(sql, r.name, { kinds: ["message"] }, 30)
    .map((h) => getRow(sql, h.ref.slice(4)))
    .filter((row): row is LogRow => row != null && (row.kind === "message.in" || row.kind === "message.out"))
    .sort((x, y) => y.seq - x.seq)
    .slice(0, 6)
    .map(stageMessage);
  const info = personInfo(sql, r, zoneOf(readSettings(sql)));
  const page: PersonPage = {
    kind: "person",
    person: recordView(sql, r),
    open: [
      ...openTasks(sql)
        .filter((t) => info.open.some((o) => o.id === t.id))
        .map((t) => ({ kind: "task" as const, title: t.name, by: typeof t.fields.by === "number" ? t.fields.by : null })),
      ...openLoops(sql)
        .filter((l) => info.open.some((o) => o.id === l.id))
        .map((l) => ({ kind: "loop" as const, title: l.title, by: l.due_at })),
    ],
    last: lastTouch(sql, r),
    links: linked(sql, r.id).map((l) => ({ kind: l.kind, record: recordView(sql, l.record) })),
    mentions,
    history: recordHistory(sql, r.id).map((h) => ({
      at: h.at,
      name: h.name,
      fact: typeof h.fields.fact === "string" ? h.fields.fact : "",
      reason: h.reason,
    })),
  };
  return page;
}

function stageMessage(row: LogRow): StageMessage {
  return {
    id: row.id,
    at: row.at,
    by: row.kind === "message.in" ? "owner" : "atlas",
    surface: row.surface,
    text: String(row.body.text ?? "").slice(0, 400),
  };
}

// --- History -----------------------------------------------------------------------------

const KINDS: Record<HistoryFilter, LogKind[]> = {
  everything: [
    "message.in",
    "tool.result",
    "record.change",
    "agenda.change",
    "area.change",
    "job.result",
    "run.end",
    "brain.fallback",
    "context.summary",
    "settings.change",
    "calendar.change",
    "delivery",
    "automation.run",
    "automation.change",
    "page.change",
    "file.change",
    "skill.change",
    "sense",
    "awareness",
  ],
  actions: [
    "tool.result",
    "calendar.change",
    "record.change",
    "agenda.change",
    "area.change",
    "delivery",
    "automation.change",
    "page.change",
    "file.change",
    "skill.change",
  ],
  conversations: ["message.in", "message.out"],
  jobs: ["job.result", "agenda.change", "automation.run"],
  faces: ["face.in", "face.out", "face.handoff", "face.digest"],
};

/** Whether a row belongs on History's list for a filter: the things that happened, not the plumbing. */
function shown(row: LogRow, filter: HistoryFilter): boolean {
  if (row.kind === "tool.result") return row.body.receipt != null;
  if (row.kind === "run.end") return row.body.state === "failed";
  if (filter === "jobs" && row.kind === "agenda.change") return row.body.kind === "job";
  // A notification held for quiet hours is told by its delivery receipt, and an automation's next run by its run, not as agenda changes.
  if (row.kind === "agenda.change" && (row.body.kind === "notify" || row.body.kind === "automation")) return false;
  return true;
}

export function history(
  sql: Sql,
  q: { filter: HistoryFilter; before_seq?: number; area?: string | null; limit?: number },
): { rows: LogRow[]; has_more: boolean } {
  const kinds = KINDS[q.filter];
  const limit = q.limit ?? 60;
  const out: LogRow[] = [];
  let before = q.before_seq ?? Number.MAX_SAFE_INTEGER;
  let more = true;
  for (let page = 0; page < 10 && out.length < limit && more; page++) {
    const ids = sql
      .exec<{ id: string; seq: number }>(
        `SELECT id, seq FROM log WHERE kind IN (${kinds.map(() => "?").join(", ")}) AND seq < ?${q.area ? ` AND ${TAGGED}` : ""} ORDER BY seq DESC LIMIT ?`,
        ...kinds,
        before,
        ...(q.area ? [q.area] : []),
        limit * 2,
      )
      .toArray();
    more = ids.length === limit * 2;
    for (const { id, seq } of ids) {
      before = seq;
      const row = getRow(sql, id)!;
      if (shown(row, q.filter)) out.push(row);
      if (out.length >= limit) break;
    }
  }
  return { rows: out, has_more: more || out.length >= limit };
}

/** Today's totals for History's strip, counted from local midnight. */
export function historyStats(sql: Sql, dayStart: number): HistoryStats {
  const count = (where: string, ...args: unknown[]) =>
    sql.exec<{ n: number }>(`SELECT count(*) AS n FROM log WHERE at >= ? AND ${where}`, dayStart, ...args).one().n;
  const per_hour = new Array<number>(24).fill(0);
  for (const r of sql
    .exec<{ h: number; n: number }>(
      `SELECT CAST((at - ?) / 3600000 AS INTEGER) AS h, count(*) AS n FROM log WHERE at >= ? AND kind IN ('message.in', 'tool.result', 'record.change', 'agenda.change') GROUP BY h`,
      dayStart,
      dayStart,
    )
    .toArray()) {
    if (r.h >= 0 && r.h < 24) per_hour[r.h] = r.n;
  }
  return {
    actions:
      count(`kind = 'tool.result' AND json_extract(body, '$.receipt') IS NOT NULL`) +
      count(`kind IN ('record.change', 'agenda.change') AND actor != 'system'`),
    conversations: count(`kind = 'message.in'`),
    jobs: count(`kind = 'job.result'`),
    tokens:
      sql
        .exec<{ n: number | null }>(
          `SELECT sum(coalesce(json_extract(body, '$.usage.input'), 0) + coalesce(json_extract(body, '$.usage.output'), 0)) AS n FROM log WHERE at >= ? AND kind = 'message.out'`,
          dayStart,
        )
        .one().n ?? 0,
    per_hour,
  };
}

/** Everything one run did, for a History row opened into its receipt. */
export function runDetail(sql: Sql, runId: string): { run: Record<string, unknown> | null; rows: LogRow[] } {
  const run = sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM runs WHERE id = ?`, runId).toArray()[0] ?? null;
  const rows = sql
    .exec<{ id: string }>(`SELECT id FROM log WHERE run_id = ? ORDER BY seq LIMIT 200`, runId)
    .toArray()
    .map((r) => getRow(sql, r.id)!);
  return { run: run ? { ...run, detail: parse(String(run.detail ?? "{}"), {}) } : null, rows };
}

// --- Inbox -------------------------------------------------------------------------------

/**
 * What's waiting on the owner (§21.2). In M1 that's finished background
 * work to look over and runs that didn't finish; approvals and questions
 * join with the outbox in M2. Marked done by the owner, never by Atlas.
 */
export function inbox(sql: Sql): InboxItem[] {
  const approvals = waitingApprovals(sql).map((a): InboxItem => ({
    id: a.id,
    kind: "approval",
    title: a.title,
    text: "",
    at: a.created_at,
    areas: [],
    run_id: a.source.run_id ?? null,
    approval: approvalView(sql, a),
  }));
  const questions = Object.entries(trustTable(sql))
    .filter(([, t]) => t.offered && t.trusted_at == null)
    .map(([key, t]): InboxItem => ({
      id: key,
      kind: "question",
      title: key.startsWith("email:") || key.startsWith("face:") ? `${t.name}: send without asking?` : `Call ${t.name} without asking?`,
      text: `You've OK'd ${t.name} ${TRUST_AFTER} times in a row as it was. Atlas can ${key.startsWith("email:") || key.startsWith("face:") ? "send these" : "call it"} from now on without asking, and you can take that back in Settings → Permissions.`,
      at: Date.now(),
      areas: [],
      run_id: null,
      question: { key, yes: "Yes, stop asking", no: "Keep asking" },
    }));
  // A coding job's question (§8.2), while the job still waits on it.
  // A job Atlas owns asks the same way, at a checkpoint or a pause (§8.3).
  const waiting = new Set(
    [
      ...codingJobs(sql).map((j) => (j.phase === "waiting" && !j.question?.site ? j.question?.log : null)),
      ...ownedJobs(sql).map((j) => (j.phase === "waiting" || j.phase === "paused" ? j.question?.log : null)),
    ].filter((x): x is string => !!x),
  );
  const jobQuestions = [...waiting]
    .map((id) => getRow(sql, id))
    .filter((r): r is LogRow => r != null)
    .map((r): InboxItem => {
      const b = r.body as unknown as {
        job: string;
        title: string;
        text: string;
        options?: string[];
        why?: string;
        content?: string;
        files?: import("../protocol").FileRef[];
      };
      return {
        id: r.id,
        kind: "question",
        title: `${b.title} needs you`,
        text: b.text,
        at: r.at,
        areas: r.areas,
        run_id: r.run_id,
        job: {
          id: b.job,
          title: b.title,
          question: b.text,
          options: b.options ?? [],
          ...(b.why ? { why: b.why } : {}),
          ...(b.content ? { content: b.content } : {}),
          ...(b.files?.length ? { files: b.files } : {}),
        },
      };
    });
  return [...approvals, ...jobQuestions, ...questions, ...pastItems(sql)];
}

/** An approval as its card shows it: every step, why, and the checks it already passed. */
export function approvalView(sql: Sql, item: AgendaItem): ApprovalView {
  const actions = actionsOf(item);
  const asked = item.source.log_id ? getRow(sql, item.source.log_id) : null;
  const secrets = secretValues(sql);
  const clean = (s: string) => scrub(s, secrets) === s;
  const secretsOk = actions.every((a) =>
    a.kind === "webhook"
      ? !a.message || clean(a.message)
      : a.kind === "mcp"
        ? clean(JSON.stringify(a.arguments))
        : a.kind === "tool"
          ? clean(JSON.stringify(a.input))
          : a.kind === "node"
            ? clean(JSON.stringify(a.input))
            : a.kind === "email"
              ? clean(`${a.subject}\n${a.text}`)
              : a.kind === "face_reply"
                ? clean(a.text)
                : true,
  );
  const hold = needsHold(actions);
  return {
    id: item.id,
    title: item.title,
    steps: actions.map((a) => stepView(sql, a)),
    asked: asked ? String(asked.body.text ?? "").slice(0, 400) : null,
    why:
      (hold ? ASKS.irreversible.why : ASKS[kindOf(actions[0] ?? { kind: "webhook", webhook: "", name: "" })].why) +
      (item.source.detail?.read_web
        ? " Atlas read the web while working on this, so it asks even for what it usually does without asking."
        : ""),
    hold,
    expires_at: item.due_at,
    checks: [
      { name: "Secrets", ok: secretsOk },
      { name: "Your OK", ok: false },
    ],
  };
}

function stepView(sql: Sql, a: Action): ApprovalView["steps"][number] {
  if (a.kind === "face_reply") {
    return {
      kind: "face_reply",
      title: a.name,
      detail: "Your face's answer, which goes out in your name.",
      where: String((a.where as { kind?: string }).kind === "mail" ? "Atlas's email" : ((a.where as { ext?: string }).ext ?? "a chat")),
      undo: "It can't be taken back once it's sent.",
      message: a.text,
    };
  }
  if (a.kind === "email") {
    return {
      kind: "email",
      title: a.name,
      detail:
        a.as === "owner"
          ? `From your own mail, so it reads as you wrote it${a.thread ? ", in the conversation it answers" : ""}.`
          : `From Atlas's own address, saying it's Atlas, an AI assistant writing for you${a.thread ? ", in the conversation it answers" : ""}.`,
      where: a.via === "atlas" ? "Atlas's address" : a.via,
      undo: "Mail can't be taken back once it's sent.",
      message: a.text,
      mail: { from: a.from, to: a.to.join(", "), ...(a.cc?.length ? { cc: a.cc.join(", ") } : {}), subject: a.subject },
    };
  }
  if (a.kind === "node") {
    return {
      kind: "node",
      title: a.name,
      detail: a.what,
      where: a.device,
      undo: "It runs on your device, and only you can undo what it did there.",
    };
  }
  if (a.kind === "mcp") {
    return {
      kind: "mcp",
      title: a.name,
      detail: a.what,
      where: a.where,
      undo: a.destructive
        ? "Its server says this can't be undone."
        : "It reaches one of your connected services, and only that service can undo it.",
      message: JSON.stringify(a.arguments, null, 2).slice(0, 4_000),
    };
  }
  if (a.kind === "tool") {
    return {
      kind: "tool",
      title: a.name,
      detail:
        a.acts === "money"
          ? `${a.what} Amount: ${
              a.amount && a.input[a.amount.field] != null
                ? `${String(a.input[a.amount.field])}${a.amount.currency && a.input[a.amount.currency] != null ? ` ${String(a.input[a.amount.currency])}` : ""}`
                : "as its input below says"
            }.`
          : a.what,
      where: a.where,
      undo:
        a.acts === "irreversible"
          ? "Its extension says this can't be undone."
          : a.acts === "money"
            ? "It moves money, which only the service can take back."
            : a.acts === "change_own"
              ? "Undo on its receipt takes it back."
              : "It reaches other people through one of your services, and only that service can undo it.",
      message: JSON.stringify(a.input, null, 2).slice(0, 4_000),
    };
  }
  if (a.kind === "mcp_add") {
    return {
      kind: "mcp_add",
      title: `Connect ${a.name}`,
      detail: `${a.why} Atlas gets the tools this server offers; ones that do more than read still ask you first.`,
      where: a.url,
      undo: "Remove it any time in Settings → Connections → MCP servers.",
    };
  }
  if (a.kind === "site") {
    return {
      kind: "site",
      title: a.name,
      detail: `${a.why}${a.key ? ` Its requests there will carry your ${a.key.name} from the vault; the workspace never sees the key.` : ""}`,
      where: a.host,
      undo: "Remembered for this site and its subdomains. Remove it under Websites it can reach, in the workspace on the stage.",
    };
  }
  if (a.kind === "vault") {
    const e = findEntry(sql, a.entry);
    const fields = Object.keys(a.fields).map((f) => (e ? (FIELDS[e.kind][f] ?? f) : f).toLowerCase());
    return {
      kind: "vault",
      title: `Fill in ${a.name} on ${a.host}`,
      detail: `Its ${fields.join(", ")}${a.press ? `, then press "${a.press.text}"` : ""}. Atlas never sees the values.`,
      where: a.url,
      undo: a.card
        ? "Card details always ask, every time."
        : `Asks the first time on each site. After your yes, ${a.name} fills on ${a.host} without asking.`,
    };
  }
  if (a.kind === "browser") {
    return {
      kind: "browser",
      title: a.name,
      detail: a.what,
      where: a.url,
      undo: "Can't be taken back once the form is sent.",
    };
  }
  if (a.kind === "delete") {
    return {
      kind: "delete",
      title: `Delete ${a.name} for good`,
      detail: a.fact || a.name,
      where: "Library",
      undo: "Can't be undone: the record, its history and its old values are erased. The message you said it in stays in History.",
    };
  }
  if (a.kind === "pull_request") {
    return {
      kind: "pull_request",
      title: a.name,
      detail: "Opens a pull request from a coding job's branch. Nothing is merged.",
      where: a.repo,
      undo: "Closing the pull request undoes it.",
      message: a.body,
    };
  }
  const hook = webhooks(sql).find((w) => w.id === a.webhook);
  return {
    kind: "webhook",
    title: `Call ${a.name}`,
    detail: hook?.about || "Your webhook.",
    where: hook ? `${webhookView(hook).method} to ${webhookView(hook).host}` : "Removed since",
    undo: "Can't be taken back once it's called.",
    ...(hook?.method === "GET" ? {} : { message: a.message ?? "" }),
  };
}

function pastItems(sql: Sql): InboxItem[] {
  const done = JSON.stringify(getState<string[]>(sql, "inbox_done") ?? []);
  const since = Date.now() - 14 * 86_400_000;
  const rows = sql
    .exec<{ id: string }>(
      `SELECT id FROM log WHERE at > ? AND ((kind = 'job.result' AND json_extract(body, '$.of') IS NULL)
         OR kind = 'face.handoff' OR kind = 'face.digest'
         OR (kind = 'automation.run' AND json_extract(body, '$.report') = 'inbox' AND json_extract(body, '$.test') = 0 AND json_extract(body, '$.quiet') IS NULL)
         OR (kind = 'run.end' AND json_extract(body, '$.state') = 'failed' AND json_extract(body, '$.interrupted') IS NULL AND json_extract(body, '$.trigger') NOT IN ('compaction', 'areas') AND json_extract(body, '$.trigger') NOT LIKE 'helper:%' AND json_extract(body, '$.trigger') NOT LIKE 'automation%'))
         AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY seq DESC LIMIT 100`,
      since,
      done,
    )
    .toArray()
    .map((r) => getRow(sql, r.id)!);
  return rows.map((r): InboxItem => {
    // What a face handed the owner (§7.2), with the conversation, answerable from here; and the faces' digest.
    if (r.kind === "face.handoff" || r.kind === "face.digest") {
      const b = r.body as Record<string, unknown>;
      const conv = typeof b.conv === "string" ? b.conv : "";
      const talk = conv
        ? sql
            .exec<{ kind: string; body: string }>(
              `SELECT kind, body FROM log WHERE kind IN ('face.in', 'face.out') AND json_extract(body, '$.conv') = ? ORDER BY seq DESC LIMIT 12`,
              conv,
            )
            .toArray()
            .reverse()
            .map((x) => {
              const t = JSON.parse(x.body) as { text?: string; by?: string };
              return {
                who: (x.kind === "face.in" ? "them" : t.by === "owner" ? "you" : "face") as "them" | "face" | "you",
                text: String(t.text ?? "").slice(0, 1_000),
              };
            })
        : [];
      return {
        id: r.id,
        kind: "face",
        title:
          r.kind === "face.digest"
            ? `${String(b.face_name ?? "A face")}'s day`
            : `${String(b.face_name ?? "A face")}: ${b.kind === "handoff" ? "wants you" : "a message"} from ${String(b.from ?? "someone")}`,
        text: String(b.text ?? "").slice(0, 2_000),
        at: r.at,
        areas: r.areas,
        run_id: r.run_id,
        face: {
          name: String(b.face_name ?? ""),
          from: String(b.from ?? ""),
          urgent: b.urgent === true,
          reach: Array.isArray(b.reach) ? (b.reach as string[]) : [],
          details: (b.details && typeof b.details === "object" ? b.details : {}) as Record<string, string>,
          conversation: talk,
          can_answer: r.kind === "face.handoff" && !conv.startsWith("test:"),
        },
      };
    }
    // An automation that reports to Inbox (§13.1: report here).
    if (r.kind === "automation.run") {
      const ok = r.body.ok !== false;
      return {
        id: r.id,
        kind: ok ? "review" : "failed",
        title: String(r.body.name ?? "An automation"),
        text: String((ok ? r.body.text : r.body.error) ?? "").slice(0, 2_000),
        at: r.at,
        areas: r.areas,
        run_id: r.run_id,
      };
    }
    if (r.kind === "job.result") {
      const ok = r.body.state === "done";
      return {
        id: r.id,
        kind: ok ? "review" : "failed",
        title: String(r.body.title ?? "A job"),
        text: String((ok ? r.body.text : r.body.error) ?? "").slice(0, 2_000),
        at: r.at,
        areas: r.areas,
        run_id: r.run_id,
      };
    }
    return {
      id: r.id,
      kind: "failed",
      title: "A reply didn't finish",
      text: String(r.body.error ?? "The run failed."),
      at: r.at,
      areas: r.areas,
      run_id: r.run_id,
    };
  });
}

export function inboxDone(sql: Sql, id: string): void {
  const list = getState<string[]>(sql, "inbox_done") ?? [];
  if (!list.includes(id)) setState(sql, "inbox_done", [...list, id].slice(-500));
}
