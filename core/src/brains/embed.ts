// The `embed` role (§18): turns text into vectors for meaning search
// (§5.3). Workers AI fills it by default, since it comes with the account.

import { BrainError } from "./types";
import type { Sql } from "../store/db";
import { normalize, setRefused, setVector, unembedded } from "../store/memory";

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
/**
 * Characters kept per text. EmbeddingGemma reads about 2,000 tokens, and
 * some text (other scripts, code, links) runs close to a token a character.
 */
const MAX_CHARS = 2_000;

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

/**
 * Embeds up to `batches` batches of items that are waiting. When a batch
 * fails, its items are tried one at a time, and a text the model refuses on
 * its own is marked so it never holds up the rest. Returns the last error,
 * if the model itself is down. `between` runs after each batch. With
 * `oneTry`, a failed batch is left for the background pass to sort out.
 */
export async function embedPending(
  sql: Sql,
  embedder: Embedder,
  opts: { batches: number; size?: number; between?: () => Promise<void>; oneTry?: boolean },
): Promise<string | null> {
  for (let b = 0; b < opts.batches; b++) {
    const todo = unembedded(sql, embedder.model, opts.size ?? EMBED_BATCH);
    if (!todo.length) return null;
    try {
      const vecs = await embedder.embed(todo.map((t) => t.text));
      for (const [i, t] of todo.entries()) setVector(sql, t.ref, t.text, embedder.model, vecs[i]!);
    } catch (batchErr) {
      if (opts.oneTry) return batchErr instanceof Error ? batchErr.message : String(batchErr);
      let worked = 0;
      let lastErr = batchErr;
      for (const t of todo) {
        try {
          const [v] = await embedder.embed([t.text]);
          setVector(sql, t.ref, t.text, embedder.model, v!);
          worked += 1;
        } catch (err) {
          lastErr = err;
        }
      }
      // Some went through, so the model works and the rest are texts it won't take.
      if (worked > 0) {
        for (const t of unembedded(sql, embedder.model, todo.length)) {
          if (todo.some((x) => x.ref === t.ref && x.text === t.text)) setRefused(sql, t.ref, t.text, embedder.model);
        }
      } else {
        // Nothing went through: the model is down, or the one waiting text is refused. Try again later;
        // once anything new joins the batch, a refused text shows itself and is set aside.
        return lastErr instanceof Error ? lastErr.message : String(lastErr);
      }
    }
    await opts.between?.();
  }
  return null;
}
