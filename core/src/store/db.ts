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
