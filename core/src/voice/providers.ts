// Speech in and out (§11.4). Voice is a mode of the same Atlas: these only
// turn audio into text and text into audio. The mind is the same loop.

import { ElevenLabsSTT } from "@cloudflare/voice-elevenlabs";
import { type StreamingTTSProvider, type TTSProvider, type Transcriber, WorkersAIFluxSTT } from "agents/voice";
import type { Settings } from "../store/settings";

/**
 * Flux end-of-turn tuning. Old Atlas found Flux's default 5 s wait after a
 * trailing-off question far too long (voice audit 2026-10-16), so this caps it.
 */
export const FLUX = { eotThreshold: 0.7, eotTimeoutMs: 2500, sampleRate: 16000 };

/**
 * What Atlas sends the app: raw 16-bit PCM. Streamed speech arrives in pieces,
 * and each piece is played as it comes. Raw samples play from any piece;
 * MP3 can't be decoded from arbitrary slices, which made speech choppy.
 */
export const AUDIO = { format: "pcm16", sampleRate: 24_000 } as const;

export type Voice = TTSProvider & StreamingTTSProvider & { label: string };

export function makeTranscriber(ai: Ai, settings: Settings, elevenKey: string | null, keyterms: string[] = []): Transcriber {
  if (settings.voice.speech_in === "elevenlabs-scribe" && elevenKey) {
    return new ElevenLabsSTT({ apiKey: elevenKey, sampleRate: 16000, keyterms: keyterms.slice(0, 50) });
  }
  return new WorkersAIFluxSTT(ai as never, { ...FLUX, keyterms: keyterms.slice(0, 50) });
}

/** Workers AI's voice, used when ElevenLabs isn't set up, so voice works on a fresh deploy. */
export const FALLBACK_TTS_MODEL = "@cf/deepgram/aura-2-en";

/** Told when a sentence couldn't be spoken, so the thread can say so instead of skipping it silently. */
export type OnProblem = (message: string) => void;

export function makeTTS(ai: Ai, settings: Settings, elevenKey: string | null, onProblem: OnProblem = () => {}): Voice {
  if (settings.voice.speech_out === "elevenlabs" && elevenKey) {
    const tts = elevenLabsPcm({
      apiKey: elevenKey,
      voiceId: settings.voice.elevenlabs_voice_id,
      modelId: settings.voice.elevenlabs_model,
      onProblem,
    });
    return wholeSamples(tts, `elevenlabs:${settings.voice.elevenlabs_model}`);
  }
  return wholeSamples(auraPcm(ai), `workers-ai:${FALLBACK_TTS_MODEL}`);
}

/**
 * The voice pipeline starts speech for every sentence of a reply at once.
 * ElevenLabs caps requests running at the same time per plan, and refuses the
 * rest, so at most this many run together. Sentence order is kept by the pipeline.
 */
export const MAX_PARALLEL_SPEECH = 2;
const RETRIES = 3;

