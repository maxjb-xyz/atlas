// Providers are extensions (VISION §17). The core asks for "a route" or "a
// search", and this picks the extension that gives it: the one the owner
// chose in Settings when it can, else the first that's on and takes the
// call. Every answer comes back as a LookOut, never a throw, with the
// extension's (and the service's) own words when it fails, and how the call
// went is kept for Settings and the Senses screen.

import type { Provides } from "../../extensions/sdk";
import { type ExtensionHost, ExtensionError, getExt, type Installed, methodsOf, noteExt, providing } from "./extensions";
import type { Sql } from "./store/db";
import type { LookOut } from "./web";

/** The extension for a call: the chosen one if it's on and takes the call, else the first that does. */
export function pick(sql: Sql, kind: Provides, method: string, chosen?: string | null): Installed | null {
  const all = providing(sql, kind).filter((e) => methodsOf(e).includes(method));
  return (chosen ? all.find((e) => e.id === chosen) : undefined) ?? all[0] ?? null;
}

/** One call to a provider, as a LookOut: the status is the service's when the extension passed it on. */
export async function provide<T>(
  host: ExtensionHost,
  sql: Sql,
  o: { kind: Provides; method: string; args: unknown[]; chosen?: string | null; what: string },
): Promise<LookOut<T> & { by?: Installed }> {
  const e = pick(sql, o.kind, o.method, o.chosen);
  if (!e) {
    const chosen = o.chosen ? getExt(sql, o.chosen) : null;
    return {
      ok: false,
      status: 0,
      error: chosen
        ? `${chosen.name} is ${chosen.state === "on" ? "installed but can't do that" : "off"}, and no other extension gives ${o.what}. Settings → Extensions.`
        : `No extension gives ${o.what}. Install one in Settings → Extensions.`,
    };
  }
  try {
    const value = await host.call<T>(e.id, o.method, o.args);
    noteExt(sql, e.id);
    return { ok: true, status: 200, value, by: e };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    noteExt(sql, e.id, error);
    console.error(JSON.stringify({ at: `ext.${e.id}.${o.method}`, error }));
    return { ok: false, status: err instanceof ExtensionError ? (err.status ?? 0) : 0, error, by: e };
  }
}

/** The name of the extension that would answer, for receipts ("to OpenStreetMap"). */
export const nameFor = (sql: Sql, kind: Provides, method: string, chosen?: string | null) => pick(sql, kind, method, chosen)?.name ?? kind;

/** The credit the map's data needs: the maps extension the owner picked, else OpenStreetMap's. */
export function mapsCredit(sql: Sql, chosen: string): string {
  return pick(sql, "maps", "route", chosen)?.manifest.credit ?? "© OpenStreetMap contributors";
}
