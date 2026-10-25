// Atlas settings → Brains (§18, docs/ui §8): who does Atlas's thinking, and
// what it costs. Simple says it in a sentence; the details show each role's
// chain, each model picked from its provider's catalog, and the providers.

import { useEffect, useState } from "react";
import type { SettingsView } from "../../../core/src/protocol";
import type { BrainChoice, Settings as SettingsT } from "../../../core/src/store/settings";
import type { Atlas } from "../connection";
import { useDetail } from "../theme";
import { clock, dayTime, Icon, Logo, LogoMark, Seg, StateDot, useDismiss } from "../ui";
import type { Edit } from "./index";
import { ChatGPTSignIn, Head, SecretField, TestMessage } from "./parts";
import { WORK_KINDS, type NamedBrain, type WorkKind } from "../../../core/src/store/settings";
import type { Price } from "../../../core/src/brains/catalog";
import type { Health } from "../../../core/src/brains/limits";

type Provider = BrainChoice["provider"];

const PROVIDER: Record<Provider, { name: string; logo: string; by: string }> = {
  chatgpt: { name: "ChatGPT", logo: "openai", by: "Your ChatGPT plan" },
  "workers-ai": { name: "Workers AI", logo: "cloudflare", by: "Comes with Cloudflare" },
  anthropic: { name: "Anthropic", logo: "anthropic", by: "Your Anthropic API key" },
};

/** Each kind of work that can have a brain of its own (§18), as the owner reads it. */
const KIND: Record<WorkKind, { name: string; sub: string }> = {
  helpers: { name: "Helpers", sub: "Quick lookups Atlas hands off" },
  research: { name: "Long research", sub: "Hours of reading and comparing" },
  job_work: { name: "A job's steps", sub: "The work in jobs Atlas owns" },
  job_looks: { name: "A job's looks", sub: "Deciding a job's next move" },
  skill_review: { name: "Learning skills", sub: "The look back after a conversation" },
};

/** The Workers AI models Atlas is built and tested with: the picker's list until the catalog comes, and if it can't. */
const WORKERS_AI_MODELS = ["@cf/moonshotai/kimi-k2.6", "@cf/moonshotai/kimi-k2.5"];

