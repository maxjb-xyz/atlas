// Discord, through a bot the owner makes and invites (M2's first way of
// speaking to other people). Only the REST API: who the bot is, the servers
// and text channels it can see, and posting a message. Posting goes through
// the outbox, never straight from a tool (§4.4).

const API = "https://discord.com/api/v10";

/** A text channel the bot can see, with the server it's in. */
export interface DiscordChannel {
  id: string;
  name: string;
  server: string;
}

/** What Atlas keeps from the last check: no secrets, just what the bot could see. */
export interface DiscordCopy {
  bot: string;
  app_id: string;
  servers: Array<{ id: string; name: string; channels: Array<{ id: string; name: string }> }>;
  checked_at: number;
}

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(f: typeof fetch, token: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await f(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
        "user-agent": "Atlas (https://github.com/maxjb-xyz/atlas, 2)",
      },
    });
  } catch (err) {
    throw new DiscordError(`Couldn't reach discord.com: ${err instanceof Error ? err.message : String(err)}`, 0);
  }
  if (res.ok) return (await res.json()) as T;
  const text = await res.text().catch(() => "");
  let words = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { message?: string; code?: number; retry_after?: number };
    // Discord's own 401 message already starts with the status ("401: Unauthorized").
    if (j.message)
      words = `${j.message.replace(`${res.status}: `, "")}${j.code ? ` (code ${j.code})` : ""}${j.retry_after ? `, try again in ${Math.ceil(j.retry_after)} s` : ""}`;
  } catch {
    // Not JSON (Cloudflare's own block page, say): keep the start of it.
  }
  const hint =
    res.status === 401
      ? " The bot token is wrong or was reset; paste the current one from the Discord developer portal."
      : res.status === 403
        ? " The bot isn't allowed to do that there; check its role can view the channel and send messages."
        : "";
  throw new DiscordError(`discord.com answered ${res.status}${words ? `: ${words}` : ""}.${hint}`, res.status);
}

/** Who the bot is and what it can see. Reads each server's channels, so it's for the live test, not every send. */
export async function checkDiscord(f: typeof fetch, token: string): Promise<DiscordCopy> {
  const me = await call<{ id: string; username: string }>(f, token, "/users/@me");
  const app = await call<{ id: string }>(f, token, "/oauth2/applications/@me").catch(() => ({ id: me.id }));
  const guilds = await call<Array<{ id: string; name: string }>>(f, token, "/users/@me/guilds");
  const servers: DiscordCopy["servers"] = [];
  for (const g of guilds.slice(0, 20)) {
    const channels = await call<Array<{ id: string; name: string; type: number; position?: number }>>(f, token, `/guilds/${g.id}/channels`);
    servers.push({
      id: g.id,
      name: g.name,
      // Text and announcement channels: the ones a message can go to.
      channels: channels
        .filter((c) => c.type === 0 || c.type === 5)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((c) => ({ id: c.id, name: c.name })),
    });
  }
  return { bot: me.username, app_id: app.id, servers, checked_at: Date.now() };
}

/** Posts a message. Mentions don't ping anyone: Atlas never sets off @everyone by accident. */
export async function postDiscord(f: typeof fetch, token: string, channelId: string, text: string): Promise<{ id: string }> {
  return call<{ id: string }>(f, token, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }),
  });
}

/** The link that adds the bot to a server, asking only to see channels and send messages. */
export const inviteUrl = (appId: string) =>
  `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot&permissions=3072`;

/** Every channel in the copy, with its server, for picking one by name. */
export function channelsOf(copy: DiscordCopy | null): DiscordChannel[] {
  return (copy?.servers ?? []).flatMap((s) => s.channels.map((c) => ({ id: c.id, name: c.name, server: s.name })));
}
