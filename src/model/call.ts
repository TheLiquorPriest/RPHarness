// One model call, from RPH straight to its provider through pi-ai: the connection it goes on and how
// it signs, the model and what pi-ai knows of it with its limits (limits.ts), the effort, the room
// it may write in, the sampling parameters its provider takes, the prompt cache, and the transcript
// with each system message kept where it stands (transcript.ts). Its answer streams as pi-ai's
// events, the shape pi's loop reads from a stream function (`StreamFn`); a request passed through
// (pass.ts) reads the same events.
//
// A stream function's contract holds here: nothing throws. A call that can't be made, a failed one
// and a stopped one each end the stream with an error event, in words: a failure in the provider's
// own words with its status first, a stop with the reason "aborted", and never a secret the layer
// holds. A call that failed before any piece of its answer came (its server couldn't be reached, or
// answered 429 or 5xx) is made again, as many times as its connection's setting says (`RETRIES`
// when it says nothing), after a wait that doubles each time; one that failed after something came
// never is. pi-ai's own retries stay off, so these are the only ones.
//
// Every request carries everything it is about, so that what an agent was sent can be read back
// whole: Anthropic's message threads, where pi-ai sends a later request only what is new and the
// server keeps the rest, are off unless the connection turns them on.
//
// What leaves with a call goes only where its connection says: the call follows no redirect, since
// its key and headers would go with it to an address nobody gave them for, and neither a key nor a
// header the loop passes in its options is sent. Google's calls are the one kind that can't go out
// through the layer's own fetch, so a Google connection takes no address but Google's own (book.ts).
// A stream that goes silent once its answer has begun is ended after a wait (`silenceWatch`), in
// words that say so.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AnthropicMessagesCompat, Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, CacheRetention, Model, ModelThinkingLevel, MutableModels, OpenAICompletionsCompat, OpenAIResponsesCompat, SimpleStreamOptions, ThinkingBudgets, ThinkingLevel, ToolChoice, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_BUDGETS, MIN_ANSWER_TOKENS, clampReasoning } from "@earendil-works/pi-ai/api/simple-options";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { JsonObject, ModelLimits } from "../contract";
import type { Book, Connection } from "./book";
import { sentHeaders } from "./book";
import { isRecord, isTokenCount, own } from "./json";
import type { ProviderKind, Sampling, SamplingName } from "./kinds";
import { SAMPLING_NAMES, kindOf, unlistedModel } from "./kinds";
import { limitsOf } from "./limits";
import type { AgentChoice, ModelEffort } from "./source";
import { compatSays, inPlace, keepsSystemInPlace } from "./transcript";
import { REDIRECT_REFUSED, REDIRECT_WORDS, durationWords, errorWords, failureWords, redact } from "./words";

export interface CallDeps {
  pi: MutableModels;
  book: Book;
  /** How HTTP goes out, where pi-ai's client for the API takes it. */
  fetch: typeof globalThis.fetch;
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** How long a call whose answer has begun may go with nothing from its server before it is ended; 0 for no limit. */
  silentMs(): Promise<number>;
  /** The words that name that wait's setting, and where it is changed. */
  silentSetting(): string;
  /** The text a system message is sent as where its model takes none mid-conversation, from the system message's text; absent: its text, unmarked. */
  markNote?(text: string): string;
}

/** What a call goes to and how its model is asked to think, known before anything is sent. */
export interface CallShape {
  connection: Connection;
  kind: ProviderKind;
  /** The model with what pi-ai knows of it, at the address the connection gives, with its limits as resolved. */
  model: Model<Api>;
  limits: ModelLimits;
  /** The level the model is asked to think at; undefined where it is asked not to think, or left to its provider. */
  reasoning: ThinkingLevel | undefined;
  /** The effort is the provider's own default: no switch is sent, and its model may think. */
  providerDefault: boolean;
}

