// What Atlas keeps between wakes that isn't a setting or a secret: the
// copy of the iCloud calendar, a refused sign-in, the ChatGPT client's details.
// Settings are for people (rule 5) and secrets never leave, so these live
// here, where neither rule has to bend.

import { parse, type Sql } from "./db";

export type StateName =
  /** Each brain's health (§18): when it last failed, why, and until when it waits at the back of its chain. */
  | "brain_health"
  /** What brains have cost this month and Workers AI's neurons today (§18), from the tokens each call counted. */
  | "brain_spend"
  /** Each calendar account's calendars, by name, as Atlas has read them: for the account's card to put each in an area. */
  | "calendar_names"
  /** Each calendar's refusal of its sign-in, by its extension (the first calendar's was "icloud_refused"). */
  | "calendar_refusals"
  /** Calendar events' areas by series (§6.3): what Clef said or the owner set. */
  | "event_areas"
  /** Calendar events waiting for Clef to sort them into areas. */
  | "events_untagged"
  /** The log's last row the skill review looked back over (§9.3). */
  | "skill_review_seq"
  /** Pairs of skills already offered to the review to merge, as "a|b", so each is offered once. */
  | "skill_pairs_offered"
  /** When the owner last opened Atlas or a push from it (§14: something urgent seen since needs no follow-up). */
  | "owner_seen_at"
  /** The last reason each MCP server gave for not connecting, by address: the SDK forgets it on a reconnect. */
  | "mcp_errors"
  /** Phone calls (§16.1): the one-time keys a call's stream must carry, each until it's used or runs out. */
  | "call_tokens"
  /** Phone calls Atlas placed lately, for its cap. */
  | "calls_placed"
  /** What waits for a coding job's next wake (§8.2): the owner's words, a settled approval, Stop. */
  | `coding_mail:${string}`
  /** A job Atlas owns (§8.3): its plan, what it has done and said, what waits on the owner, and what it has used. */
  | `goal:${string}`
  /** The last twenty MCP tool calls whose pages (MCP Apps) were shown: their input and result, to show them again. */
  | "mcp_apps"
  /** The workspace's last twelve commands, for its view: what ran, its exit code and the end of its output. */
  | "workspace_runs"
  /** The app's address, from the last socket the owner opened: previews are links under it. */
  | "origin"
  /** Websites the workspace may reach (§9.1): each one asked once, then remembered. */
  | "workspace_sites"
  /** Atlas's browser (§9.1): its Browser Run session, tab, and where it is. */
  | "browser"
  /** Set while the owner has the browser: why, since when, and whether Atlas asked for it. */
  | "browser_taken"
  /** Atlas's copy of the iCloud calendars: the home, each calendar's change tag and events, and when it was synced. */
  | "icloud_copy"
  /** Set when iCloud refuses the sign-in: when, why, how many times in a row, and when Atlas tries again. */
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
  | "inbox_done"
  /** Jobs that ended with nobody waiting, until Atlas has told the owner. */
  | "jobs_unreported"
  /** Helpers whose own storage is still there, deleted once their job ends. */
  | "helper_facets"
  /** How many unfiled messages there were when discovery last ran, so it waits for new ones. */
  | "unfiled_tried"
  /**
   * The owner's devices that take push notifications: each one's id, name, push subscription, and when it was
   * last in use. Signed by this deployment's own key, so a subscription alone can't be used by anyone else.
   */
  | "push_devices"
  /** Earned trust (§12.2): for each outside action, approvals in a row as-is, whether Atlas offered to stop asking, and whether it may. */
  | "trust"
  /** When the default routines were made (§13.4), so a routine the owner deleted isn't made again. */
  | "routines"
  /** Automations Atlas suggests from requests the owner repeats (§13.4): what they said, how often, and whether they made it or set it aside. */
  | "suggestions"
  /** Focus (§14): until when things that can wait are held, and what it's for. */
  | "focus"
  /** Where the owner is (§10.1): the last fix from the phone, the saved place they're at, and the regions the phone has. */
  | "location"
  /** The situation's cache (§10.2): today's events, the weather for a rough area, the travel time to the next event with a place. */
  | "situation"
  /** Nudges Atlas sent on its own (§10.3), lately: their kind, what they were about, and how the owner reacted. */
  | "nudges"
  /** Paired devices (§16.3): each one's name, token hash, capabilities, switches, and whether it's online. */
  | "nodes"
  /** Devices waiting for the owner to say yes to pairing, each with its code, for ten minutes. */
  | "node_pairings"
  /** The intake's sources (§10.4): when each last worked, and its last error in the provider's words. */
  | "intake_sources"
  /** What the calendar's last look saw over the next 14 days, to tell its changes. */
  | "calendar_seen"
  /** Webhook sources the owner added (§10.4): their names; their keys are secrets. */
  | "sense_hooks"
  /** When the errands from before tasks were moved over (once). */
  | "tasks_from_errands"
  /** Extensions' sign-ins in flight (§17): each one's state, for which extension, and when it started. */
  | "ext_signins"
  /** When the M4 providers were moved out of the core into bundled extensions (once, §17). */
  | "extensions_moved"
  /** Atlas's own address (§16.2): its domain, the relay and rule in the domain's account, and who sends. */
  | "atlas_mail"
  /** Who the owner is on each chat channel (§16.1): their account there, linked once with a code from the app. */
  | "channel_links"
  /** The code the app shows for linking a chat channel, and until when it's good. */
  | "channel_code"
  /** Chat messages already taken, so one sent again isn't taken twice. */
  | "channel_seen"
  /** When a stranger was last told whose assistant this is, so it's said once a day. */
  | "channel_told"
  /** Messages each stranger sent today on a chat, so a face's answers have a daily limit. */
  | "channel_counts"
  /** The faces (§7.2): each one's settings. */
  | "faces"
  /** Members (§7.1): who shares this Atlas, their roles and invites. */
  | "members"
  /** In a member's own agent: who they are, and whose Atlas they share. */
  | "member_of"
  /** Message-IDs of the owner's mail to Atlas's address already taken, so a mail relayed twice is said once. */
  | "mail_seen"
  /** Indexes of services the owner added by address (§17), beside Atlas's own. */
  | "service_indexes"
  /** Each index's last daily look (§17): the index as fetched, when, and its last error in the host's words. */
  | "service_index_cache"
  /** Extensions installed from an index (§17): the service, the index, and the pinned code and hash they came from. */
  | "service_pins"
  /** Updates to extensions from an index that would reach or hold more than before, waiting for the owner's OK (§17). */
  | "service_updates"
  /** Updates (§23.2): the releases from the daily look, this Atlas's Worker, the last update or rollback, and what ran before it. */
  | "updates";

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
