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
  | "memory_seq"
  /** When compaction last failed, so it waits before trying again, across restarts. */
  | "compaction_failed_at"
  /** The last log row the area tagger has seen. */
  | "areas_seq"
  /** The area the owner is focused on with the scope switcher. */
  | "scope"
  /** Messages that fit no area but seemed to be about something ongoing, toward discovering new areas. */
  | "unfiled"
  /** The owner's passkeys: public keys only, so not secrets. */
  | "passkeys"
  /** WebAuthn challenges in flight, by value, with their step and when they expire. */
  | "passkey_challenges"
  /** Signed-in browsers: what opened each session, and when it ends. */
  | "sessions"
  /** Wrong setup codes in a row, for the wait between tries. */
  | "code_tries"
  /** Which setup steps are done or skipped (§22). */
  | "setup"
  /** Inbox items the owner marked done. */
  | "inbox_done";

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