/** What a call asks of its model beyond its messages. */
export interface CallAsk {
  /** The room its answer is asked to keep within, its reasoning included; absent: the model's longest reply. */
  maxTokens?: number;
  /** The level the model is asked to think at; absent: not at all, or the provider's own default where the shape leaves it to the provider. */
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  sampling: Sampling;
  toolChoice?: ToolChoice;
  /** One tool call per answer at most. */
  serialTools: boolean;
  cacheRetention: CacheRetention;
  /** The agent session the call belongs to: its calls share the provider's prompt cache. */
  sessionId?: string;
  /** How many times a call that failed before any piece of its answer came is made again; absent: the connection's setting, else `RETRIES`. */
  retries?: number;
  /** Fields of a passed request sent as they came, where the call speaks the request's own API (OpenAI's chat completions). */
  extras?: JsonObject;
  /** What the loop's options carry to pi-ai as they are. */
  carried: Pick<SimpleStreamOptions, "identity" | "transport" | "maxRetryDelayMs" | "timeoutMs" | "metadata" | "onResponse" | "onProviderStreamEvent" | "onPayload">;
}

/** What a keyless call carries as its key: pi-ai's OpenAI and Anthropic clients need one, and a server that asks for none ignores it. */
const NO_KEY = "none";

/** The way a call on a connection signs: its key, the sign-in (read by pi-ai), or the key-shaped nothing of a keyless server. */
export async function keyOf(book: Book, connection: Connection, kind: ProviderKind): Promise<string | undefined> {
  if (connection.auth === "none") return NO_KEY;
  if (connection.auth === "signin") {
    if ((await book.signin(kind.id)) === undefined) throw new Error(`There is no sign-in to ${kind.name}, which the connection "${connection.name}" uses: sign in on the Connections page.`);
    return undefined;
  }
  const key = await book.key(connection.id);
  if (key === undefined) throw new Error(`The connection "${connection.name}" has no key: add one on the Connections page.`);
  return key;
}

/**
 * The model a call goes to: its provider's catalogue entry where it lists the model, at the address
 * the connection gives where it gives one. A compatible server's model borrows how it reasons, what
 * it takes in and its limits from the catalogue that lists it under the same name (a proxy serves
 * another provider's models); nobody's is a model of unknown limits. `listed` is pi's entry, where
 * pi lists the model.
 */
function modelFor(pi: MutableModels, kind: ProviderKind, connection: Connection, id: string): { model: Model<Api>; listed: Model<Api> | undefined } {
  if (kind.needsBaseUrl) {
    const api = connection.api ?? kind.apis[0];
    const baseUrl = connection.baseUrl ?? "";
    const lent = kind.borrows === undefined ? undefined : pi.getModel(kind.borrows, id);
    if (lent === undefined) return { model: unlistedModel(id, api, kind.id, baseUrl), listed: undefined };
    const { compat, ...rest } = lent;
    // A definition's compatibility flags belong to its API: a server speaking another keeps its own.
    return { model: { ...rest, ...(lent.api === api && compat !== undefined ? { compat } : {}), api, provider: kind.id, baseUrl }, listed: lent };
  }
  const listed = pi.getModel(kind.id, id);
  const model = listed ?? unlistedModel(id, kind.apis[0], kind.id, pi.getProvider(kind.id)?.baseUrl ?? "");
  return { model: connection.baseUrl !== undefined ? { ...model, baseUrl: connection.baseUrl } : model, listed };
}

/** An effort as the level asked of the model; null: the provider's own default. `auto` and `inherit` are the connection's own effort. */
function askedLevel(effort: ModelEffort | undefined, connection: Connection): ModelThinkingLevel | null {
  if (effort === undefined || effort === "inherit" || effort === "auto") return connection.effort ?? null;
  return effort;
}

