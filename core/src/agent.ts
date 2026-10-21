// The person agent (§19.2): one Durable Object per person, holding their
// log, records, agenda, settings and live connections. Text and voice share
// one socket and one loop, so voice is the same mind (§11).

import { Agent, type Connection, type WSMessage } from "agents";
import { type TextSource, type Transcriber, type VoiceTurnContext, withVoice } from "agents/voice";
import { BrainRouter } from "./brains/router";
import { type ChatGPTAccess, chatgptBrain } from "./brains/chatgpt";
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
} from "./brains/chatgpt-auth";
import { type Brain, brainKey } from "./brains/types";
import { workersAIBrain } from "./brains/workers-ai";
import { cleanCredentials, icloudCalendar } from "./calendar/caldav";
import { CalendarError, type CalendarSource, type ICloudCredentials } from "./calendar/types";
import { history, systemPrompt, withMessage } from "./context";
import { BUDGETS, type LoopEvent, type LoopResult, runLoop } from "./loop";
import { Outbox, StreamScrubber } from "./outbox";
import { type ChatGPTView, ClientMessage, type ServerMessage, type SettingsView } from "./protocol";
import { type AgendaItem, due, finish, getItem, lease, setScheduleId, upcoming } from "./store/agenda";
import { migrate, type Sql } from "./store/db";
import { append, get as getRow, type LogRow, type Surface, thread } from "./store/log";
import { endRun, runningRuns, startRun, sweepStaleRuns } from "./store/runs";
import {
  type BrainChoice,
  DEFAULT_CHATGPT_MODEL,
  getSecret,
  readSettings,
  type Settings,
  setSecret,
  writeSettings,
} from "./store/settings";
import { isValidZone, shortLocal } from "./time";
import { calendarRead } from "./tools/calendar";
import { reminderTools } from "./tools/reminders";
import type { Tool, ToolContext } from "./tools/types";
import { AUDIO, makeTranscriber, makeTTS } from "./voice/providers";

/** The one owner in M0. Members get their own agents in M5. */
export const OWNER = "owner";

/** Test seams: fake brains and calendar instead of real providers. Only the tests set these. */
export const seams: {
  makeBrain: ((choice: BrainChoice) => Brain | null) | null;
  calendar: CalendarSource | null | undefined;
  fetch: typeof fetch | null;
} = { makeBrain: null, calendar: undefined, fetch: null };

const TOOLS: Tool[] = [calendarRead, ...reminderTools];

/** How long a brain gets to start answering before the next one is tried. */
const FIRST_EVENT_MS = { main: 25_000, voice: 6_000 };

const VoiceAgent = withVoice(Agent<Env>, { audioFormat: AUDIO.format, sampleRate: AUDIO.sampleRate });

interface ConverseOpts {
  runId: string;
  surface: Surface;
  role: "main" | "voice";
  /** The owner's new message, or the clock's note for a run Atlas starts. */
  input: string;
  /** Only log rows before this one count as history (runs wait in line). */
  beforeSeq: number;
  budget: { steps: number; ms: number };
  signal?: AbortSignal;
  emit: (e: LoopEvent) => void;
}

export class PersonAgent extends VoiceAgent {
  #router = new BrainRouter((c) => this.#makeBrain(c));
  #outbox!: Outbox;
  #calendar: { key: string; source: CalendarSource } | null = null;
  /** Runs go one at a time, so each one sees the last one's answer. */
  #line: Promise<unknown> = Promise.resolve();
  #chatgptError: string | null = null;
  #refreshing: Promise<ChatGPTTokens | null> | null = null;

