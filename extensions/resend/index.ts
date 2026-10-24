// Resend (VISION §16.2): sends from Atlas's own address, for owners whose
// domain's Cloudflare account isn't on Workers Paid. Free for 3,000 mails a
// month, 100 a day. Setting it up adds the domain on Resend's side and
// hands the core the DNS records it needs, which the core adds with the
// domain's token.

import { type Extension, get, http, json } from "../sdk";
import { addressLine } from "../lib/mail";

const API = "https://api.resend.com";

interface Domain {
  id: string;
  name: string;
  status: string;
  records?: Array<{ record: string; name: string; type: string; value: string; priority?: number; status?: string }>;
}

const auth = (ctx: { secret(n: string): string }) => ({ authorization: `Bearer ${ctx.secret("api_key")}` });

/** The domain on Resend's side, made when it isn't there. */
async function domainOf(ctx: { secret(n: string): string; settings: Record<string, string> }): Promise<Domain> {
  const name = (ctx.settings.domain ?? "").trim().toLowerCase();
  if (!name) throw new Error("Resend needs the domain Atlas's address is on; setting up Atlas's email gives it.");
  const list = await json<{ data: Domain[] }>(await get(`${API}/domains`, { headers: auth(ctx) }), "Resend");
  const had = list.data.find((d) => d.name === name);
  const d = had
    ? await json<Domain>(await get(`${API}/domains/${had.id}`, { headers: auth(ctx) }), "Resend")
    : await json<Domain>(
        await http(`${API}/domains`, {
          method: "POST",
          headers: { ...auth(ctx), "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
        "Resend",
      );
  return d;
}

const ext: Extension = {
  manifest: {
    id: "resend",
    icon_invert: true,
    name: "Resend",
    version: "1.0.0",
    about: "Sends mail from Atlas's own address through Resend, free for 3,000 mails a month (100 a day). It only sends.",
    provides: ["sending"],
    hosts: ["api.resend.com"],
    settings: [{ name: "domain", label: "Domain", help: "Set by Atlas's email setup: the domain Atlas's address is on.", optional: true }],
    secrets: [
      {
        name: "api_key",
        label: "API key",
        help: "At resend.com → API Keys → Create API key, with full access (so Atlas can add your domain). Then pick Resend under Atlas's email.",
      },
    ],
  },
  async setup(ctx) {
    const d = await domainOf(ctx);
    // Ask Resend to check the records; it may take a few minutes after they're added.
    await http(`${API}/domains/${d.id}/verify`, { method: "POST", headers: auth(ctx) }).catch(() => null);
    return {
      text:
        d.status === "verified"
          ? `Resend sends from ${d.name}.`
          : `Resend has ${d.name}; it starts sending once its DNS records check out, usually within minutes.`,
      records: (d.records ?? []).map((r) => ({
        type: r.type,
        name: r.name,
        content: r.value,
        ...(r.priority != null ? { priority: r.priority } : {}),
      })),
      state: { domain_id: d.id, status: d.status },
    };
  },
  async mail(ctx, m) {
    if (!m.from) throw new Error("Resend needs a from address.");
    const headers: Record<string, string> = {};
    if (m.in_reply_to) headers["In-Reply-To"] = m.in_reply_to;
    const refs = [...new Set([...(m.references ?? []), ...(m.in_reply_to ? [m.in_reply_to] : [])])];
    if (refs.length) headers.References = refs.join(" ");
    if (m.message_id) headers["Message-ID"] = m.message_id;
    const out = await json<{ id: string }>(
      await http(`${API}/emails`, {
        method: "POST",
        headers: { ...auth(ctx), "content-type": "application/json" },
        body: JSON.stringify({
          from: addressLine(m.from),
          to: m.to,
          ...(m.cc?.length ? { cc: m.cc } : {}),
          subject: m.subject,
          text: m.text,
          ...(Object.keys(headers).length ? { headers } : {}),
        }),
      }),
      "Resend",
    );
    return { id: out.id, ...(m.message_id ? { message_id: m.message_id } : {}) };
  },
  async test(ctx) {
    const d = await domainOf(ctx);
    return { text: `Resend has ${d.name}: ${d.status}.` };
  },
};

export default ext;