/** The shape of a call on an agent's choice (`CallShape`). Rejects in words that say what to do when its connection can't be used. */
export async function shapeOf(deps: Pick<CallDeps, "pi" | "book">, choice: AgentChoice): Promise<CallShape> {
  const connection = await deps.book.connection(choice.connectionId);
  if (connection === null) throw new Error(choice.connectionId === null ? "There is no default connection: add one on the Connections page, or pick one for this agent." : "This call's connection is no longer there: pick another on the Connections page.");
  const kind = kindOf(connection.provider);
  if (kind === undefined) throw new Error(`The connection "${connection.name}" names a provider that isn't offered.`);
  const id = choice.model ?? connection.model;
  if (id === undefined || id === "") throw new Error(`The connection "${connection.name}" names no model, and neither does this agent: pick one on the Connections page or in the agent's settings.`);
  const { model: found, listed } = modelFor(deps.pi, kind, connection, id);
  const limits = limitsOf(listed, own(connection.reported, id), own(connection.limits, id));
  // pi-ai fits a call's room to the window, and an Anthropic call's to the longest reply, by these two: they are the limits as resolved, 0 where nobody knows one.
  let model: Model<Api> = { ...found, contextWindow: limits.contextWindow?.tokens ?? 0, maxTokens: limits.maxTokens?.tokens ?? 0 };
  // On OpenAI's two APIs a system message may stand anywhere, as a chat application's custom connection sends it, and a compatible server is sent the `system` role every server knows, not OpenAI's newer `developer`. Both APIs' flags have these fields.
  if (model.api === "openai-completions" || model.api === "openai-responses") model = { ...model, compat: { ...(model.compat as OpenAICompletionsCompat | OpenAIResponsesCompat | undefined), supportsMidConvoSystemMessages: true, ...(kind.needsBaseUrl ? { supportsDeveloperRole: false } : {}) } };
  // Every request carries everything (see the head of this file); a connection that turns threads on gets pi-ai's own default, which is Anthropic's own endpoint alone.
  if (model.api === "anthropic-messages" && connection.messageThreads !== true) model = { ...model, compat: { ...(model.compat as AnthropicMessagesCompat | undefined), supportsMessageThreads: false } };
  const asked = askedLevel(choice.effort, connection);
  if (asked === null) {
    // The provider's own default: pi-ai sends no switch for a level it has no value for.
    return { connection, kind, model: { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } }, limits, reasoning: undefined, providerDefault: true };
  }
  const level = clampThinkingLevel(model, asked);
  return { connection, kind, model, limits, reasoning: level === "off" ? undefined : level, providerDefault: false };
}

/** Sets payload fields from `values`, by the payload's own name for each, leaving out any value that isn't there. */
function setAll(payload: Record<string, unknown>, values: Partial<Record<string, unknown>>, names: Readonly<Record<string, string>>): void {
  for (const [ours, theirs] of Object.entries(names)) if (values[ours] !== undefined) payload[theirs] = values[ours];
}

/** What a call does to the request pi-ai built before it is sent: the sampling parameters its API names its own way, one tool per answer, and the fields a passed request sent. */
interface PayloadChanges {
  sampling: Partial<Record<SamplingName, unknown>>;
  serial: boolean;
  /** The provider's own default effort: pi-ai's switch for Gemini's thinking is taken away, so Gemini decides. */
  providerDefault: boolean;
  thinking: boolean;
  extras: JsonObject | undefined;
}

function changePayload(api: string, payload: unknown, changes: PayloadChanges): unknown {
  if (!isRecord(payload)) return undefined;
  const { sampling, serial, providerDefault, thinking, extras } = changes;
  const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
  switch (api) {
    case "anthropic-messages":
      // Anthropic takes no top_p or top_k while its model thinks.
      if (!thinking) setAll(payload, sampling, { top_p: "top_p", top_k: "top_k" });
      setAll(payload, sampling, { stop: "stop_sequences" });
      if (serial && hasTools) payload.tool_choice = { ...(isRecord(payload.tool_choice) ? payload.tool_choice : { type: "auto" }), disable_parallel_tool_use: true };
      break;
    case "openai-completions":
    case "openai-responses":
      if (serial && hasTools) payload.parallel_tool_calls = false;
      if (api === "openai-completions" && extras !== undefined) for (const [k, v] of Object.entries(extras)) if (!(k in payload)) payload[k] = v;
      break;
    case "google-generative-ai": {
      const config = isRecord(payload.config) ? payload.config : {};
      setAll(config, sampling, { top_p: "topP", top_k: "topK", seed: "seed", stop: "stopSequences" });
      if (providerDefault) delete config.thinkingConfig;
      payload.config = config;
      break;
    }
    case "mistral-conversations":
      setAll(payload, sampling, { top_p: "topP", seed: "randomSeed", stop: "stop", frequency_penalty: "frequencyPenalty", presence_penalty: "presencePenalty" });
      if (serial && hasTools) payload.parallelToolCalls = false;
      break;
  }
  return payload;
}

