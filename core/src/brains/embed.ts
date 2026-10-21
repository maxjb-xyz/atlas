// The `embed` role (§18): turns text into vectors for meaning search
// (§5.3). Workers AI fills it by default, since it comes with the account.

import { BrainError } from "./types";
import { normalize } from "../store/memory";

/** EmbeddingGemma: 768 numbers per text, multilingual, on Workers AI. */
export const EMBED_MODEL = "@cf/google/embeddinggemma-300m";

export interface Embedder {
  /** Stored with each vector, so a change of model re-embeds instead of mixing two kinds. */
  model: string;
  /** One unit-length vector per text, in order. */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

interface AiLike {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
}

/** Texts sent in one call; longer lists are split. */
export const EMBED_BATCH = 32;
/** Characters kept per text; the model reads a few thousand tokens at most. */
const MAX_CHARS = 6_000;

export function workersAIEmbedder(ai: AiLike, model = EMBED_MODEL): Embedder {
  return {
    model,
    async embed(texts, signal) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH).map((t) => t.slice(0, MAX_CHARS));
        let res: unknown;
        try {
          res = await ai.run(model, { text: batch }, signal ? { signal } : undefined);
        } catch (err) {
          // Keep Workers AI's own words: they usually name the model or the account limit.
          throw new BrainError(`Workers AI couldn't embed with ${model}: ${err instanceof Error ? err.message : String(err)}`);
        }
        const data = (res as { data?: unknown })?.data;
        if (!Array.isArray(data) || data.length !== batch.length || !data.every((v) => Array.isArray(v) && v.length > 0)) {
          throw new BrainError(`Workers AI's ${model} answered in a shape Atlas doesn't read: ${JSON.stringify(res).slice(0, 200)}`, true);
        }
        for (const v of data as number[][]) out.push(normalize(v));
      }
      return out;
    },
  };
}