  get #sql(): Sql {
    return this.ctx.storage.sql;
  }

  // --- lifecycle -------------------------------------------------------------

  override async onStart(): Promise<void> {
    migrate(this.#sql);
    sweepStaleRuns(this.#sql, 0);
    this.#outbox = new Outbox(this.#sql, {
      broadcast: (rows) => this.#broadcast({ type: "atlas.rows", rows }),
      speak: async (text) => {
        const calls = [...this.getConnections()].filter((c) => this.#inCall.has(c.id));
        if (calls.length === 0) return false;
        await Promise.all(calls.map((c) => this.speak(c, text)));
        return true;
      },
    });
    this.#refreshVoice();
    // Anything that came due while the agent was asleep runs now.
    for (const item of due(this.#sql, Date.now())) void this.onAgendaDue({ id: item.id });
  }

  /** Connections in a live voice call. The snapshot goes out on atlas.hello, once the app is listening. */
  #inCall = new Set<string>();

  override async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;
    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    const parsed = ClientMessage.safeParse(data);
    if (!parsed.success) {
      this.#send(connection, { type: "atlas.error", message: "Atlas didn't understand that message from the app." });
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "atlas.hello": {
        const s = readSettings(this.#sql);
        if (!s.timezone && msg.tz && isValidZone(msg.tz)) this.#updateSettings({ timezone: msg.tz });
        this.#send(connection, {
          type: "atlas.snapshot",
          thread: thread(this.#sql, 60),
          agenda: upcoming(this.#sql),
          view: this.#view(),
          running: runningRuns(this.#sql).map((r) => ({ run_id: r.id, surface: r.surface })),
        });
        return;
      }
      case "atlas.say":
        void this.keepAliveWhile(() => this.#textTurn(msg.text, msg.client_id));
        return;
      case "atlas.more":
        {
          const rows = thread(this.#sql, 60, msg.before_seq);
          this.#send(connection, { type: "atlas.rows", rows, older: true, has_more: rows.length === 60 });
        }
        return;
      case "atlas.undo":
        await this.#undo(msg.log_id, connection);
        return;
      case "atlas.settings.update":
        this.#updateSettings(msg.patch);
        return;
      case "atlas.secret.set":
        setSecret(
          this.#sql,
          msg.secret.name,
          msg.secret.name === "icloud" && msg.secret.value ? cleanCredentials(msg.secret.value) : msg.secret.value,
        );
        append(this.#sql, { actor: "owner", kind: "settings.change", body: { secret: msg.secret.name, set: msg.secret.value !== null } });
        if (msg.secret.name === "icloud") this.#calendar = null;
        this.#refreshVoice();
        this.#broadcast({ type: "atlas.view", view: this.#view() });
        return;
      case "atlas.chatgpt.start":
        await this.#chatgptStart();
        return;
      case "atlas.chatgpt.finish":
        await this.#chatgptFinish(msg.url);
        return;
      case "atlas.chatgpt.cancel":
        setSecret(this.#sql, "chatgpt_login", null);
        this.#chatgptError = null;
        this.#broadcast({ type: "atlas.view", view: this.#view() });
        return;
      case "atlas.chatgpt.signout":
        setSecret(this.#sql, "chatgpt_tokens", null);
        setSecret(this.#sql, "chatgpt_login", null);
        this.#chatgptError = null;
        append(this.#sql, { actor: "owner", kind: "settings.change", body: { chatgpt: "signed_out" } });
        this.#broadcast({ type: "atlas.view", view: this.#view() });
        return;
      case "atlas.test":
        await this.#test(connection, msg);
        return;
    }
  }

  // --- the two ways the owner talks: text and voice ----------------------------

  async #textTurn(text: string, clientId: string): Promise<void> {
    const runId = startRun(this.#sql, { actor: "owner", trigger: "message", surface: "app", role: "main" });
    const inRow = append(this.#sql, {
      actor: "owner",
      kind: "message.in",
      run_id: runId,
      surface: "app",
      body: { text, client_id: clientId },
    });
    this.#broadcast({ type: "atlas.rows", rows: [inRow] });
    this.#broadcast({ type: "atlas.run", run_id: runId, state: "running", surface: "app", client_id: clientId });

    await this.#inLine(
      async () => {
        const scrubber = new StreamScrubber(this.#outbox.secrets());
        const res = await this.#converse({
          runId,
          surface: "app",
          role: "main",
          input: text,
          beforeSeq: inRow.seq,
          budget: BUDGETS.chat,
          emit: (e) => this.#relay(runId, e, scrubber),
        });
        const tail = scrubber.flush();
        if (tail) this.#broadcast({ type: "atlas.delta", run_id: runId, text: tail });
        await this.#finishRun(runId, "app", res, true);
      },
      { id: runId, surface: "app" },
    ).catch(() => {});
  }

  /** Called by the voice pipeline when the owner finishes a spoken thought. */
  override async onTurn(transcript: string, context: VoiceTurnContext): Promise<TextSource> {
    const runId = startRun(this.#sql, { actor: "owner", trigger: "voice", surface: "voice", role: "voice" });
    const inRow = append(this.#sql, { actor: "owner", kind: "message.in", run_id: runId, surface: "voice", body: { text: transcript } });
    this.#broadcast({ type: "atlas.rows", rows: [inRow] });
    this.#broadcast({ type: "atlas.run", run_id: runId, state: "running", surface: "voice" });

    const spoken = new Speech();
    const started = Date.now();
    let firstWordsMs: number | null = null;
    let statusLine = "";
    const scrubber = new StreamScrubber(this.#outbox.secrets());

    void this.#inLine(
      async () => {
        const res = await this.#converse({
          runId,
          surface: "voice",
          role: "voice",
          input: transcript,
          beforeSeq: inRow.seq,
          budget: BUDGETS.voice,
          signal: context.signal,
          emit: (e) => {
            if (e.type === "text" || (e.type === "status" && e.speakable && e.text)) {
              firstWordsMs ??= Date.now() - started;
              const words = e.type === "text" ? e.text : `${e.text} `;
              if (e.type === "status") statusLine = words;
              spoken.push(scrubber.push(words));
            }
            this.#relay(runId, e, null);
          },
        });
        spoken.push(scrubber.flush());
        spoken.close();
        const said = { ...res, text: `${statusLine}${res.text}`.trim() };
        append(this.#sql, {
          actor: "system",
          kind: "voice.metrics",
          run_id: runId,
          surface: "voice",
          body: {
            first_words_ms: firstWordsMs,
            total_ms: Date.now() - started,
            brain: res.brain,
            tts: this.tts ? ((this.tts as { label?: string }).label ?? null) : null,
          },
        });
        await this.#finishRun(runId, "voice", said, true);
      },
      { id: runId, surface: "voice" },
    ).catch(() => spoken.close());

    return spoken;
  }

  // The voice pipeline would keep its own copy of the conversation. Atlas has
  // one log (§4.2), so these are no-ops and history comes from the log.
  override saveMessage(_role: "user" | "assistant", _text: string): void {}
  override getConversationHistory(): Array<{ role: "user" | "assistant"; content: string }> {
    return [];
  }

  override createTranscriber(_connection: Connection): Transcriber {
    const s = readSettings(this.#sql);
    const terms = [s.assistant_name, s.owner_name].filter(Boolean);
    return makeTranscriber(this.env.AI, s, getSecret<string>(this.#sql, "elevenlabs_api_key"), terms);
  }

  override onCallStart(connection: Connection): void {
    this.#inCall.add(connection.id);
  }

  override onCallEnd(connection: Connection): void {
    this.#inCall.delete(connection.id);
  }

  #refreshVoice(): void {
    this.tts = makeTTS(this.env.AI, readSettings(this.#sql), getSecret<string>(this.#sql, "elevenlabs_api_key"));
  }

  // --- the clock -------------------------------------------------------------

  /** Woken by the scheduler (a Durable Object alarm) when an agenda item is due. */
  async onAgendaDue(payload: { id: string }): Promise<void> {
    const item = lease(this.#sql, payload.id);
    if (!item) return;
    await this.keepAliveWhile(() => this.#inLine(() => this.#remind(item)));
  }

  async #remind(item: AgendaItem): Promise<void> {
    const runId = startRun(this.#sql, { actor: "atlas", trigger: `agenda:${item.id}`, surface: "none", role: "main" });
    const settings = readSettings(this.#sql);
    const tz = this.#tz(settings);
    const set = new Date(item.created_at);
    const note = `[Atlas's clock, not the owner] The reminder "${item.title}" is due now (set ${shortLocal(set, tz)}). Give it to the owner in one short message, as you'd say it. Don't ask follow-up questions unless it truly helps.`;
    const lastSeq = this.#sql.exec<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM log`).one().seq;
    const res: LoopResult = await this.#converse({
      runId,
      surface: "none",
      role: "main",
      input: note,
      beforeSeq: lastSeq,
      budget: { steps: 4, ms: 60_000 },
      emit: (e) => {
        if (e.type === "row") this.#broadcast({ type: "atlas.rows", rows: [e.row] });
      },
    }).catch((err: unknown) => ({
      state: "failed" as const,
      text: "",
      steps: 0,
      brain: null,
      fallback: false,
      interrupted: false,
      usage: { input: 0, output: 0 },
      error: err instanceof Error ? err.message : String(err),
    }));
    // The promise is kept even when no brain can answer: the owner still gets the reminder.
    const kept = res.state === "replied" ? res : { ...res, state: "replied" as const, text: `Reminder: ${item.title}`, brain: null };
    await this.#finishRun(runId, "app", kept, false, `agenda:${item.id}`);
    finish(this.#sql, item.id, "done", runId);
    this.#broadcast({ type: "atlas.agenda", agenda: upcoming(this.#sql) });
  }

  #clock: ToolContext["clock"] = {
    schedule: async (item) => {
      const s = await this.schedule(new Date(item.due_at), "onAgendaDue", { id: item.id });
      setScheduleId(this.#sql, item.id, s.id);
      this.#broadcast({ type: "atlas.agenda", agenda: upcoming(this.#sql) });
    },
    unschedule: async (item) => {
      if (item.schedule_id) await this.cancelSchedule(item.schedule_id);
      setScheduleId(this.#sql, item.id, null);
      queueMicrotask(() => this.#broadcast({ type: "atlas.agenda", agenda: upcoming(this.#sql) }));
    },
  };

  // --- one run ---------------------------------------------------------------

  /**
   * Runs `fn` after the run ahead of it. If it throws, the run still ends in
   * one saved state (failed, with the reason), so nothing stays running.
   */
  #inLine<T>(fn: () => Promise<T>, run?: { id: string; surface: Surface }): Promise<T> {
    const guarded = async () => {
      try {
        return await fn();
      } catch (err) {
        if (run) this.#failRun(run.id, run.surface, err);
        throw err;
      }
    };
    const next = this.#line.then(guarded, guarded);
    this.#line = next.catch(() => {});
    return next;
  }

  #failRun(runId: string, surface: Surface, err: unknown): void {
    endRun(this.#sql, runId, "failed", 0, { error: err instanceof Error ? err.message : String(err) });
    const end = this.#sql.exec<{ id: string }>(`SELECT id FROM log WHERE run_id = ? AND kind = 'run.end'`, runId).toArray()[0];
    if (end) this.#broadcast({ type: "atlas.rows", rows: [getRow(this.#sql, end.id)!] });
    this.#broadcast({ type: "atlas.run", run_id: runId, state: "failed", surface });
  }

  async #converse(o: ConverseOpts): Promise<LoopResult> {
    const settings = readSettings(this.#sql);
    const tz = this.#tz(settings);
    const now = new Date();
    const messages = withMessage(history(this.#sql, o.runId, undefined, o.beforeSeq), o.input);
    return runLoop(
      {
        sql: this.#sql,
        router: this.#router,
        chain: settings.brains[o.role],
        toolContext: { sql: this.#sql, settings, tz, now, calendar: this.#calendarSource(settings), clock: this.#clock },
      },
      {
        runId: o.runId,
        role: o.role,
        surface: o.surface,
        system: systemPrompt({ settings, tz, now, surface: o.surface, sql: this.#sql }),
        messages,
        tools: TOOLS,
        budget: o.budget,
        signal: o.signal,
        joiner: o.surface === "voice" ? " " : "\n\n",
        effort: o.role === "voice" ? "low" : "medium",
        firstEventMs: FIRST_EVENT_MS[o.role],
      },
      o.emit,
    );
  }

  /** Saves the answer through the outbox and closes the run with its one final state. */
  async #finishRun(runId: string, channel: Surface, res: LoopResult, streamed: boolean, trigger?: string): Promise<void> {
    if (res.text.trim()) {
      await this.#outbox.deliver(
        {
          text: res.text,
          run_id: runId,
          channel,
          brain: res.brain,
          fallback: res.fallback,
          interrupted: res.interrupted,
          usage: res.usage,
          trigger,
        },
        { alreadyStreamed: streamed },
      );
    }
    endRun(this.#sql, runId, res.state, res.steps, {
      ...(res.error ? { error: res.error } : {}),
      ...(res.brain ? { brain: brainKey(res.brain) } : {}),
      usage: res.usage as never,
      ...(res.interrupted ? { interrupted: true } : {}),
    });
    const end = this.#sql.exec<{ id: string }>(`SELECT id FROM log WHERE run_id = ? AND kind = 'run.end'`, runId).toArray()[0];
    if (res.state === "failed" && end) this.#broadcast({ type: "atlas.rows", rows: [getRow(this.#sql, end.id)!] });
    this.#broadcast({ type: "atlas.run", run_id: runId, state: res.state, surface: channel });
  }

  /** Streams a run's progress to every open app. */
  #relay(runId: string, e: LoopEvent, scrubber: StreamScrubber | null): void {
    if (e.type === "text") {
      const text = scrubber ? scrubber.push(e.text) : e.text;
      if (text) this.#broadcast({ type: "atlas.delta", run_id: runId, text });
    } else if (e.type === "status") {
      this.#broadcast({ type: "atlas.status", run_id: runId, text: e.text });
    } else {
      this.#broadcast({ type: "atlas.rows", rows: [e.row] });
    }
  }

  // --- the HTTP API (the benchmark and scripts) ----------------------------------

  /** One text turn over HTTP, for the benchmark's "same answers as text" check. */
  async apiTurn(
    text: string,
  ): Promise<{ run_id: string; state: string; reply: string; ms: number; first_text_ms: number | null; brain: string | null }> {
    const started = Date.now();
    let first: number | null = null;
    const runId = startRun(this.#sql, { actor: "owner", trigger: "api", surface: "api", role: "main" });
    const inRow = append(this.#sql, { actor: "owner", kind: "message.in", run_id: runId, surface: "api", body: { text } });
    this.#broadcast({ type: "atlas.rows", rows: [inRow] });
    const res = await this.keepAliveWhile(() =>
      this.#inLine(
        async () => {
          const r = await this.#converse({
            runId,
            surface: "api",
            role: "main",
            input: text,
            beforeSeq: inRow.seq,
            budget: BUDGETS.chat,
            emit: (e) => {
              if (e.type === "text") first ??= Date.now() - started;
              this.#relay(runId, e, null);
            },
          });
          await this.#finishRun(runId, "api", r, true);
          return r;
        },
        { id: runId, surface: "api" },
      ),
    );
    return {
      run_id: runId,
      state: res.state,
      reply: res.state === "replied" ? res.text : (res.error ?? ""),
      ms: Date.now() - started,
      first_text_ms: first,
      brain: res.brain ? brainKey(res.brain) : null,
    };
  }

  /** Voice turn timings and tool calls since a log position, for the benchmark. */
  async apiRunsSince(seq: number): Promise<LogRow[]> {
    return this.#sql
      .exec<{ id: string }>(
        `SELECT id FROM log WHERE seq > ? AND kind IN ('message.in','message.out','tool.call','tool.result','voice.metrics','run.end','brain.fallback') ORDER BY seq LIMIT 500`,
        seq,
      )
      .toArray()
      .map((r) => getRow(this.#sql, r.id)!);
  }

  async apiLastSeq(): Promise<number> {
    return this.#sql.exec<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM log`).one().seq;
  }

  // --- settings, secrets and sign-in ---------------------------------------------

  #updateSettings(patch: Parameters<typeof writeSettings>[1]): void {
    if (patch.timezone && !isValidZone(patch.timezone)) {
      this.#broadcast({
        type: "atlas.error",
        message: `"${patch.timezone}" isn't a time zone Atlas knows. Try one like America/New_York.`,
      });
      return;
    }
    const keys = writeSettings(this.#sql, patch);
    if (keys.length) append(this.#sql, { actor: "owner", kind: "settings.change", body: { keys } });
    if (keys.includes("calendar")) this.#calendar = null;
    this.#refreshVoice();
    this.#broadcast({ type: "atlas.view", view: this.#view() });
  }

  #tz(settings: Settings): string {
    return settings.timezone && isValidZone(settings.timezone) ? settings.timezone : "UTC";
  }

  #calendarSource(settings: Settings): CalendarSource | null {
    if (seams.calendar !== undefined) return seams.calendar;
    const creds = getSecret<ICloudCredentials>(this.#sql, "icloud");
    if (!creds) return null;
    const key = `${creds.username}|${creds.app_password.length}|${settings.calendar.hidden.join(",")}|${settings.timezone}`;
    if (this.#calendar?.key !== key) {
      this.#calendar = {
        key,
        source: icloudCalendar(creds, {
          hidden: settings.calendar.hidden,
          timezone: this.#tz(settings),
          ...(seams.fetch ? { fetch: seams.fetch } : {}),
        }),
      };
    }
    return this.#calendar.source;
  }

  #makeBrain(choice: BrainChoice): Brain | null {
    if (seams.makeBrain) return seams.makeBrain(choice);
    if (choice.provider === "workers-ai") return workersAIBrain(this.env.AI as never, choice.model);
    if (!getSecret<ChatGPTTokens>(this.#sql, "chatgpt_tokens")) return null;
    return chatgptBrain(this.#chatgptAccess, choice.model, seams.fetch ?? fetch);
  }

  #chatgptAccess: ChatGPTAccess = {
    access: async (force = false) => {
      let tokens = getSecret<ChatGPTTokens>(this.#sql, "chatgpt_tokens");
      if (!tokens) return null;
      if (force || tokens.expires_at - Date.now() < 5 * 60_000) tokens = await this.#refreshChatGPT(tokens);
      return tokens?.access_token ?? null;
    },
  };

  /** One refresh at a time, however many turns ask: refresh tokens rotate, so two at once would race. */
  #refreshChatGPT(tokens: ChatGPTTokens): Promise<ChatGPTTokens | null> {
    this.#refreshing ??= (async () => {
      try {
        const fresh = await refreshTokens(tokens, seams.fetch ?? fetch);
        setSecret(this.#sql, "chatgpt_tokens", fresh);
        return fresh;
      } catch (err) {
        if (err instanceof ChatGPTAuthError) {
          setSecret(this.#sql, "chatgpt_tokens", null);
          this.#chatgptError = err.message;
          this.#broadcast({ type: "atlas.view", view: this.#view() });
          return null;
        }
        throw err;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  #chatgptClient(): ChatGPTClient {
    let client = getSecret<ChatGPTClient>(this.#sql, "chatgpt_client");
    if (!client) {
      client = newClient();
      setSecret(this.#sql, "chatgpt_client", client);
    }
    return client;
  }

  /** Step 1 of "Sign in with ChatGPT": the address the owner opens. */
  async #chatgptStart(): Promise<void> {
    const login = await startLogin(this.#chatgptClient());
    setSecret(this.#sql, "chatgpt_login", login);
    this.#chatgptError = null;
    this.#broadcast({ type: "atlas.view", view: this.#view() });
  }

  /** Step 2: the owner pastes the address their browser landed on. */
  async #chatgptFinish(pasted: string): Promise<void> {
    const login = getSecret<ChatGPTLogin>(this.#sql, "chatgpt_login");
    if (!login) {
      this.#chatgptError = "Start the sign-in first.";
      this.#broadcast({ type: "atlas.view", view: this.#view() });
      return;
    }
    try {
      const f = seams.fetch ?? fetch;
      const tokens = await finishLogin(pasted, login, f);
      const models = await listModels(tokens.access_token, f).catch(() => []);
      setSecret(this.#sql, "chatgpt_tokens", tokens);
      setSecret(this.#sql, "chatgpt_login", null);
      setSecret(this.#sql, "chatgpt_client", {
        ...this.#chatgptClient(),
        client_id: tokens.client_id,
        email: tokens.email,
        id_token: tokens.id_token,
        models,
      });
      this.#chatgptError = null;
      append(this.#sql, { actor: "owner", kind: "settings.change", body: { chatgpt: "signed_in", models: models.length } });
      this.#useAvailableModels(models);
    } catch (err) {
      this.#chatgptError = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ChatGPTAuthError)) setSecret(this.#sql, "chatgpt_login", null);
    }
    this.#broadcast({ type: "atlas.view", view: this.#view() });
  }

  /**
   * ChatGPT spots in the brain chains that name a model this account can't use
   * move to the default model if the plan has it, or else its first listed one.
   */
  #useAvailableModels(models: string[]): void {
    if (!models.length) return;
    const s = readSettings(this.#sql);
    const preferred = models.includes(DEFAULT_CHATGPT_MODEL) ? DEFAULT_CHATGPT_MODEL : models[0]!;
    const fix = (chain: BrainChoice[]) =>
      chain.map((c) => (c.provider === "chatgpt" && !models.includes(c.model) ? { ...c, model: preferred } : c));
    const brains = { main: fix(s.brains.main), voice: fix(s.brains.voice) };
    if (JSON.stringify(brains) !== JSON.stringify(s.brains)) this.#updateSettings({ brains });
  }

  #chatgptView(): ChatGPTView {
    const login = getSecret<ChatGPTLogin>(this.#sql, "chatgpt_login");
    const error = this.#chatgptError ?? undefined;
    if (login && login.expires_at > Date.now()) return { state: "pending", authorize_url: login.url, expires_at: login.expires_at, error };
    const tokens = getSecret<ChatGPTTokens>(this.#sql, "chatgpt_tokens");
    const models = getSecret<ChatGPTClient>(this.#sql, "chatgpt_client")?.models ?? [];
    if (tokens) return { state: "signed_in", email: tokens.email, models };
    if (error) return { state: "error", message: error };
    return { state: "signed_out" };
  }

  #view(): SettingsView {
    const icloud = getSecret<ICloudCredentials>(this.#sql, "icloud");
    return {
      settings: readSettings(this.#sql),
      secrets: {
        elevenlabs_api_key: Boolean(getSecret(this.#sql, "elevenlabs_api_key")),
        icloud: icloud ? { username: icloud.username } : null,
      },
      chatgpt: this.#chatgptView(),
      health: this.#router.snapshot(),
    };
  }

  /**
   * What Atlas holds for iCloud, without the password itself, so the owner can
   * tell whether it's what they meant to paste.
   */
  #icloudShape(): string {
    const creds = getSecret<ICloudCredentials>(this.#sql, "icloud");
    if (!creds) return "";
    const p = creds.app_password;
    const form = /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(p)
      ? "in Apple's xxxx-xxxx-xxxx-xxxx form"
      : "not in Apple's xxxx-xxxx-xxxx-xxxx form, so it may not be an app-specific password";
    return `Atlas is signing in as ${creds.username} with a ${p.length}-character password ${form}.`;
  }

  // --- undo and live checks ---------------------------------------------------

  async #undo(logId: string, connection: Connection): Promise<void> {
    const row = getRow(this.#sql, logId);
    const undo = (row?.body.receipt as { undo?: { kind: string; id: string } } | undefined)?.undo;
    if (!row || !undo) {
      this.#send(connection, { type: "atlas.error", message: "There's nothing to undo there." });
      return;
    }
    if (undo.kind === "reminder.cancel") {
      const item = getItem(this.#sql, undo.id);
      if (!item || item.state !== "scheduled") {
        this.#send(connection, { type: "atlas.error", message: "That reminder already went off or was cancelled." });
        return;
      }
      await this.#clock.unschedule(item);
      finish(this.#sql, item.id, "cancelled", row.run_id, { by: "owner", undo_of: logId });
      const undone = this.#sql
        .exec<{ id: string }>(`SELECT id FROM log WHERE kind = 'agenda.change' AND json_extract(body, '$.undo_of') = ?`, logId)
        .one();
      this.#broadcast({ type: "atlas.rows", rows: [getRow(this.#sql, undone.id)!] });
      this.#broadcast({ type: "atlas.agenda", agenda: upcoming(this.#sql) });
    }
  }

  async #test(connection: Connection, msg: Extract<ClientMessage, { type: "atlas.test" }>): Promise<void> {
    const reply = (ok: boolean, message: string, detail?: unknown) =>
      this.#send(connection, { type: "atlas.test.result", what: msg.what, ref: msg.ref, ok, message, detail });
    const settings = readSettings(this.#sql);
    try {
      if (msg.what === "calendar") {
        const source = this.#calendarSource(settings);
        if (!source) return reply(false, "Add your Apple ID and an app-specific password first.");
        const c = await source.check().catch((err: unknown) => {
          throw err instanceof CalendarError && err.code === "auth"
            ? new CalendarError(`${err.message} ${this.#icloudShape()}`, "auth")
            : err;
        });
        return reply(true, `Found ${c.calendars.length} calendars and ${c.events_next_30_days} events in the next 30 days.`, c);
      }
      if (msg.what === "brain") {
        const choice = msg.choice ?? settings.brains[msg.role ?? "main"][msg.index ?? 0];
        if (!choice) return reply(false, "There's no brain at that spot.");
        const brain = this.#makeBrain(choice);
        if (!brain) return reply(false, "Sign in with ChatGPT first.");
        const t0 = Date.now();
        let text = "";
        let firstMs: number | null = null;
        for await (const ev of brain.stream({
          system: "You are being tested. Reply with one short sentence.",
          messages: [{ role: "user", content: "Say hello." }],
          tools: [],
          effort: "low",
          signal: AbortSignal.timeout(30_000),
        })) {
          if (ev.type === "text") {
            firstMs ??= Date.now() - t0;
            text += ev.text;
          }
        }
        this.#router.markOk(brain);
        this.#broadcast({ type: "atlas.view", view: this.#view() });
        return reply(true, `${brainKey(choice)} answered: first words in ${firstMs ?? "?"} ms, done in ${Date.now() - t0} ms.`, {
          text: text.slice(0, 200),
          first_ms: firstMs,
        });
      }
      if (msg.what === "voice") {
        const t0 = Date.now();
        const audio = await this.tts!.synthesize("Hi, this is how I sound.", AbortSignal.timeout(15_000));
        if (!audio) return reply(false, "The voice came back empty.");
        if (this.#inCall.has(connection.id)) await this.speak(connection, "Hi, this is how I sound.");
        return reply(true, `${(this.tts as { label?: string }).label ?? "voice"} spoke in ${Date.now() - t0} ms.`);
      }
    } catch (err) {
      if (msg.what === "brain") {
        const choice = msg.choice ?? settings.brains[msg.role ?? "main"][msg.index ?? 0];
        if (choice) this.#router.markFailed(choice, err);
        this.#broadcast({ type: "atlas.view", view: this.#view() });
      }
      reply(false, err instanceof Error ? err.message : String(err));
    }
  }

  // --- sending ----------------------------------------------------------------

  #send(connection: Connection, msg: ServerMessage): void {
    connection.send(JSON.stringify(msg));
  }

  #broadcast(msg: ServerMessage): void {
    this.broadcast(JSON.stringify(msg));
  }
}

/**
 * What the voice pipeline reads while the loop is still running: text is
 * pushed as the brain streams it and spoken sentence by sentence.
 */
class Speech implements AsyncIterable<string> {
  #chunks: string[] = [];
  #done = false;
  #wake: (() => void) | null = null;

  push(text: string): void {
    if (!text || this.#done) return;
    this.#chunks.push(text);
    this.#wake?.();
  }

  close(): void {
    this.#done = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (this.#done) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = null;
    }
  }
}
