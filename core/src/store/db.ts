// The person agent's own tables, in its Durable Object SQLite (VISION §19.2).
// The Agents SDK keeps its own `cf_*` tables beside these.

export type Sql = SqlStorage;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Each entry runs once, in order. Never edit an entry that has shipped; add a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    surface TEXT,
    areas TEXT NOT NULL DEFAULT '[]',
    privacy TEXT NOT NULL DEFAULT 'private',
    body TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX log_run ON log(run_id);
  CREATE INDEX log_kind ON log(kind, seq);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    trigger TEXT NOT NULL,
    surface TEXT NOT NULL,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    steps INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX runs_state ON runs(state);

  CREATE TABLE records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    fields TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT '{}',
    learned_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    confidence REAL NOT NULL DEFAULT 1,
    areas TEXT NOT NULL DEFAULT '[]',
    visibility TEXT NOT NULL DEFAULT 'owner'
  );
  CREATE INDEX records_type ON records(type, name);

  CREATE TABLE record_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    fields TEXT NOT NULL,
    reason TEXT NOT NULL
  );

  CREATE TABLE agenda (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    lease_until INTEGER,
    schedule_id TEXT,
    source TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX agenda_due ON agenda(state, due_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // M1: a home for what Atlas keeps between wakes that isn't a secret, moved
  // out of the secrets table, which M0 borrowed for it.
  `
  CREATE TABLE state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO state (key, value, updated_at)
    SELECT name, value, updated_at FROM secrets WHERE name IN ('icloud_calendars', 'icloud_refused', 'chatgpt_client');
  DELETE FROM secrets WHERE name IN ('icloud_calendars', 'icloud_refused', 'chatgpt_client');
  `,
  // M1: memory (§5). Records can be forgotten and linked, and messages and
  // records are indexed for recall by keyword (full-text) and by meaning
  // (embeddings kept beside the text).
  `
  ALTER TABLE records ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE records ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE record_history ADD COLUMN name TEXT;

  CREATE TABLE links (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, kind)
  );
  CREATE INDEX links_to ON links(to_id);

  CREATE TABLE memory (
    ref TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    text TEXT NOT NULL,
    model TEXT,
    vec BLOB
  );
  CREATE INDEX memory_at ON memory(at);
  CREATE INDEX memory_model ON memory(model);

  -- Keyed by memory's rowid, so updating or dropping an item is a point lookup.
  CREATE VIRTUAL TABLE memory_fts USING fts5(text, tokenize = 'porter unicode61');
  `,
  // M1: areas (§6). Tags on log rows and records hold area ids. Examples
  // come from the owner's corrections and teach future tagging.
  `
  CREATE TABLE areas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    about TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'active',
    color INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE UNIQUE INDEX areas_name ON areas(name);

  CREATE TABLE area_examples (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id TEXT NOT NULL,
    text TEXT NOT NULL,
    fits INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX area_examples_area ON area_examples(area_id, seq);

  ALTER TABLE records ADD COLUMN tagged INTEGER NOT NULL DEFAULT 0;
  `,
  // 5. History's totals and the Inbox read the log by time.
  `
  CREATE INDEX log_at ON log(at);
  `,
  // 6. M2: automations (§13). Their next runs are agenda items; their runs are runs.
  `
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    about TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL,
    steps TEXT NOT NULL,
    report TEXT NOT NULL DEFAULT 'thread',
    state TEXT NOT NULL DEFAULT 'paused',
    made_by TEXT NOT NULL,
    allowed TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    tested_at INTEGER,
    fails INTEGER NOT NULL DEFAULT 0,
    paused_why TEXT,
    memo TEXT NOT NULL DEFAULT '{}'
  );
  `,
  // 7. M2: who changed an automation last, since a change by Atlas waits for a test run too (§13.4).
  `
  ALTER TABLE automations ADD COLUMN changed_by TEXT NOT NULL DEFAULT 'owner';
  UPDATE automations SET changed_by = 'atlas' WHERE made_by = 'atlas';
  `,
  // 8. M2: pages (§21.7), a stage view you keep, in versions.
  `
  CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    made_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE page_versions (
    page_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    by TEXT NOT NULL,
    body TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (page_id, n)
  );
  `,
  // 9. M3: files (§21.7), things Atlas makes that you download, kept in R2.
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    made_by TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    run_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 10. M3: skills (§9.3), in the SKILL.md format, every version kept.
  `
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    "check" TEXT NOT NULL DEFAULT '',
    areas TEXT NOT NULL DEFAULT '[]',
    made_by TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    version INTEGER NOT NULL DEFAULT 1,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER,
    checked TEXT NOT NULL DEFAULT 'null',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE skill_versions (
    skill_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    by TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    "check" TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (skill_id, n)
  );
  `,
  // 11. M4: the intake (§10.4). Each sense row's place in it: received, weighed, then done or failed, and what was decided.
  `
  CREATE TABLE intake (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    source TEXT NOT NULL,
    key TEXT,
    state TEXT NOT NULL,
    outcome TEXT,
    why TEXT,
    scores TEXT,
    run_id TEXT,
    seen_at INTEGER,
    raw TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX intake_state ON intake(state, at);
  CREATE INDEX intake_key ON intake(key, at);
  CREATE INDEX intake_later ON intake(outcome, seen_at, at);
  `,
  // 12. M5: extensions (§17). Each installed one: its manifest, its code when it isn't bundled, whether it's on,
  // its settings, cursor and state, the key in its address, and how its last call went. Its secrets are secrets.
  `
  CREATE TABLE extensions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    source TEXT NOT NULL,
    code TEXT,
    manifest TEXT NOT NULL,
    methods TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'on',
    settings TEXT NOT NULL DEFAULT '{}',
    cursor TEXT,
    data TEXT,
    key TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_look INTEGER,
    ok_at INTEGER,
    error TEXT,
    error_at INTEGER
  );
  `,
];

/** Brings the schema up to date. Tests pass `to` to stop at an older version. */
export function migrate(sql: Sql, to = MIGRATIONS.length): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS atlas_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = sql.exec<{ value: string }>(`SELECT value FROM atlas_meta WHERE key = 'schema'`).toArray()[0];
  let version = row ? Number(row.value) : 0;
  while (version < to) {
    sql.exec(MIGRATIONS[version]!);
    version += 1;
    sql.exec(`INSERT OR REPLACE INTO atlas_meta (key, value) VALUES ('schema', ?)`, String(version));
  }
}

/** A short, time-sortable id with a type prefix: `run_lzx3k1a9f2c4`. */
export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const tail = Array.from(rand, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 8);
  return `${prefix}_${Date.now().toString(36)}${tail}`;
}

export function parse<T>(text: string | null | undefined, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