/** What a failed call says, refined where pi-ai's own words would mislead: a sign-in it couldn't renew, a redirect it was told not to follow. */
function failedWith(message: AssistantMessage, kind: ProviderKind): string {
  const said = message.errorMessage ?? "The model's answer ended in an error, with no words for it.";
  if (/^OAuth (?:refresh|auth derivation) failed\b/.test(said)) return `The ${kind.name} sign-in couldn't be renewed: sign in again on the Connections page.`;
  if (REDIRECT_REFUSED.test(said)) return `The call wasn't made: ${REDIRECT_WORDS}`;
  return failureWords(said);
}

/** A call's watch for silence: told of each sign of life, of the answer's beginning, and let go when the call ends. */
interface SilenceWatch {
  alive(): void;
  begun(): void;
  stop(): void;
}

/** The longest a timer waits in one go: a longer delay overflows to almost none, so a longer wait is taken in turns. */
const LONGEST_TIMER = 2_147_483_647;

/**
 * Watches a call for silence, and calls `silent` once it has lasted `ms` (none at all where `ms`
 * isn't a positive length). The wait starts with the answer, at its first piece of text, of thinking
 * or of a tool call: until then the model may still be reading a long prompt, or thinking where
 * nothing of it is shown, and a slow start is no dead stream. From then on anything from the server
 * is life: any byte of the response (a ping or a keep-alive that pi-ai never passes on among them)
 * and any event pi-ai makes of it.
 */
function silenceWatch(deps: CallDeps, ms: number, silent: () => void): SilenceWatch {
  let started = false;
  let last = 0;
  let timer: unknown;
  const check = (): void => {
    const quiet = deps.now() - last;
    if (quiet >= ms) silent();
    else timer = deps.setTimeout(check, Math.min(ms - quiet, LONGEST_TIMER));
  };
  return {
    alive() {
      last = deps.now();
    },
    begun() {
      if (started || !Number.isFinite(ms) || ms <= 0) return;
      started = true;
      last = deps.now();
      timer = deps.setTimeout(check, Math.min(ms, LONGEST_TIMER));
    },
    stop() {
      deps.clearTimeout(timer);
    },
  };
}

/** What a call's latest request met: the status its server answered with, or that no server was reached. */
interface Wire {
  status?: number;
  unreached?: boolean;
}

/** The fetch a call's client goes out through: it follows no redirect, notes on `wire` what each request met, and hands each piece of the response to `alive` as it passes. */
function callFetch(fetch: typeof globalThis.fetch, wire: Wire, alive: () => void): typeof globalThis.fetch {
  const watched = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(input, { ...init, redirect: "error" });
    } catch (error) {
      // A redirect refused or a stop is no server out of reach.
      const said = error instanceof Error ? `${error.name} ${error.message} ${"code" in error ? String(error.code) : ""}` : String(error);
      wire.unreached = init?.signal?.aborted !== true && !REDIRECT_REFUSED.test(said);
      throw error;
    }
    wire.status = response.status;
    if (response.body === null) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(piece, out) {
          alive();
          out.enqueue(piece);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return Object.assign(watched, { preconnect: fetch.preconnect });
}

/** How many times a call that failed before any piece of its answer came is made again, where its connection doesn't say. */
const RETRIES = 2;
/** The wait before a call is first made again; each wait after is twice the one before. */
const RETRY_WAIT_MS = 1_000;

/** Whether a call that failed before any piece of its answer came may be made again: no server was reached, or it answered 429 or 5xx. */
function mayRetry(wire: Wire, failed: AssistantMessage): boolean {
  if (wire.unreached === true) return true;
  // Google's client goes out through no fetch of the layer's: its status is the one its words lead with.
  const status = wire.status ?? Number(/^(\d{3}):/.exec(failureWords(failed.errorMessage ?? ""))?.[1]);
  return status === 429 || (status >= 500 && status <= 599);
}

