// What Atlas keeps between wakes that isn't a setting or a secret: the
// iCloud calendar list, a refused sign-in, the ChatGPT client's details.
// Settings are for people (rule 5) and secrets never leave, so these live
// here, where neither rule has to bend.

import { parse, type Sql } from "./db";

export type StateName =
  /** The iCloud calendar list, found afresh every 6 hours and on Test. */
  | "icloud_calendars"
  /** Set when iCloud refuses the password; Atlas stops asking until the owner reconnects. */
  | "icloud_refused"
  /** This deployment's ChatGPT client: host id, signed-in email, the plan's models and the last ID token as a sign-in hint. */
  | "chatgpt_client"
  /** The last log row the memory index has seen. */
  | "memory_seq";

export function getState<T>(sql: Sql, key: StateName): T | null {
  const row = sql.exec<{ value: string }>(`SELECT value FROM state WHERE key = ?`, key).toArray()[0];
  return row ? parse<T | null>(row.value, null) : null;
}

/** Stores a value, or clears it with null. */
export function setState(sql: Sql, key: StateName, value: unknown): void {
  if (value === null || value === undefined) {
    sql.exec(`DELETE FROM state WHERE key = ?`, key);
    return;
  }
  sql.exec(`INSERT OR REPLACE INTO state (key, value, updated_at) VALUES (?, ?, ?)`, key, JSON.stringify(value), Date.now());
}
