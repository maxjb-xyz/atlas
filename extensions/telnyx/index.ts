// Telnyx (VISION §16.1): phone calls, voice only. The owner pastes one API
// key. Atlas lists the account's numbers with what each is connected to,
// and moves only the chosen number's voice to an app of its own (a Call
// Control application, made once); the account's other numbers and apps are
// left alone, and "Give the number back" points the number where it was
// before. With no number to spare, it lists ones Telnyx would sell, with
// their price, and buys the one picked.
//
// A call from the owner's own number, with caller ID the network vouches for
// (STIR/SHAKEN attestation A, verified), is answered and streamed to Atlas's
// voice. Anyone else hears a line saying whose assistant this is, and the
// call is a missed call for Atlas to mention. Telnyx posts only when a call
// happens, so nothing runs while it's quiet.
// https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-fundamentals

import { type CallData, type Extension, Failure, get, type Json, type NumberOffer, type PhoneNumber } from "../sdk";

const API = "https://api.telnyx.com/v2";

type Ctx = { secret(n: string): string; address?: string; state: Json; data?: Json };

interface State {
  /** Atlas's Call Control application: the connection its number's calls go to. */
  app?: string;
  /** The outbound voice profile that lets the app call out, with a daily spending cap. */
  profile?: string;
  /** The number Atlas uses, and what it was connected to before, for "Give the number back". */
  number?: { id: string; e164: string; before: string | null };
}

const stateOf = (ctx: Ctx): State => ((ctx.state as State | null) ?? {}) as State;

