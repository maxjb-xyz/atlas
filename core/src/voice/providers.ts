// Speech in and out (§11.4). Voice is a mode of the same Atlas: these only
// turn audio into text and text into audio. The mind is the same loop.

import { ElevenLabsSTT, ElevenLabsTTS } from "@cloudflare/voice-elevenlabs";
import { type TTSProvider, type Transcriber, WorkersAIFluxSTT, WorkersAITTS } from "agents/voice";
import type { Settings } from "../store/settings";

/**
 * Flux end-of-turn tuning. Old Atlas found Flux's default 5 s wait after a
 * trailing-off question far too long (voice audit 2026-10-16), so this caps it.
 */
export const FLUX = { eotThreshold: 0.7, eotTimeoutMs: 2500, sampleRate: 16000 };

export function makeTranscriber(ai: Ai, settings: Settings, elevenKey: string | null, keyterms: string[] = []): Transcriber {
  if (settings.voice.speech_in === "elevenlabs-scribe" && elevenKey) {
    return new ElevenLabsSTT({ apiKey: elevenKey, sampleRate: 16000, keyterms: keyterms.slice(0, 50) });
  }
  return new WorkersAIFluxSTT(ai as never, { ...FLUX, keyterms: keyterms.slice(0, 50) });
}

/** Workers AI's voice, used when ElevenLabs isn't set up, so voice works on a fresh deploy. */
export const FALLBACK_TTS_MODEL = "@cf/deepgram/aura-2-en";

export function makeTTS(ai: Ai, settings: Settings, elevenKey: string | null): TTSProvider & { label: string } {
  if (settings.voice.speech_out === "elevenlabs" && elevenKey) {
    const tts = new ElevenLabsTTS({
      apiKey: elevenKey,
      voiceId: settings.voice.elevenlabs_voice_id,
      modelId: settings.voice.elevenlabs_model,
      outputFormat: "mp3_44100_128",
    });
    return Object.assign(tts, { label: `elevenlabs:${settings.voice.elevenlabs_model}` });
  }
  const tts = new WorkersAITTS(ai as never, { model: FALLBACK_TTS_MODEL });
  return Object.assign(tts, { label: `workers-ai:${FALLBACK_TTS_MODEL}` });
}