/** Dollars: "$0.42", "$18", "under a cent". */
const usd = (n: number) => (n > 0 && n < 0.01 ? "under a cent" : n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
/** Dollars per million tokens, as the providers write them. */
const perM = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

/**
 * A model's price and speed (docs/ui §8): per million tokens and measured
 * seconds at Developer, plain words below it. Speed is what Atlas's own runs
 * measured, so a model not used yet has none.
 */
function about(b: BrainChoice, price: Price | null | undefined, speed: Health["speed"], developer: boolean): string {
  const parts: string[] = [];
  if (developer) {
    if (b.provider === "chatgpt") parts.push("On your plan");
    else if (price) parts.push(`${perM(price.in)} in · ${perM(price.out)} out per M`);
    if (speed) parts.push(`first word ${(speed.first_ms / 1000).toFixed(1)} s${speed.tps ? ` · ${speed.tps} tokens/s` : ""}`);
  } else {
    if (b.provider === "chatgpt") parts.push("On your plan");
    else if (price) parts.push(price.out <= 1.5 ? "Cheap" : price.out <= 12 ? "Mid-priced" : "Costly");
    if (speed) parts.push(speed.first_ms < 1500 ? "Quick to start" : speed.first_ms < 4000 ? "Steady" : "Slow to start");
  }
  if (price?.paid_plan) parts.push("Workers Paid");
  return parts.join(" · ");
}

/** A meter of 24 steps for a share used, as Notifications draws its budget. */
function Meter({ share }: { share: number }) {
  const on = Math.round(Math.min(1, Math.max(0, share)) * 24);
  return (
    <div className="mtr" aria-hidden>
      {Array.from({ length: 24 }, (_, i) => (
        <i key={i} className={i < on ? "f" : ""} />
      ))}
    </div>
  );
}

/** A model's name as people say it: "Kimi K2.6" for "@cf/moonshotai/kimi-k2.6"; ChatGPT's names are already plain. */
export function modelName(b: BrainChoice): string {
  if (b.provider === "chatgpt" || b.provider === "anthropic") return b.model;
  const last = b.model.split("/").pop() ?? b.model;
  return last
    .split("-")
    .map((w) => (/^k\d/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

function catalog(view: SettingsView, provider: Provider, chains: BrainChoice[], live: string[] = []): string[] {
  const used = chains.filter((b) => b.provider === provider).map((b) => b.model);
  const listed =
    provider === "chatgpt"
      ? view.chatgpt.state === "signed_in"
        ? view.chatgpt.models
        : []
      : provider === "anthropic" || live.length
        ? live
        : WORKERS_AI_MODELS;
  return [...new Set([...listed, ...used])];
}

/** Whether a brain is healthy, failing, or not checked yet, from the router's health. */
const health = (view: SettingsView, b: BrainChoice) => view.health[`${b.provider}:${b.model}`];

export function Brains({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const { at } = useDetail();
  const [more, setMore] = useState(false);
  const details = more || at("detailed");
  const main = draft.brains.main;
  const voice = draft.brains.voice;
  const signedIn = view.chatgpt.state === "signed_in";
  // Who answers today: the first in the chain that can (ChatGPT only once signed in).
  const usable = (b: BrainChoice) =>
    b.provider === "chatgpt" ? signedIn : b.provider === "anthropic" ? view.secrets.anthropic_api_key : true;
  const first = main.find(usable) ?? main[0]!;
  const waiting = main[0]!.provider === "chatgpt" && !signedIn;
  const names = (chain: BrainChoice[]) => [...new Set(chain.filter(usable).map((b) => PROVIDER[b.provider].name))];
  const mainNames = names(main);
  const providers: Provider[] = ["chatgpt", "anthropic", "workers-ai"];
  const keyed = view.secrets.anthropic_api_key;

  return (
    <>
      <Head title="Brains" sub="Who does Atlas's thinking, and what it costs." />
      {!details && (
        <div className="card2 hero">
          <Logo of={PROVIDER[first.provider].logo} size={56} />
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="disp" style={{ fontSize: 19 }}>
              Atlas thinks with {PROVIDER[first.provider].name}
              {first.provider === "chatgpt"
                ? ", on your plan."
                : first.provider === "anthropic"
                  ? ", on your API key."
                  : ", in your Cloudflare account."}
            </span>
            <span className="muted">
              {waiting ? "Sign in with ChatGPT, below, and it thinks with your plan first. " : ""}
              {mainNames.length > 1 ? `If ${mainNames[0]} is busy, ${mainNames[1]} takes over for that answer. ` : ""}
              Voice uses {PROVIDER[voice[0]!.provider].name}
              {voice[0]!.provider === "workers-ai" ? ", because it starts talking fastest." : "."}
              {keyed && [...main, ...voice].some((b) => b.provider === "anthropic")
                ? ` Claude has cost ${usd(view.brains.spend.paid)} of your ${usd(draft.spending.cap)} a month so far.`
                : ""}
            </span>
          </div>
          <button className="btn" onClick={() => setMore(true)}>
            Change
          </button>
        </div>
      )}

      {details && (
        <>
          <div className="set-sub">
            <span className="h2">Roles</span>
            <span className="aside">A fallback covers one turn, and Atlas tells you.</span>
          </div>
          {(["main", "voice"] as const).map((role) => (
            <div className="role-row" key={role}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontWeight: 500 }}>{role === "main" ? "Main" : "Voice"}</span>
                <span className="aside">{role === "main" ? "Chats and jobs" : "Thinks while it talks"}</span>
              </div>
              <Chain
                role={role}
                chain={draft.brains[role]}
                view={view}
                atlas={atlas}
                all={[...main, ...voice]}
                onChange={(chain) => edit({ brains: { ...draft.brains, [role]: chain } })}
              />
            </div>
          ))}
        </>
      )}

      <div className="set-sub">
        <span className="h2">{details ? "Providers" : "Where they come from"}</span>
        <span className="aside">
          {details ? "A failing one is skipped within seconds." : "Each one's state, checked as Atlas uses it."}
        </span>
        <span className="grow" />
        {at("developer") && (
          <span className="mono aside">
            {usd(view.brains.spend.paid)} this month{signedIn ? " + plan" : ""}
          </span>
        )}
      </div>
      <div className="prov-grid">
        {providers.map((p) => {
          const checks = Object.entries(view.health).filter(([k]) => k.startsWith(`${p}:`));
          const bad = checks.find(([, h]) => !h.ok);
          const ready = p === "workers-ai" || (p === "chatgpt" ? signedIn : keyed);
          return (
            <div key={p} className="card2 prov">
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <Logo of={PROVIDER[p].logo} size={30} />
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }} className="grow">
                  <span style={{ fontWeight: 600 }}>{PROVIDER[p].name}</span>
                  <span className="aside clip">
                    {p === "chatgpt"
                      ? signedIn
                        ? `Signed in${view.chatgpt.state === "signed_in" && view.chatgpt.email ? ` as ${view.chatgpt.email}` : ""}`
                        : "Not signed in"
                      : p === "anthropic"
                        ? keyed
                          ? "Has its key"
                          : "Needs an API key"
                        : PROVIDER[p].by}
                  </span>
                </div>
                <StateDot state={!ready ? "off" : bad ? "needs" : "on"} />
              </div>
              {bad ? (
                <span className="err small">{bad[1].reason ?? "It failed its last check."}</span>
              ) : (
                <span className="small">
                  {!ready
                    ? p === "anthropic"
                      ? "Claude, billed by Anthropic for what it uses."
                      : "Sign in to think with your plan."
                    : p === "chatgpt"
                      ? "Thinks on your ChatGPT plan."
                      : p === "anthropic"
                        ? "Billed by Anthropic for what it uses."
                        : "Free allowance each day, then a few cents."}
                </span>
              )}
              {ready && <Limits p={p} view={view} draft={draft} edit={edit} details={details} />}
              {p === "chatgpt" && <ChatGPTSignIn chatgpt={view.chatgpt} atlas={atlas} />}
              {p === "anthropic" && (
                <SecretField
                  label="Your Anthropic API key"
                  set={keyed}
                  onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: "anthropic_api_key", value } })}
                />
              )}
              {at("developer") && p === "chatgpt" && signedIn && (
                <span className="mono aside">{view.chatgpt.state === "signed_in" ? view.chatgpt.models.length : 0} models on the plan</span>
              )}
            </div>
          );
        })}
        {details && <Gateway atlas={atlas} draft={draft} edit={edit} view={view} />}
      </div>

      <div className="set-sub">
        <span className="h2">For different kinds of work</span>
      </div>
      <div className="lines solid">
        <Work name="Chats and jobs" sub="What you ask, and what Atlas does" chain={main} />
        <Work name="Thinking while it talks" sub="Voice, where the first word matters" chain={voice} />
        <div className="work-row">
          <div className="work-name">
            <span style={{ fontWeight: 500 }}>Sorting and remembering</span>
            <span className="aside">Which area things belong to, and what they mean</span>
          </div>
          <span className="nch">
            <LogoMark of="cloudflare" size={13} /> Workers AI
          </span>
          {at("developer") && <span className="mono aside">clef · embeddinggemma-300m</span>}
        </div>
      </div>
      {details && <Named atlas={atlas} draft={draft} edit={edit} view={view} />}
      {!details && (
        <div className="row" style={{ marginTop: 14 }}>
          <span className="muted small">Models and fallbacks for each role are in the details.</span>
          <button className="btn s" onClick={() => setMore(true)}>
            Show details
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A provider's live limits (§18), as far as Atlas knows them: the ChatGPT
 * plan's window from its last answer, what paid brains cost this month
 * against the cap (which is set here), and Workers AI's free allowance today,
 * estimated from Atlas's own thinking.
 */
function Limits({ p, view, draft, edit, details }: { p: Provider; view: SettingsView; draft: SettingsT; edit: Edit; details: boolean }) {
  const { at } = useDetail();
  const b = view.brains;
  const now = Date.now();
  const out = Object.entries(view.health).find(([k, h]) => k.startsWith(`${p}:`) && !h.ok && h.resets_at && h.resets_at > now)?.[1];
  const row = (label: string, value: string, share: number | null, line: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
        <span className="small">{label}</span>
        <span className="mono small">{value}</span>
      </div>
      {share != null && <Meter share={share} />}
      <span className="aside">{line}</span>
    </div>
  );
  if (p === "chatgpt") {
    const w = b.plan?.windows[0];
    if (out) return row("Plan", "Used up", 1, `Resets ${dayTime(out.resets_at!)}. Until then, the next brain in each chain answers.`);
    if (!w) return <span className="aside">ChatGPT hasn't said how much of the plan is left. Its own Usage page shows it.</span>;
    const span = w.window_minutes ? (w.window_minutes >= 1440 ? "Week" : "Plan window") : "Plan window";
    return row(
      span,
      `${Math.round(w.used_percent)}% used`,
      w.used_percent / 100,
      w.resets_at ? `Resets ${dayTime(w.resets_at)}. Until then, all in your plan.` : "All in your plan.",
    );
  }
  if (p === "anthropic") {
    const cap = draft.spending.cap;
    const set = (n: number) => edit({ spending: { cap: Math.max(0, Math.min(10_000, n)) } });
    const step = cap >= 100 ? 25 : 5;
    return (
      <>
        {row(
          "This month",
          cap ? `${usd(b.spend.paid)} of ${usd(cap)}` : usd(b.spend.paid),
          cap ? b.spend.paid / cap : null,
          out
            ? `At the cap until ${dayTime(out.resets_at!)}: the next brain in each chain answers.`
            : cap
              ? "At the cap, it stops, and the next brain in each chain answers."
              : "Paid brains are off: the cap is $0.",
        )}
        {details && (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">Spending cap</span>
            <span className="stepper">
              <button aria-label="Lower" disabled={cap <= 0} onClick={() => set(cap - (cap > 100 ? 25 : 5))}>
                <Icon name="minus" size={12} />
              </button>
              <span>{cap ? `${usd(cap)} a month` : "None"}</span>
              <button aria-label="Higher" onClick={() => set(cap + step)}>
                <Icon name="plus" size={12} />
              </button>
            </span>
          </div>
        )}
        {at("developer") && Object.keys(b.spend.by).some((k) => k.startsWith("anthropic:")) && (
          <span className="mono aside">
            {Object.entries(b.spend.by)
              .filter(([k]) => k.startsWith("anthropic:"))
              .map(([k, v]) => `${k.slice(10)} ${usd(v)}`)
              .join(" · ")}
          </span>
        )}
      </>
    );
  }
  const share = b.free.neurons / b.free.allowance;
  return row(
    "Free allowance today",
    `${Math.round(share * 100)}% used`,
    share,
    out
      ? `Used up until ${dayTime(out.resets_at!)}.`
      : `Resets ${clock(b.free.resets_at)}. Then a few cents a day. An estimate from Atlas's own thinking${at("developer") ? ` (${b.free.neurons.toLocaleString()} of ${b.free.allowance.toLocaleString()} neurons)` : ""}.`,
  );
}

/**
 * The owner's AI Gateway (§18): off until they name one. Anthropic and
 * Workers AI then go through it, so its logs, caching and limits cover them.
 * The binding knows the account, so the gateway's name is all it takes, and
 * a token only for a gateway that asks for one.
 */
function Gateway({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const id = draft.ai_gateway.id;
  return (
    <div className="card2 prov">
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <Logo of="cloudflare" size={30} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }} className="grow">
          <span style={{ fontWeight: 600 }}>AI Gateway</span>
          <span className="aside clip">{id ? `Through "${id}"` : "Off: straight to each provider"}</span>
        </div>
        <StateDot state={id ? "on" : "off"} />
      </div>
      <span className="small">Anthropic and Workers AI go through your own gateway, for its logs and limits. It's free.</span>
      <label className="field">
        <span>Its name, from AI Gateway in Cloudflare</span>
        <input
          className="field-in"
          spellCheck={false}
          placeholder="my-gateway"
          value={id}
          maxLength={64}
          onChange={(e) => edit({ ai_gateway: { id: e.target.value.replace(/[^a-z0-9-]/gi, "") } })}
        />
      </label>
      {id && (
        <SecretField
          label="Its token, only if the gateway is authenticated"
          set={view.secrets.ai_gateway_token}
          onSave={(value) => atlas.send({ type: "atlas.secret.set", secret: { name: "ai_gateway_token", value } })}
        />
      )}
    </div>
  );
}

function Work({ name, sub, chain }: { name: string; sub: string; chain: BrainChoice[] }) {
  const { at } = useDetail();
  return (
    <div className="work-row">
      <div className="work-name">
        <span style={{ fontWeight: 500 }}>{name}</span>
        <span className="aside">{sub}</span>
      </div>
      <span className="row" style={{ gap: 8 }}>
        {chain.map((b, i) => (
          <span key={i} className="row" style={{ gap: 8 }}>
            {i > 0 && <span className="aside">then</span>}
            <span className="nch">
              <LogoMark of={PROVIDER[b.provider].logo} size={13} /> {at("developer") ? modelName(b) : PROVIDER[b.provider].name}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** A role's chain: the first healthy brain answers, the rest are fallbacks. Each slot picks a model from its provider's catalog. */
function Chain({
  role,
  chain,
  view,
  atlas,
  all,
  onChange,
}: {
  role: "main" | "voice";
  chain: BrainChoice[];
  view: SettingsView;
  atlas: Atlas;
  all: BrainChoice[];
  onChange: (c: BrainChoice[]) => void;
}) {
  const set = (i: number, b: BrainChoice) => onChange(chain.map((x, j) => (j === i ? b : x)));
  // The first that can answer: healthy, and for ChatGPT, signed in.
  const inUse = chain.findIndex((b) => health(view, b)?.ok !== false && (b.provider !== "chatgpt" || view.chatgpt.state === "signed_in"));
  return (
    <div className="chain-slots">
      {chain.map((b, i) => {
        const key = `brain:${role}:${b.provider}:${b.model}`;
        const h = health(view, b);
        return (
          <div key={i} className="slot-wrap">
            {i > 0 && <span className="slot-dash" aria-hidden />}
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
              <ModelPicker
                value={b}
                view={view}
                all={all}
                inUse={i === inUse}
                bad={h?.ok === false ? (h.reason ?? "Failing") : null}
                onPick={(nb) => set(i, nb)}
                onRemove={chain.length > 1 ? () => onChange(chain.filter((_, j) => j !== i)) : undefined}
                onTest={() => atlas.test(key, { type: "atlas.test", what: "brain", choice: b })}
                atlas={atlas}
              />
              {atlas.state.tests[key] && <TestMessage r={atlas.state.tests[key]!} />}
            </div>
          </div>
        );
      })}
      {chain.length < 5 && (
        <div className="slot-wrap">
          <span className="slot-dash" aria-hidden />
          <button className="slot add" onClick={() => onChange([...chain, { provider: "workers-ai", model: WORKERS_AI_MODELS[0]! }])}>
            <Icon name="plus" size={13} /> Add a fallback
          </button>
        </div>
      )}
    </div>
  );
}

function ModelPicker({
  value,
  view,
  all,
  inUse,
  bad,
  onPick,
  onRemove,
  onTest,
  atlas,
}: {
  value: BrainChoice;
  view: SettingsView;
  all: BrainChoice[];
  inUse: boolean;
  bad: string | null;
  onPick: (b: BrainChoice) => void;
  onRemove?: () => void;
  onTest: () => void;
  atlas: Atlas;
}) {
  const { at } = useDetail();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(value.provider);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const live = atlas.state.models[provider];
  useEffect(() => {
    if (!open || live) return;
    // Each provider's own catalog: Anthropic's with the key, Workers AI's through the binding.
    if ((provider === "anthropic" && view.secrets.anthropic_api_key) || provider === "workers-ai")
      atlas.send({ type: "atlas.brain.models", provider });
  }, [open, provider, live, view.secrets.anthropic_api_key, atlas]);
  const info = (m: string) => live?.models.find((x) => x.id === m);
  const models = catalog(
    view,
    provider,
    all,
    live?.models.map((m) => m.id),
  );
  return (
    <div className="picker" ref={ref}>
      <button className={`slot ${inUse ? "on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span className="clip" style={{ fontWeight: 500 }}>
            {modelName(value)}
          </span>
          <span className="aside">{PROVIDER[value.provider].name}</span>
        </span>
        {bad ? <span className="err small">Failing</span> : inUse ? <span className="okdot">In use</span> : <StateDot state="off" />}
        <Icon name="down" size={12} style={{ color: "var(--tx3)" }} />
      </button>
      {open && (
        <div className="pop rise model-pop" role="dialog" aria-label="Pick a model">
          <div className="head" style={{ gap: 10 }}>
            <Seg
              small
              label="Provider"
              value={provider}
              options={[
                ["chatgpt", "ChatGPT"],
                ["anthropic", "Anthropic"],
                ["workers-ai", "Workers AI"],
              ]}
              onChange={setProvider}
            />
            <span className="grow" />
            <span className="aside">{PROVIDER[provider].by}</span>
          </div>
          {models.length === 0 && (
            <p className="aside" style={{ padding: "8px 14px" }}>
              {provider === "anthropic"
                ? (live?.error ??
                  (view.secrets.anthropic_api_key
                    ? "Asking Anthropic for its models…"
                    : "Add your Anthropic key in Providers, below, to pick a Claude model."))
                : "Sign in to ChatGPT in Providers, below, to pick one of its models."}
            </p>
          )}
          {provider === "workers-ai" && live?.error && (
            <p className="aside" style={{ padding: "8px 14px" }}>
              Workers AI's catalog didn't come: {live.error} These are the models Atlas is tested with.
            </p>
          )}
          {models.map((m) => {
            const b = { provider, model: m };
            const on = value.provider === provider && value.model === m;
            return (
              <button
                key={m}
                className={`item ${on ? "on" : ""}`}
                onClick={() => {
                  onPick(b);
                  setOpen(false);
                }}
              >
                <span className="grow" style={{ display: "flex", flexDirection: "column" }}>
                  <span>
                    {modelName(b)}
                    {on && <Icon name="check" size={12} style={{ color: "var(--ok)", marginLeft: 6 }} />}
                  </span>
                  {at("developer") && <span className="mono aside">{m}</span>}
                </span>
                <span className={`aside ${at("developer") ? "mono" : ""}`} style={{ textAlign: "right" }}>
                  {about(b, info(m)?.price ?? view.brains.prices[`${provider}:${m}`], health(view, b)?.speed, at("developer"))}
                </span>
              </button>
            );
          })}
          <div className="foot row" style={{ gap: 10 }}>
            <button className="tbtn" onClick={onTest}>
              Test it
            </button>
            {onRemove && (
              <button
                className="tbtn"
                onClick={() => {
                  onRemove();
                  setOpen(false);
                }}
              >
                Take it out of the chain
              </button>
            )}
            {bad && <span className="err small clip">{bad}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Named brains (§18): a few chains with names and a line each ("Quick",
 * "Deep"), and which one each kind of work uses. Atlas sees only the names
 * and lines when it hands work to a helper.
 */
function Named({ atlas, draft, edit, view }: { atlas: Atlas; draft: SettingsT; edit: Edit; view: SettingsView }) {
  const nb = draft.named_brains;
  const set = (p: Partial<typeof nb>) => edit({ named_brains: { ...nb, ...p } });
  const setBrain = (i: number, b: NamedBrain) => set({ brains: nb.brains.map((x, j) => (j === i ? b : x)) });
  const all = [...draft.brains.main, ...nb.brains.flatMap((b) => b.chain)];
  return (
    <>
      <div className="set-sub">
        <span className="h2">Named brains</span>
        <span className="aside">Atlas sees only each one's name and line, and picks one when it hands off work.</span>
      </div>
      <div className="lines solid">
        {nb.brains.map((b, i) => (
          <div className="role-row" key={i}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <input
                className="field-in"
                aria-label="Its name"
                value={b.name}
                maxLength={24}
                onChange={(e) => setBrain(i, { ...b, name: e.target.value })}
              />
              <input
                className="field-in aside"
                aria-label="What it's good for"
                placeholder="What it's good for"
                value={b.line}
                maxLength={120}
                onChange={(e) => setBrain(i, { ...b, line: e.target.value })}
              />
              <button
                className="tbtn"
                onClick={() =>
                  set({
                    brains: nb.brains.filter((_, j) => j !== i),
                    uses: Object.fromEntries(Object.entries(nb.uses).map(([k, v]) => [k, v === b.name ? null : v])) as typeof nb.uses,
                  })
                }
              >
                Remove
              </button>
            </div>
            <Chain role="main" chain={b.chain} view={view} atlas={atlas} all={all} onChange={(chain) => setBrain(i, { ...b, chain })} />
          </div>
        ))}
        {nb.brains.length < 8 && (
          <div className="line">
            <button
              className="btn s"
              onClick={() =>
                set({
                  brains: [
                    ...nb.brains,
                    {
                      name: nb.brains.some((b) => b.name === "Quick") ? `Brain ${nb.brains.length + 1}` : "Quick",
                      line: "",
                      chain: [draft.brains.main[0]!],
                    },
                  ],
                })
              }
            >
              <Icon name="plus" size={12} /> Name a brain
            </button>
          </div>
        )}
      </div>
      {nb.brains.length > 0 && (
        <div className="lines solid" style={{ marginTop: 12 }}>
          {WORK_KINDS.map((k) => (
            <div className="work-row" key={k}>
              <div className="work-name">
                <span style={{ fontWeight: 500 }}>{KIND[k].name}</span>
                <span className="aside">{KIND[k].sub}</span>
              </div>
              <Seg
                small
                label={KIND[k].name}
                value={nb.uses[k] ?? ""}
                options={[["", "Main"] as const, ...nb.brains.map((b) => [b.name, b.name] as const)]}
                onChange={(v) => set({ uses: { ...nb.uses, [k]: v || null } })}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
