// "Sign in with ChatGPT" (§18): the owner's plan as a brain, through OpenAI's
// official plan usage. This holds the sign-in steps, token refresh, and what
// the app shows about it.

import { type ChatGPTAccess, chatgptBrain } from "../brains/chatgpt";
import {
  ChatGPTAuthError,
  type ChatGPTClient,
  type ChatGPTLogin,
  type ChatGPTTokens,
  finishLogin,
  listModels,
  newClient,
  refreshTokens,
  startLogin,
} from "../brains/chatgpt-auth";
import type { Brain } from "../brains/types";
import type { ChatGPTView } from "../protocol";
import type { Sql } from "../store/db";
import { append } from "../store/log";
import { type BrainChoice, DEFAULT_CHATGPT_MODEL, getSecret, setSecret, type Settings } from "../store/settings";
import { getState, setState } from "../store/state";
import { seams } from "./seams";

export class ChatGPTSignIn {
  #error: string | null = null;
  #refreshing: Promise<ChatGPTTokens | null> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly host: {
      /** Called when what the app shows about ChatGPT changed. */
      changed(): void;
      /** Called after sign-in with the plan's models, so the brain chains can use them. */
      signedIn(models: string[]): void;
    },
  ) {}

  /** A brain on the owner's plan, or null when they aren't signed in. */
  brain(model: string): Brain | null {
    if (!getSecret<ChatGPTTokens>(this.sql, "chatgpt_tokens")) return null;
    return chatgptBrain(this.#access, model, this.#fetch);
  }

  get #fetch(): typeof fetch {
    return seams.fetch ?? fetch;
  }

  #access: ChatGPTAccess = {
    access: async (force = false) => {
      let tokens = getSecret<ChatGPTTokens>(this.sql, "chatgpt_tokens");
      if (!tokens) return null;
      if (force || tokens.expires_at - Date.now() < 5 * 60_000) tokens = await this.#refresh(tokens);
      return tokens?.access_token ?? null;
    },
  };

  /** One refresh at a time, however many turns ask: refresh tokens rotate, so two at once would race. */
  #refresh(tokens: ChatGPTTokens): Promise<ChatGPTTokens | null> {
    this.#refreshing ??= (async () => {
      try {
        const fresh = await refreshTokens(tokens, this.#fetch);
        setSecret(this.sql, "chatgpt_tokens", fresh);
        return fresh;
      } catch (err) {
        if (err instanceof ChatGPTAuthError) {
          setSecret(this.sql, "chatgpt_tokens", null);
          this.#error = err.message;
          this.host.changed();
          return null;
        }
        throw err;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  #client(): ChatGPTClient {
    let client = getState<ChatGPTClient>(this.sql, "chatgpt_client");
    if (!client) {
      client = newClient();
      setState(this.sql, "chatgpt_client", client);
    }
    return client;
  }

  /** Step 1: the address the owner opens. */
  async start(): Promise<void> {
    const login = await startLogin(this.#client());
    setSecret(this.sql, "chatgpt_login", login);
    this.#error = null;
    this.host.changed();
  }

  /** Step 2: the owner pastes the address their browser landed on. */
  async finish(pasted: string): Promise<void> {
    const login = getSecret<ChatGPTLogin>(this.sql, "chatgpt_login");
    if (!login) {
      this.#error = "Start the sign-in first.";
      this.host.changed();
      return;
    }
    try {
      const tokens = await finishLogin(pasted, login, this.#fetch);
      const models = await listModels(tokens.access_token, this.#fetch).catch(() => []);
      setSecret(this.sql, "chatgpt_tokens", tokens);
      setSecret(this.sql, "chatgpt_login", null);
      setState(this.sql, "chatgpt_client", {
        ...this.#client(),
        client_id: tokens.client_id,
        email: tokens.email,
        id_token: tokens.id_token,
        models,
      });
      this.#error = null;
      append(this.sql, { actor: "owner", kind: "settings.change", body: { chatgpt: "signed_in", models: models.length } });
      this.host.signedIn(models);
    } catch (err) {
      this.#error = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ChatGPTAuthError)) setSecret(this.sql, "chatgpt_login", null);
    }
    this.host.changed();
  }

  cancel(): void {
    setSecret(this.sql, "chatgpt_login", null);
    this.#error = null;
    this.host.changed();
  }

  signOut(): void {
    setSecret(this.sql, "chatgpt_tokens", null);
    setSecret(this.sql, "chatgpt_login", null);
    this.#error = null;
    append(this.sql, { actor: "owner", kind: "settings.change", body: { chatgpt: "signed_out" } });
    this.host.changed();
  }

  view(): ChatGPTView {
    const login = getSecret<ChatGPTLogin>(this.sql, "chatgpt_login");
    const error = this.#error ?? undefined;
    if (login && login.expires_at > Date.now()) return { state: "pending", authorize_url: login.url, expires_at: login.expires_at, error };
    const tokens = getSecret<ChatGPTTokens>(this.sql, "chatgpt_tokens");
    const models = getState<ChatGPTClient>(this.sql, "chatgpt_client")?.models ?? [];
    if (tokens) return { state: "signed_in", email: tokens.email, models };
    if (error) return { state: "error", message: error };
    return { state: "signed_out" };
  }
}

/**
 * ChatGPT spots in the brain chains that name a model this account can't use
 * move to the default model if the plan has it, or else its first listed one.
 * Returns null when nothing needs to change.
 */
export function brainsForModels(brains: Settings["brains"], models: string[]): Settings["brains"] | null {
  if (!models.length) return null;
  const preferred = models.includes(DEFAULT_CHATGPT_MODEL) ? DEFAULT_CHATGPT_MODEL : models[0]!;
  const fix = (chain: BrainChoice[]) =>
    chain.map((c) => (c.provider === "chatgpt" && !models.includes(c.model) ? { ...c, model: preferred } : c));
  const next = { main: fix(brains.main), voice: fix(brains.voice) };
  return JSON.stringify(next) === JSON.stringify(brains) ? null : next;
}
