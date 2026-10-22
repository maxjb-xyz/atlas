// Free services ask for a request a second or so (OpenStreetMap's, Brave's
// free plan), and a run can fire several calls at once, so calls to one
// host are spaced out here. It's per isolate, which is one person's agent.

const lastCall = new Map<string, number>();

/** Waits so calls to one host are at least `gap` ms apart, then makes the call. */
export async function paced<T>(host: string, gap: number, go: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const at = Math.max(now, (lastCall.get(host) ?? 0) + gap);
  lastCall.set(host, at);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
  return go();
}