/** An answer that ended before anything of it came: the call couldn't be made, or was stopped first. */
function emptyAnswer(model: Model<Api>, stopReason: "error" | "aborted", words: string, at: number): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, errorMessage: words, timestamp: at };
}

/** Ends `out` with an answer that ended in an error or a stop. */
function endWith(out: AssistantMessageEventStream, error: AssistantMessage): void {
  out.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
}

/** The words for a stop the caller's signal made, where it gave its own reason. */
function stopWords(signal: AbortSignal | undefined): string {
  return signal?.reason instanceof Error && signal.reason.message !== "" ? signal.reason.message : "The call was stopped.";
}

const STOPPED = Symbol("stopped");

/**
 * Makes one call (see the head of this file), its events pushed to `out` as they come: whatever
 * happens, `out` ends with a `done` or an `error` event.
 */
export async function makeCall(deps: CallDeps, shape: CallShape, context: TranscriptContext, ask: CallAsk, signal: AbortSignal | undefined, out: AssistantMessageEventStream): Promise<void> {
  const { connection, kind, model, limits } = shape;
  // Ends a call that went silent, beside the caller's own signal, with words that say so.
  const quiet = new AbortController();
  let watch: SilenceWatch | undefined;
  const secrets = (): Promise<string[]> => deps.book.secretValues().catch(() => []);
  /** How an answer that ended in an error or a stop goes on: in the words of whatever ended it. */
  const failure = async (message: AssistantMessage): Promise<AssistantMessage> => {
    if (signal?.aborted === true) return { ...message, content: [...message.content], stopReason: "aborted", errorMessage: message.errorMessage ?? stopWords(signal) };
    // The silence's own words, which hold no secret.
    if (quiet.signal.aborted) return { ...message, content: [...message.content], stopReason: "error", errorMessage: errorWords(quiet.signal.reason) };
    return { ...message, content: [...message.content], stopReason: "error", errorMessage: redact(failedWith(message, kind), await secrets()) };
  };
  try {
    if (signal?.aborted === true) return endWith(out, emptyAnswer(model, "aborted", stopWords(signal), deps.now()));
    const apiKey = await keyOf(deps.book, connection, kind);
    // A call never asks more room than its model can write; with no room asked, the model's longest reply, where anybody knows it.
    const most = limits.maxTokens?.tokens;
    const room = ask.maxTokens !== undefined ? Math.min(ask.maxTokens, most ?? Number.POSITIVE_INFINITY) : most;
    if (room === undefined && model.api === "anthropic-messages") throw new Error(`Nobody has said how long a reply "${model.id}" can write, and Anthropic's API must be told: enter it for the connection "${connection.name}" on the Connections page.`);
    // A level asked is the nearest the model has; none asked is no thinking, or the provider's own default where the agent's effort leaves it to the provider.
    const level = ask.reasoning === undefined ? undefined : clampThinkingLevel(model, ask.reasoning);
    const reasoning = level === undefined || level === "off" ? undefined : level;
    const leftToProvider = ask.reasoning === undefined && shape.providerDefault;
    const openAI = model.api === "openai-completions" || model.api === "openai-responses";
    // An Anthropic model that thinks to a budget gets the budget on top of the room it was asked for; the budget is taken out of the room instead, so the call writes no more than it was allowed.
    let budget: Pick<SimpleStreamOptions, "maxTokens" | "thinkingBudgets"> = room === undefined ? {} : { maxTokens: room };
    const budgetLevel = clampReasoning(reasoning);
    if (room !== undefined && reasoning !== undefined && budgetLevel !== undefined && model.api === "anthropic-messages" && !compatSays(model, "forceAdaptiveThinking")) {
      const thinking = Math.min(ask.thinkingBudgets?.[budgetLevel] ?? DEFAULT_THINKING_BUDGETS[budgetLevel] ?? MIN_ANSWER_TOKENS, room - MIN_ANSWER_TOKENS);
      if (thinking >= MIN_ANSWER_TOKENS) budget = { maxTokens: room - thinking, thinkingBudgets: { [budgetLevel]: thinking } };
    }

    // The sampling parameters its provider takes; the rest are left out. OpenAI's reasoning models refuse a temperature or a top_p.
    const taken: Partial<Record<SamplingName, unknown>> = {};
    for (const name of kind.sampling) if (ask.sampling[name] !== undefined) taken[name] = ask.sampling[name];
    if (model.api === "openai-responses" && model.reasoning) {
      delete taken.temperature;
      delete taken.top_p;
    }
    const { temperature, ...rest } = taken;
    const messages = inPlace(context.messages, keepsSystemInPlace(model), deps.markNote);
    // Under the provider's own default its model may think, so what thinking refuses is left out then too.
    const changes: PayloadChanges = { sampling: openAI ? {} : rest, serial: ask.serialTools, providerDefault: leftToProvider, thinking: reasoning !== undefined || leftToProvider, extras: ask.extras };
    const silentFor = await deps.silentMs();
    const watching = silenceWatch(deps, silentFor, () => quiet.abort(new Error(`The model went silent: nothing came from its server for ${durationWords(silentFor)} after its answer began, so the stream was ended. ${deps.silentSetting()} says how long an answer may go silent.`)));
    watch = watching;
    const ended = signal === undefined ? quiet.signal : AbortSignal.any([signal, quiet.signal]);
    const headers = sentHeaders(connection);
    const theirs = ask.carried.onPayload;
    const wire: Wire = {};
    const options: SimpleStreamOptions = {
      ...ask.carried,
      signal: ended,
      // Google's client takes no fetch but the process's own (pi-ai refuses another), which is why its connections take no address of their own: only pi-ai's events tell of its life.
      ...(model.api === "google-generative-ai" ? {} : { fetch: callFetch(deps.fetch, wire, watching.alive) }),
      ...budget,
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(openAI && Object.keys(rest).length > 0 ? { samplingParams: rest } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(ask.toolChoice !== undefined ? { toolChoice: ask.toolChoice } : {}),
      cacheRetention: ask.cacheRetention,
      ...(ask.sessionId !== undefined ? { sessionId: ask.sessionId } : {}),
      maxRetries: 0,
      // The caller sees the request as it is sent, after the changes, and may replace it.
      onPayload: async (payload, sent) => {
        const changed = changePayload(model.api, payload, changes) ?? payload;
        return (await theirs?.(changed, sent)) ?? changed;
      },
    };

    // The stream ends the moment the signal or the silence does, whether or not pi-ai's own end has come yet.
    const { promise: stopped, resolve: stop } = Promise.withResolvers<typeof STOPPED>();
    if (ended.aborted) stop(STOPPED);
    else ended.addEventListener("abort", () => stop(STOPPED), { once: true });
    /** Ends `out` with `ending`, the silence's wait let go first, so that nothing of the call waits once its answer has ended. */
    const close = (ending: AssistantMessage): void => {
      watching.stop();
      endWith(out, ending);
    };
    /** One go at the call: `out` ended, or the failure of a go that received nothing, which may be made again. */
    const attempt = async (): Promise<AssistantMessage | undefined> => {
      const events = deps.pi.streamSimple(model, { messages }, options);
      const iterator = events[Symbol.asyncIterator]();
      /** The answer as far as it came. */
      let partial: AssistantMessage | undefined;
      // pi-ai's `start` is held until something of the answer comes, so that a call made again never begins its answer twice.
      let start: AssistantMessageEvent | undefined;
      let received = false;
      const receive = (): void => {
        if (received) return;
        received = true;
        if (start !== undefined) out.push(start);
      };
      for (;;) {
        const next = await Promise.race([iterator.next(), stopped]);
        if (next === STOPPED) {
          void iterator.return?.();
          close(await failure(partial ?? emptyAnswer(model, "aborted", stopWords(signal), deps.now())));
          return undefined;
        }
        if (next.done === true) break;
        const event = next.value;
        watching.alive();
        // The answer has begun: a piece of text, of thinking or of a tool call, or a tool call given whole.
        if (event.type === "toolcall_start" || ((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") && event.delta !== "")) watching.begun();
        if (event.type === "error") {
          if (!received) return event.error;
          close(await failure(event.error));
          return undefined;
        }
        if ("partial" in event) partial = event.partial;
        if (event.type === "start" && !received) {
          start = event;
          continue;
        }
        receive();
        if (event.type === "done") watching.stop();
        out.push(event);
        if (event.type === "done") return undefined;
      }
      const result = await events.result();
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        if (!received) return result;
        close(await failure(result));
        return undefined;
      }
      receive();
      watching.stop();
      out.end(result);
      return undefined;
    };

    const retries = ask.retries ?? connection.retries ?? RETRIES;
    for (let tried = 0; ; tried += 1) {
      delete wire.status;
      delete wire.unreached;
      const failed = await attempt();
      if (failed === undefined) return;
      if (tried >= retries || ended.aborted || !mayRetry(wire, failed)) return endWith(out, await failure(failed));
      const { promise: waited, resolve: wake } = Promise.withResolvers<void>();
      const timer = deps.setTimeout(wake, RETRY_WAIT_MS * 2 ** tried);
      const woke = await Promise.race([waited, stopped]);
      deps.clearTimeout(timer);
      if (woke === STOPPED) return endWith(out, await failure(emptyAnswer(model, "aborted", stopWords(signal), deps.now())));
    }
  } catch (error) {
    if (signal?.aborted === true) return endWith(out, emptyAnswer(model, "aborted", stopWords(signal), deps.now()));
    // Whatever words leave here, no key, token or header's value the layer holds is in them.
    endWith(out, emptyAnswer(model, "error", redact(errorWords(error), await secrets()), deps.now()));
  } finally {
    watch?.stop();
  }
}

/** The sampling a stream function's options ask for, by its usual names: `temperature`, and the rest in `samplingParams`. */
function samplingOf(options: SimpleStreamOptions): Sampling {
  const out: Sampling = {};
  const params = options.samplingParams ?? {};
  for (const name of SAMPLING_NAMES) {
    const value = name === "temperature" && options.temperature !== undefined ? options.temperature : params[name];
    if (name === "stop") {
      const stop = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
      if (stop.length > 0) out.stop = stop;
    } else if (typeof value === "number" && Number.isFinite(value)) Object.assign(out, { [name]: value });
  }
  return out;
}

/** What pi's loop asks of a call, from the options it hands its stream function. */
function askOf(options: SimpleStreamOptions, shape: CallShape): CallAsk {
  const { identity, transport, maxRetryDelayMs, timeoutMs, metadata, onResponse, onProviderStreamEvent, onPayload } = options;
  const carried = Object.fromEntries(Object.entries({ identity, transport, maxRetryDelayMs, timeoutMs, metadata, onResponse, onProviderStreamEvent, onPayload }).filter(([, v]) => v !== undefined)) as CallAsk["carried"];
  return {
    ...(isTokenCount(options.maxTokens) ? { maxTokens: options.maxTokens } : {}),
    ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    ...(options.thinkingBudgets !== undefined ? { thinkingBudgets: options.thinkingBudgets } : {}),
    sampling: samplingOf(options),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    serialTools: shape.connection.serialTools === true,
    // pi-ai's own default retention, said here so that nothing of the environment's changes it.
    cacheRetention: options.cacheRetention ?? "short",
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    carried,
  };
}

/**
 * pi's stream function over the layer's calls (see the head of this file). The model it is handed
 * must be one the layer made for an agent (`choiceOf`): the call is shaped from that agent's choice
 * as the connection stands at the time of the call, so a key, a model or a limit changed since takes
 * effect at once.
 */
export function streamFunction(deps: CallDeps, choiceOf: (model: Model<Api>) => AgentChoice | undefined): StreamFn {
  return (model, context, options = {}) => {
    const out = createAssistantMessageEventStream();
    const choice = choiceOf(model);
    void (async () => {
      try {
        if (choice === undefined) throw new Error("This model wasn't made by the model layer, so the call has no connection to go on: ask the layer for the agent's model.");
        const shape = await shapeOf(deps, choice);
        await makeCall(deps, shape, context, askOf(options, shape), options.signal, out);
      } catch (error) {
        endWith(out, emptyAnswer(model, options.signal?.aborted === true ? "aborted" : "error", errorWords(error), deps.now()));
      }
    })();
    return out;
  };
}
