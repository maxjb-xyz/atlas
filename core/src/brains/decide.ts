// The `decide` role (§18): small, fast judgments with probabilities, such
// as which areas a message belongs to (§6.3). Workers AI's Clef fills it by
// default: it answers typed questions about a piece of text, in a few
// hundred milliseconds, for a fraction of a cent.

import { BrainError } from "./types";

export const DECIDE_MODEL = "@cf/cloudflare/clef";

/** A yes-or-no question; the answer is the probability of yes. */
export interface YesNo {
  instructions: string;
}

export interface Decider {
  model: string;
  /** Asks every question about `state` at once. Returns the probability of yes for each id. */
  yesNo(state: string, questions: Record<string, YesNo>, signal?: AbortSignal): Promise<Record<string, number>>;
}

interface AiLike {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
}

/** Clef takes at most this many questions per call. */
export const MAX_QUESTIONS = 64;

export function workersAIDecider(ai: AiLike, model = DECIDE_MODEL): Decider {
  return {
    model,
    async yesNo(state, questions, signal) {
      const ids = Object.keys(questions);
      if (!ids.length) return {};
      if (ids.length > MAX_QUESTIONS)
        throw new BrainError(`Clef takes at most ${MAX_QUESTIONS} questions at once; got ${ids.length}.`, true);
      let res: unknown;
      try {
        res = await ai.run(
          model,
          {
            model: model.split("/").pop(),
            state,
            questions: Object.fromEntries(ids.map((id) => [id, { type: "noul", instructions: questions[id]!.instructions }])),
          },
          signal ? { signal } : undefined,
        );
      } catch (err) {
        // Keep Workers AI's own words: they usually name the model or the account limit.
        throw new BrainError(`Workers AI couldn't decide with ${model}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const answers = (res as { answers?: Record<string, { noul?: unknown }> })?.answers;
      const out: Record<string, number> = {};
      for (const id of ids) {
        const p = answers?.[id]?.noul;
        if (typeof p !== "number") {
          throw new BrainError(`Workers AI's ${model} answered in a shape Atlas doesn't read: ${JSON.stringify(res).slice(0, 200)}`, true);
        }
        out[id] = p;
      }
      return out;
    },
  };
}