function slots(n: number) {
  let free = n;
  const waiting: Array<() => void> = [];
  return {
    async take(): Promise<void> {
      if (free > 0) {
        free -= 1;
        return;
      }
      await new Promise<void>((r) => waiting.push(r));
    },
    give(): void {
      const next = waiting.shift();
      if (next) next();
      else free += 1;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ElevenLabs speech as streamed raw PCM. Atlas calls the API itself rather
 * than through the voice package's provider, which drops a refused sentence
 * without a word: here a refusal is retried, and a sentence that still can't
 * be spoken is reported.
 */
export function elevenLabsPcm(o: {
  apiKey: string;
  voiceId: string;
  modelId: string;
  onProblem?: OnProblem;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}): TTSProvider & StreamingTTSProvider {
  const f = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(o.voiceId)}/stream?output_format=pcm_${AUDIO.sampleRate}`;
  const gate = slots(MAX_PARALLEL_SPEECH);

  async function open(text: string, signal?: AbortSignal): Promise<Response | null> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json", "xi-api-key": o.apiKey },
          body: JSON.stringify({ text, model_id: o.modelId }),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) return null;
        if (attempt < RETRIES) {
          await sleep((o.retryDelayMs ?? 300) * (attempt + 1));
          continue;
        }
        o.onProblem?.(`ElevenLabs couldn't be reached for a sentence (${err instanceof Error ? err.message : String(err)}).`);
        return null;
      }
      if (res.ok && res.body) return res;
      const said = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES && !signal?.aborted) {
        await sleep((o.retryDelayMs ?? 300) * (attempt + 1));
        continue;
      }
      if (!signal?.aborted) o.onProblem?.(`ElevenLabs didn't speak a sentence (HTTP ${res.status}${said ? `: ${said}` : ""}).`);
      return null;
    }
  }

  async function* stream(text: string, signal?: AbortSignal): AsyncGenerator<ArrayBuffer> {
    await gate.take();
    try {
      const res = await open(text, signal);
      if (!res?.body) return;
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value?.byteLength) yield value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } finally {
      gate.give();
    }
  }

  return {
    synthesizeStream: stream,
    async synthesize(text, signal) {
      const parts: Uint8Array[] = [];
      for await (const chunk of stream(text, signal)) parts.push(new Uint8Array(chunk));
      if (!parts.length) return null;
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
      }
      return out.buffer;
    },
  };
}

interface AiLike {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** Workers AI's Aura 2, asked for raw PCM at Atlas's rate and read as a stream. */
export function auraPcm(ai: Ai | AiLike, speaker = "asteria"): TTSProvider & StreamingTTSProvider {
  const open = async (text: string, signal?: AbortSignal): Promise<Response | null> => {
    const res = (await (ai as AiLike).run(
      FALLBACK_TTS_MODEL,
      { text, speaker, encoding: "linear16", container: "none", sample_rate: AUDIO.sampleRate },
      { returnRawResponse: true, ...(signal ? { signal } : {}) },
    )) as Response;
    return res.ok ? res : null;
  };
  return {
    async synthesize(text, signal) {
      const res = await open(text, signal);
      return res ? res.arrayBuffer() : null;
    },
    async *synthesizeStream(text, signal) {
      const res = await open(text, signal);
      if (!res?.body) return;
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value?.byteLength) yield value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    },
  };
}

/** The first piece goes out at once; later ones are gathered to about this much audio, so the app schedules fewer, steadier buffers. */
const FIRST_BYTES = 960; // 20 ms at 24 kHz
const NEXT_BYTES = 4_800; // 100 ms

/**
 * Keeps streamed PCM in whole 16-bit samples: a network piece can end halfway
 * through a sample, and the app reads each piece on its own. The odd byte is
 * carried into the next piece.
 */
export function wholeSamples(inner: TTSProvider & Partial<StreamingTTSProvider>, label: string): Voice {
  return {
    label,
    async synthesize(text, signal) {
      const audio = await inner.synthesize(text, signal);
      return audio && audio.byteLength % 2 ? audio.slice(0, audio.byteLength - 1) : audio;
    },
    async *synthesizeStream(text, signal) {
      const source = inner.synthesizeStream ? inner.synthesizeStream(text, signal) : once(inner.synthesize(text, signal));
      let pending = new Uint8Array(0);
      let sent = false;
      for await (const chunk of source) {
        if (!chunk) continue;
        const next = new Uint8Array(pending.byteLength + chunk.byteLength);
        next.set(pending);
        next.set(new Uint8Array(chunk), pending.byteLength);
        pending = next;
        const ready = pending.byteLength - (pending.byteLength % 2);
        if (ready >= (sent ? NEXT_BYTES : FIRST_BYTES)) {
          yield pending.slice(0, ready).buffer;
          pending = pending.slice(ready);
          sent = true;
        }
      }
      const rest = pending.byteLength - (pending.byteLength % 2);
      if (rest > 0) yield pending.slice(0, rest).buffer;
    },
  };
}

async function* once(p: Promise<ArrayBuffer | null>): AsyncIterable<ArrayBuffer> {
  const audio = await p;
  if (audio) yield audio;
}