/** One request to Telnyx's API, its errors in Telnyx's own words with the HTTP status. */
async function api<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const res = await get(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.secret("api_key")}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let words = text.replace(/\s+/g, " ").slice(0, 300);
    try {
      const e = (JSON.parse(text) as { errors?: Array<{ code?: string; title?: string; detail?: string }> }).errors?.[0];
      if (e) words = [e.title, e.detail].filter(Boolean).join(": ") + (e.code ? ` (code ${e.code})` : "");
    } catch {
      // Not JSON: keep the words as they came.
    }
    throw new Failure(
      `Telnyx answered ${res.status} to ${method} ${path.split("?")[0]}: ${words || "no reason given"}`,
      res.status === 401 ? "auth" : res.status === 429 || res.status >= 500 ? "network" : "refused",
      res.status,
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

interface TxNumber {
  id: string;
  phone_number: string;
  status: string;
  connection_id?: string | null;
  connection_name?: string | null;
}

/** Atlas's own app and its calling-out profile, made the first time they're needed. */
async function ensureApp(ctx: Ctx, st: State): Promise<State> {
  if (!ctx.address)
    throw new Failure("Atlas doesn't know its own address yet: open Atlas in the browser once, then try again.", "protocol");
  let { app, profile } = st;
  if (!profile) {
    const p = await api<{ data: { id: string } }>(ctx, "POST", "/outbound_voice_profiles", {
      name: "Atlas",
      // A cap on what calling out can spend in a day, so a mistake can't run up a bill.
      daily_spend_limit: "5.00",
      daily_spend_limit_enabled: true,
      concurrent_call_limit: 2,
    });
    profile = p.data.id;
  }
  const settings = {
    application_name: "Atlas",
    webhook_event_url: ctx.address,
    webhook_api_version: "2",
    anchorsite_override: "Latency",
    outbound: { outbound_voice_profile_id: profile },
  };
  if (app) await api(ctx, "PATCH", `/call_control_applications/${app}`, settings);
  else app = (await api<{ data: { id: string } }>(ctx, "POST", "/call_control_applications", settings)).data.id;
  return { ...st, app, profile };
}

const b64 = (o: Json) => btoa(JSON.stringify(o));
const unb64 = (s: unknown): Record<string, string> => {
  try {
    return typeof s === "string" ? (JSON.parse(atob(s)) as Record<string, string>) : {};
  } catch {
    return {};
  }
};

/** What a call's audio streams as: μ-law at 8 kHz both ways, Atlas's speech sent back as RTP payloads. */
const STREAM = {
  stream_track: "inbound_track",
  stream_codec: "PCMU",
  stream_bidirectional_mode: "rtp",
  stream_bidirectional_codec: "PCMU",
};

/** Compares phone numbers by their digits, so "+1 (555) 123-4567" and "+15551234567" are one number. */
const digits = (n: string) => n.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

interface Event {
  data?: {
    id?: string;
    event_type?: string;
    payload?: {
      call_control_id?: string;
      direction?: "incoming" | "outgoing";
      from?: string;
      to?: string;
      client_state?: string;
      shaken_stir_attestation?: string;
      shaken_stir_validated?: boolean;
      hangup_cause?: string;
      failure_reason?: string;
    };
  };
}

const extension: Extension = {
  manifest: {
    id: "telnyx",
    name: "Telnyx",
    version: "1.0.0",
    about:
      "Phone calls: call Atlas on a number of yours, and Atlas calls you about something urgent once you allow it. Voice only. Uses one of your Telnyx numbers, or buys one.",
    provides: ["calls"],
    hosts: ["api.telnyx.com"],
    secrets: [
      {
        name: "api_key",
        label: "A Telnyx API key",
        help: "In the Telnyx portal, Keys & Credentials → API Keys → Create API Key. Telnyx checks your identity before it sells a number; an account that's already verified skips that.",
      },
    ],
    receives: {},
    costs:
      "About 1¢ a minute while you're on a call (Telnyx's voice and streaming), and $1 a month for a number bought through Atlas. Nothing while no call is on.",
    call: { protocol: "media-stream", codec: "pcmu", rate: 8000 },
  },

  async test(ctx) {
    const out = await api<{ data: TxNumber[]; meta?: { total_results?: number } }>(ctx, "GET", "/phone_numbers?page[size]=1");
    const n = out.meta?.total_results ?? out.data.length;
    const ours = stateOf(ctx).number;
    return {
      text: `Signed in to Telnyx: ${n} number${n === 1 ? "" : "s"} on the account.${ours ? ` Atlas answers ${ours.e164}.` : " Pick one for Atlas, or buy one."}`,
    };
  },

  async numbers(ctx) {
    const st = stateOf(ctx);
    const out = await api<{ data: TxNumber[] }>(ctx, "GET", "/phone_numbers?page[size]=100&sort=phone_number");
    const numbers: PhoneNumber[] = out.data.map((n) => ({
      id: n.id,
      number: n.phone_number,
      connected: n.connection_id ? (n.connection_id === st.app ? "Atlas" : (n.connection_name ?? n.connection_id)) : null,
      ours: st.number?.id === n.id,
      status: n.status,
    }));
    return { numbers };
  },

  async use(ctx, q) {
    let st = stateOf(ctx);
    // One number at a time: the one Atlas had goes back first.
    if (st.number && st.number.id !== q.id) {
      await api(ctx, "PATCH", `/phone_numbers/${st.number.id}`, { connection_id: st.number.before });
      st = { ...st, number: undefined };
    }
    st = await ensureApp(ctx, st);
    const n = (await api<{ data: TxNumber }>(ctx, "GET", `/phone_numbers/${q.id}`)).data;
    const before = st.number?.id === q.id ? st.number.before : (n.connection_id ?? null);
    await api(ctx, "PATCH", `/phone_numbers/${q.id}`, { connection_id: st.app });
    const was =
      n.connection_id && n.connection_id !== st.app
        ? ` Its calls went to ${n.connection_name ?? n.connection_id} before; "Give the number back" sends them there again.`
        : "";
    return {
      text: `Atlas answers ${n.phone_number} now. Only this number's calls moved; the account's other numbers and apps are as they were.${was}`,
      number: n.phone_number,
      state: { ...st, number: { id: n.id, e164: n.phone_number, before } } as unknown as Json,
    };
  },

  async release(ctx) {
    const st = stateOf(ctx);
    if (!st.number) return { text: "Atlas isn't using a number." };
    await api(ctx, "PATCH", `/phone_numbers/${st.number.id}`, { connection_id: st.number.before });
    return {
      text: st.number.before
        ? `Gave ${st.number.e164} back: its calls go where they went before.`
        : `Gave ${st.number.e164} back: it isn't connected to anything now, as before.`,
      state: { ...st, number: undefined } as unknown as Json,
    };
  },

  async available(ctx, q) {
    const country = (q.country ?? "US").toUpperCase();
    const params = new URLSearchParams({
      "filter[country_code]": country,
      "filter[phone_number_type]": "local",
      "filter[features][]": "voice",
      "filter[limit]": "8",
    });
    if (q.area) params.set("filter[national_destination_code]", q.area.replace(/\D/g, ""));
    const out = await api<{
      data: Array<{
        phone_number: string;
        region_information?: Array<{ region_type?: string; region_name?: string }>;
        cost_information?: { monthly_cost?: string; upfront_cost?: string; currency?: string };
      }>;
    }>(ctx, "GET", `/available_phone_numbers?${params}`);
    return out.data.map((n): NumberOffer => ({
      number: n.phone_number,
      where: (n.region_information ?? [])
        .filter((r) => r.region_type === "rate_center" || r.region_type === "state")
        .map((r) => r.region_name)
        .filter(Boolean)
        .join(", "),
      monthly: n.cost_information?.monthly_cost ?? "?",
      upfront: n.cost_information?.upfront_cost ?? "?",
      currency: n.cost_information?.currency ?? "USD",
    }));
  },

  async order(ctx, q) {
    let st = await ensureApp(ctx, stateOf(ctx));
    const out = await api<{
      data: {
        id: string;
        status: string;
        requirements_met?: boolean;
        phone_numbers?: Array<{ id: string; phone_number: string; status: string; requirements_met?: boolean }>;
      };
    }>(ctx, "POST", "/number_orders", { phone_numbers: [{ phone_number: q.number }], connection_id: st.app });
    const got = out.data.phone_numbers?.[0];
    if (out.data.requirements_met === false || got?.requirements_met === false)
      return {
        text: `Telnyx took the order for ${q.number}, but it needs your identity checked before the number works. Finish that in the Telnyx portal (Numbers → My Number Orders); then Atlas answers it.`,
        state: st as unknown as Json,
      };
    if (got?.id) {
      if (st.number) await api(ctx, "PATCH", `/phone_numbers/${st.number.id}`, { connection_id: st.number.before });
      st = { ...st, number: { id: got.id, e164: got.phone_number, before: null } };
    }
    return {
      text: `Bought ${q.number}${out.data.status === "pending" ? "; Telnyx is still setting it up, which takes a minute or two" : ""}. Atlas answers it.`,
      number: q.number,
      state: st as unknown as Json,
    };
  },

  async dial(ctx, q) {
    const st = stateOf(ctx);
    const data = ctx.data as unknown as CallData | undefined;
    if (!st.app || !st.number) throw new Failure("Atlas has no number to call from yet: pick or buy one in Settings.", "protocol");
    if (!data?.stream) throw new Failure("Atlas doesn't know its own address yet.", "protocol");
    const out = await api<{ data: { call_control_id: string } }>(ctx, "POST", "/calls", {
      connection_id: st.app,
      to: q.to,
      from: st.number.e164,
      timeout_secs: 30,
      time_limit_secs: 1800,
      client_state: b64({ k: "out", call: q.call }),
      stream_url: `${data.stream}?call=${encodeURIComponent(q.call)}`,
      stream_establish_before_call_originate: true,
      ...STREAM,
    });
    return { id: out.data.call_control_id };
  },

  async receive(ctx, req) {
    let e: Event;
    try {
      e = JSON.parse(req.body) as Event;
    } catch {
      return { reply: { status: 400, body: "That isn't JSON." } };
    }
    const type = e.data?.event_type ?? "";
    const p = e.data?.payload ?? {};
    const id = p.call_control_id;
    const st = stateOf(ctx);
    const data = ctx.data as unknown as CallData | undefined;
    const ours = st.number?.e164;
    if (!id || !data) return { reply: { status: 200 } };
    const act = (action: string, body: Record<string, unknown> = {}) =>
      api(ctx, "POST", `/calls/${encodeURIComponent(id)}/actions/${action}`, { command_id: `${e.data?.id ?? id}-${action}`, ...body });

    if (type === "call.initiated" && p.direction === "incoming" && (!ours || digits(p.to ?? "") === digits(ours))) {
      const fromOwner = data.owner_numbers.some((n) => digits(n) === digits(p.from ?? ""));
      // Caller ID can be faked; the network's own check says this call really comes from that number.
      const vouched = p.shaken_stir_attestation === "A" && p.shaken_stir_validated === true;
      if (fromOwner && vouched) {
        await act("answer", {
          client_state: b64({ k: "owner" }),
          stream_url: `${data.stream}?call=${encodeURIComponent(`in-${id}`)}`,
          ...STREAM,
        });
        return { reply: { status: 200 } };
      }
      await act("answer", { client_state: b64({ k: "other", owner: fromOwner ? "unverified" : "" }) });
      return {
        reply: { status: 200 },
        items: [
          {
            event: "missed_call",
            what: fromOwner
              ? `A call to Atlas's number from your own number (${p.from}), but the network couldn't vouch it was really you, so Atlas didn't answer it as you`
              : `A missed call to Atlas's number from ${p.from ?? "an unknown number"}`,
            from: p.from ?? "unknown",
            key: `call:${id}`,
            signals: ["missed_call"],
          },
        ],
      };
    }
    // Anyone else hears whose assistant this is, then the call ends.
    if (type === "call.answered" && unb64(p.client_state).k === "other") {
      await act("speak", { payload: data.greeting, voice: "female", language: "en-US", client_state: p.client_state });
      return { reply: { status: 200 } };
    }
    if (type === "call.speak.ended" && unb64(p.client_state).k === "other") {
      await act("hangup");
      return { reply: { status: 200 } };
    }
    if (type === "streaming.failed")
      return {
        reply: { status: 200 },
        items: [
          {
            event: "call_failed",
            what: `A call's audio couldn't reach Atlas: ${p.failure_reason ?? "Telnyx gave no reason"}`,
            key: `stream:${id}`,
          },
        ],
      };
    return { reply: { status: 200 } };
  },
};

export default extension;
