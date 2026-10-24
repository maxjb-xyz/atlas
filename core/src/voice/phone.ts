// Phone calls into the voice layer (§16.1). A phone service streams a call's
// audio over a WebSocket as JSON frames: the media-stream protocol Telnyx
// uses (Twilio's is the same shape), where each `media` frame carries a
// base64 piece of the call's audio. The Worker accepts that socket and opens
// another to the person agent as an ordinary voice client, and this bridge
// turns one into the other: the caller's 8 kHz G.711 μ-law into the 16-bit
// PCM at 16 kHz speech-in takes, and Atlas's speech (16-bit PCM at 24 kHz)
// back into μ-law at 8 kHz. Phone audio is narrower than the app's, so it's
// taken as it is (§16.1), widened only to the rate speech-in expects.
//
// Nothing here knows a service: which protocol and codec a call uses is in
// its extension's manifest (`call`).

/** What the voice layer takes from a client: 16-bit PCM at this rate (the SDK's default). */
export const SPEECH_IN_RATE = 16_000;
/** The phone's audio: G.711 μ-law at 8 kHz, 160 bytes for each 20 ms. */
export const PHONE_RATE = 8_000;
const FRAME = 160;

// --- G.711 μ-law (ITU-T G.711) -----------------------------------------------------

const BIAS = 0x84;
const CLIP = 32_635;

/** One μ-law byte as a 16-bit sample. */
export function ulawToLinear(u: number): number {
  const x = ~u & 0xff;
  const sign = x & 0x80;
  const exponent = (x >> 4) & 0x07;
  const mantissa = x & 0x0f;
  const s = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -s : s;
}

/** One 16-bit sample as a μ-law byte. */
export function linearToUlaw(sample: number): number {
  let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE = Int16Array.from({ length: 256 }, (_, u) => ulawToLinear(u));

/** The caller's μ-law at 8 kHz as 16-bit PCM at 16 kHz, little-endian, each sample followed by one halfway to the next. */
export function phoneToSpeechIn(ulaw: Uint8Array, last = 0): { pcm: ArrayBuffer; last: number } {
  const out = new Int16Array(ulaw.length * 2);
  let prev = last;
  for (let i = 0; i < ulaw.length; i++) {
    const s = DECODE[ulaw[i]!]!;
    out[i * 2] = (prev + s) >> 1;
    out[i * 2 + 1] = s;
    prev = s;
  }
  return { pcm: out.buffer, last: prev };
}

/**
 * Atlas's speech (16-bit PCM, little-endian, at `rate`) as μ-law at 8 kHz.
 * Each output sample is the mean of the input samples it covers, which also
 * keeps out most of what 8 kHz can't carry. `carry` is a part sample left
 * from the last piece.
 */
export function speechToPhone(
  pcm: Uint8Array,
  rate: number,
  carry: Uint8Array = new Uint8Array(0),
): { ulaw: Uint8Array; carry: Uint8Array } {
  const bytes = carry.length ? concat(carry, pcm) : pcm;
  const ratio = rate / PHONE_RATE;
  const samples = Math.floor(bytes.length / 2);
  const whole = Math.floor(samples / ratio);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(whole);
  for (let i = 0; i < whole; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.floor((i + 1) * ratio);
    let sum = 0;
    for (let j = from; j < to; j++) sum += view.getInt16(j * 2, true);
    out[i] = linearToUlaw(sum / Math.max(1, to - from));
  }
  const used = Math.floor(whole * ratio) * 2;
  return { ulaw: out, carry: bytes.slice(used) };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- the bridge ------------------------------------------------------------------------

/** The two ends a bridge joins: the phone service's socket, and the voice client's socket to the agent. */
export interface End {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", fn: () => void): void;
}

/** A media-stream frame from the phone service. */
interface Frame {
  event?: string;
  media?: { track?: string; payload?: string };
}

/**
 * Joins a call's media stream to the voice layer. The call starts when the
 * stream does, and ends when either side goes; Atlas speaking over the
 * caller clears what the phone still has queued, so barging in works.
 * `rate` is the rate of Atlas's speech. Returns a way to end it.
 */
export function bridge(phone: End, agent: End, o: { rate: number; onEnd?: (why: string) => void }): () => void {
  let started = false;
  let ended = false;
  let last = 0;
  let carry: Uint8Array = new Uint8Array(0);
  let pending: Uint8Array = new Uint8Array(0);
  const end = (why: string) => {
    if (ended) return;
    ended = true;
    try {
      if (started) agent.send(JSON.stringify({ type: "end_call" }));
    } catch {
      // The agent's side may already be gone.
    }
    for (const s of [phone, agent]) {
      try {
        s.close(1000, why.slice(0, 120));
      } catch {
        // Already closed.
      }
    }
    o.onEnd?.(why);
  };

  phone.addEventListener("message", (e) => {
    if (ended || typeof e.data !== "string") return;
    let f: Frame;
    try {
      f = JSON.parse(e.data) as Frame;
    } catch {
      return;
    }
    if (f.event === "start" && !started) {
      started = true;
      agent.send(JSON.stringify({ type: "start_call" }));
    } else if (f.event === "media" && started && f.media?.payload && (f.media.track ?? "inbound") === "inbound") {
      const out = phoneToSpeechIn(fromBase64(f.media.payload), last);
      last = out.last;
      agent.send(out.pcm);
    } else if (f.event === "stop") end("the call ended");
  });

  agent.addEventListener("message", (e) => {
    if (ended) return;
    if (typeof e.data === "string") {
      let m: { type?: string };
      try {
        m = JSON.parse(e.data) as { type?: string };
      } catch {
        return;
      }
      // Atlas stopped speaking because the caller spoke: drop what the phone has queued.
      if (m.type === "playback_interrupt") {
        pending = new Uint8Array(0);
        phone.send(JSON.stringify({ event: "clear" }));
      }
      return;
    }
    const bytes =
      e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : ArrayBuffer.isView(e.data) ? new Uint8Array(e.data.buffer) : null;
    if (!bytes) return;
    const out = speechToPhone(bytes, o.rate, carry);
    carry = out.carry;
    // Whole 20 ms frames only: a phone plays its audio in those.
    const all = pending.length ? concat(pending, out.ulaw) : out.ulaw;
    const whole = all.length - (all.length % FRAME);
    if (whole) phone.send(JSON.stringify({ event: "media", media: { payload: toBase64(all.subarray(0, whole)) } }));
    pending = all.slice(whole);
  });

  phone.addEventListener("close", () => end("the phone hung up"));
  phone.addEventListener("error", () => end("the phone's stream failed"));
  agent.addEventListener("close", () => end("Atlas ended the call"));
  agent.addEventListener("error", () => end("Atlas's side of the call failed"));
  return () => end("ended");
}
