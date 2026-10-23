// Telegram (VISION §16.1): a chat channel. The owner makes a bot with
// BotFather and gives Atlas its token; setup points the bot at Atlas's
// address for it, with a secret Telegram sends back on every post. Telegram
// posts only when a message arrives, so nothing runs while it's quiet. Each
// message comes to the core as a message (text, a voice note, a photo, a
// button pressed); the core decides who it's from and answers through send.

import { type Extension, type Message, type Out, Failure, base64, bytesOf, get, http } from "../sdk";

const API = "https://api.telegram.org";

type Ctx = { secret(n: string): string; address?: string };

const bot = (ctx: Ctx, method: string) => `${API}/bot${ctx.secret("bot_token")}/${method}`;

async function call<T>(ctx: Ctx, method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const res = await http(bot(ctx, method), {
    method: "POST",
    ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const out = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
  if (!out?.ok)
    throw new Failure(
      `Telegram said: ${out?.description ?? `HTTP ${res.status}`} (${method})`,
      res.status === 401 || res.status === 404 ? "auth" : "protocol",
      res.status,
    );
  return out.result as T;
}

/** A file Telegram holds, as bytes, when it's small enough to read here. */
async function download(ctx: Ctx, fileId: string, max = 8_000_000): Promise<Uint8Array | null> {
  const f = await call<{ file_path?: string; file_size?: number }>(ctx, "getFile", { file_id: fileId });
  if (!f.file_path || (f.file_size ?? 0) > max) return null;
  const res = await get(`${API}/file/bot${ctx.secret("bot_token")}/${f.file_path}`);
  if (!res.ok) throw new Failure(`Telegram didn't give the file (HTTP ${res.status}).`, "network", res.status);
  return new Uint8Array(await res.arrayBuffer());
}

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  voice?: { file_id: string; mime_type?: string; duration?: number };
  audio?: { file_id: string; mime_type?: string };
  photo?: Array<{ file_id: string; file_size?: number; width: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  reply_to_message?: { message_id: number };
}

const nameOf = (u?: TgUser) => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || u?.username || "";

const ext: Extension = {
  manifest: {
    id: "telegram",
    name: "Telegram",
    version: "1.0.0",
    about:
      "Talk to Atlas in Telegram, by text or voice notes, and let people reach a face there. Telegram calls Atlas only when a message arrives, so it costs nothing while quiet.",
    provides: ["channel"],
    hosts: ["api.telegram.org"],
    secrets: [
      {
        name: "bot_token",
        label: "Bot token",
        help: "In Telegram, message @BotFather, send /newbot, and give it a name and a username ending in bot. It answers with a token like 123456:ABC-DEF. Paste it here, then press Set up.",
      },
    ],
    receives: { token_header: "x-telegram-bot-api-secret-token" },
  },
  async setup(ctx) {
    if (!ctx.address) throw new Failure("Atlas doesn't know its own address yet. Open it once from its web address.");
    const key = ctx.address.split("/").pop()!;
    const me = await call<{ username: string; first_name: string }>(ctx, "getMe", {});
    await call(ctx, "setWebhook", {
      url: ctx.address,
      secret_token: key,
      allowed_updates: ["message", "callback_query"],
      max_connections: 4,
    });
    return {
      text: `@${me.username} now sends its messages to Atlas. Message it from your own Telegram, and Atlas will ask for the code shown under Connections → Chat to know it's you.`,
      link: `https://t.me/${me.username}`,
      state: { username: me.username },
    };
  },
  async receive(ctx, req) {
    let u: { update_id: number; message?: TgMessage; callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage } };
    try {
      u = JSON.parse(req.body);
    } catch {
      return { reply: { status: 400, json: { error: "That isn't a Telegram update." } } };
    }
    const messages: Message[] = [];
    if (u.callback_query) {
      const q = u.callback_query;
      // Telegram shows a spinner on the button until it's answered.
      await call(ctx, "answerCallbackQuery", { callback_query_id: q.id }).catch(() => null);
      messages.push({
        id: `cb:${q.id}`,
        chat: String(q.message?.chat.id ?? q.from.id),
        from: { id: String(q.from.id), name: nameOf(q.from), ...(q.from.username ? { handle: q.from.username } : {}) },
        button: { data: q.data ?? "", ...(q.message ? { message: String(q.message.message_id) } : {}) },
      });
    }
    const m = u.message;
    if (m && m.chat.type === "private") {
      const msg: Message = {
        id: `${m.chat.id}:${m.message_id}`,
        chat: String(m.chat.id),
        from: { id: String(m.from?.id ?? m.chat.id), name: nameOf(m.from), ...(m.from?.username ? { handle: m.from.username } : {}) },
        ...(m.text ? { text: m.text } : {}),
        ...(m.reply_to_message ? { reply_to: String(m.reply_to_message.message_id) } : {}),
      };
      const audio = m.voice ?? m.audio;
      if (audio) {
        const bytes = await download(ctx, audio.file_id, 20_000_000);
        if (bytes) msg.voice = { base64: base64(bytes), type: audio.mime_type ?? "audio/ogg" };
      }
      if (m.photo?.length) {
        // The largest that's small enough to read.
        const fit = [...m.photo].sort((a, b) => b.width - a.width).find((p) => (p.file_size ?? 0) <= 4_000_000);
        const bytes = fit ? await download(ctx, fit.file_id) : null;
        if (bytes) msg.photo = { base64: base64(bytes), type: "image/jpeg", ...(m.caption ? { caption: m.caption } : {}) };
      }
      if (!msg.text && m.caption) msg.text = m.caption;
      if (!msg.text && m.document) msg.text = `(sent a file: ${m.document.file_name ?? "a file"})`;
      messages.push(msg);
    }
    return { messages, reply: { json: { ok: true } } };
  },
  async send(ctx, out: Out) {
    const chat_id = out.chat;
    if (out.typing) {
      await call(ctx, "sendChatAction", { chat_id, action: out.voice ? "record_voice" : "typing" });
      return {};
    }
    if (out.react) {
      await call(ctx, "setMessageReaction", {
        chat_id,
        message_id: Number(out.react.message.split(":").pop()),
        reaction: [{ type: "emoji", emoji: out.react.emoji }],
      });
      return {};
    }
    const markup = out.buttons?.length
      ? {
          inline_keyboard: [
            out.buttons.map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: (b.data ?? "").slice(0, 64) })),
          ],
        }
      : undefined;
    const reply = out.reply_to
      ? { reply_parameters: { message_id: Number(out.reply_to.split(":").pop()), allow_sending_without_reply: true } }
      : {};
    if (out.voice || out.file) {
      const form = new FormData();
      form.set("chat_id", chat_id);
      if (out.text) form.set("caption", out.text.slice(0, 1024));
      if (markup) form.set("reply_markup", JSON.stringify(markup));
      if (out.voice) form.set("voice", new Blob([bytesOf(out.voice.base64)], { type: out.voice.type }), "atlas.ogg");
      else
        form.set(
          out.file!.type.startsWith("image/") ? "photo" : "document",
          new Blob([bytesOf(out.file!.base64)], { type: out.file!.type }),
          out.file!.name,
        );
      const method = out.voice ? "sendVoice" : out.file!.type.startsWith("image/") ? "sendPhoto" : "sendDocument";
      const sent = await call<{ message_id: number }>(ctx, method, form);
      return { id: `${chat_id}:${sent.message_id}` };
    }
    // Telegram takes 4,096 characters a message: longer answers go as several.
    const text = out.text ?? "";
    let last = 0;
    for (let i = 0; i < Math.max(1, Math.ceil(text.length / 4000)); i++) {
      const part = text.slice(i * 4000, (i + 1) * 4000);
      const final = (i + 1) * 4000 >= text.length;
      const sent = await call<{ message_id: number }>(ctx, "sendMessage", {
        chat_id,
        text: part,
        link_preview_options: { is_disabled: true },
        ...(i === 0 ? reply : {}),
        ...(final && markup ? { reply_markup: markup } : {}),
      });
      last = sent.message_id;
    }
    return { id: `${chat_id}:${last}` };
  },
  async test(ctx) {
    const me = await call<{ username: string }>(ctx, "getMe", {});
    const info = await call<{ url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string }>(
      ctx,
      "getWebhookInfo",
      {},
    );
    if (!info.url) return { text: `Signed in as @${me.username}, but the bot doesn't send its messages to Atlas yet: press Set up.` };
    const err =
      info.last_error_date && Date.now() / 1000 - info.last_error_date < 3600
        ? ` Its last try to reach Atlas failed: ${info.last_error_message ?? "no reason given"}.`
        : "";
    return {
      text: `@${me.username} sends its messages to Atlas${info.pending_update_count ? `, with ${info.pending_update_count} waiting` : ""}.${err}`,
    };
  },
};

export default ext;
