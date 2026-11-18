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
// holds. A call that failed before any piece of its answer came is made again here, as many times
// as its connection says (`calls.retries` where it says nothing), after a wait that starts at
// `calls.retryWaitSeconds` and doubles each time, unless its caller says it makes it again itself:
// an agent's run (the runner) does, counting each try as a call against its limits and going on
// from what of the reply was shown, whenever in the call it broke. For it the layer makes the call
// once and tells the run what it knew of the failure (`call_facts`: the status, that no server was
// reached, that its answer went silent, that it was never sent). pi-ai's own retries stay off.
//
// Every request carries everything it is about, so that what an agent was sent can be read back
// whole: Anthropic's message threads, where pi-ai sends a later request only what is new and the
// server keeps the rest, are off unless the connection turns them on.
//
// What leaves with a call goes only where its connection says: the call follows no redirect, since
// its key and headers would go with it to an address nobody gave them for, and neither a key nor a
// header the loop passes in its options is sent. A key and headers' values given for another place
// than the connection now goes to wait for the host's switches (book.ts), and the call isn't made
// until then. Google's calls are the one kind that can't go out through the layer's own fetch, so a
// Google connection takes no address but Google's own (book.ts).
// A stream that goes silent once its answer has begun is ended after `calls.silentAfterSeconds`
// (`silenceWatch`), in words that say so and name that setting. A call is made under its terms, read
// as it is made at its agent's chat's levels, or, with no chat in view, at the levels every chat
// shares: the layer's settings, and its texts (texts.ts). On an Anthropic sign-in the line pi-ai puts
// at the head of the system prompt is replaced by the file's, or taken out where the file gives none;
// a tool answer with no text is given the file's words for it. The session a call names to pi-ai, and
// so to the provider's cache, is the user's session alone (`sessionKey`).
//
// An agent's tools go natively, or as text (tools-text.ts) where its definition says so, or where
// its model's connection refused native tools within `calls.toolRefusalMinutes`: a call refused for
// its native tools is made again at once with them as text. A call whose transcript ends on the
// model's own message (a preset's prefill) is sent so that its provider continues it: on Anthropic's
// API that message goes last as it is; on DeepSeek it is marked `prefix: true` and goes to DeepSeek's
// prefix path, as Lumiverse's own DeepSeek provider sends it; anywhere else it goes as sent.
//
// Each call is held to its connection's throttle (throttle.ts) before it is sent: a place among its
// calls at once, then room in its minute for its estimate (its prompt at `tokens.charsPerToken` and
// its room), each waited for, the agent's run told of the wait; its spend corrects the estimate once
// it ends. A call bigger than its connection's whole minute is not made, and the agent's run is told
// that limit. An agent whose connection is gone runs on the default connection, and its run is told
// of the stand-in (`agentShapeOf`).

import { createHash } from "node:crypto";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AnthropicMessagesCompat, Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, CacheRetention, Message, Model, ModelThinkingLevel, MutableModels, OpenAICompletionsCompat, OpenAIResponsesCompat, SimpleStreamOptions, ThinkingBudgets, ThinkingLevel, ToolChoice, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_BUDGETS, MIN_ANSWER_TOKENS, clampReasoning } from "@earendil-works/pi-ai/api/simple-options";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { JsonObject, ModelLimits, Scope, ToolsAs, UserScope } from "../contract";
import type { ModelSettings } from "../harness/settings";
import { MODELS } from "../harness/settings/models";
import type { Book, Connection } from "./book";
import { isRecord } from "../contract/json";
import { isTokenCount, own } from "./json";
import type { ProviderKind, Sampling, SamplingName } from "./kinds";
import { SAMPLING_NAMES, kindOf, unlistedModel } from "./kinds";
import { limitsOf } from "./limits";
import type { Refusals } from "./refusals";
import type { AgentChoice, LayerEvent, LayerOptions, ModelEffort, UserChoice } from "./source";
import type { Hold, Throttle, Throttles } from "./throttle";
import { askedWait, type FailureFacts, failureOf, retried, retryTermsOf, retryWait } from "./failure";
import { promptTokens } from "./tokens";
import type { ModelTexts } from "./texts";
import { asText, refusesTools, withWrittenCalls } from "./tools-text";
import { levelBelow, refusesEffort } from "./effort";
import { addressed, answered, compatSays, holdsAddress, inPlace, keepsSystemInPlace } from "./transcript";
import { REDIRECT_REFUSED, REDIRECT_WORDS, durationWords, errorWords, failureWords, networkWords, redact, settingWords } from "./words";

export interface CallDeps {
  pi: MutableModels;
  book: Book;
  /** The user the calls are made for: a scope that names him alone reads the levels every chat shares. */
  user: string;
  /** How HTTP goes out, where pi-ai's client for the API takes it. */
  fetch: typeof globalThis.fetch;
  now(): number;
  /** A new id, for a call read back from an answer's text. */
  id(): string;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** The model layer's settings at a scope's levels, read as each call is made. */
  settings(scope: Scope | UserScope): Promise<ModelSettings>;
  /** The model layer's texts at a scope's levels, read as each call is made. */
  texts(scope: Scope | UserScope): Promise<ModelTexts>;
  /** Which of the user's connections' models refused native tools, and when. */
  refusals: Refusals;
  /** The user's connections' throttles: their last minute and their calls at once. */
  throttles: Throttles;
}

/** What a call is made under, read at its scope's levels as it is made: the layer's settings and its texts. */
export interface CallTerms {
  settings: ModelSettings;
  texts: ModelTexts;
}

/** A call's terms at a scope's levels, as they stand now. */
export async function termsOf(deps: Pick<CallDeps, "settings" | "texts">, scope: Scope | UserScope): Promise<CallTerms> {
  const [settings, texts] = await Promise.all([deps.settings(scope), deps.texts(scope)]);
  return { settings, texts };
}

/** The session a call names to pi-ai and the provider's cache: the user's session, never another user's of the same id, and never his name. */
export function sessionKey(user: string, session: string): string {
  return createHash("sha256").update(JSON.stringify([user, session])).digest("hex");
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
  /** The level the choice set (its effort, or the connection's own), before it was fitted to the levels the model has; absent where the provider's own default stands. */
  asked?: ModelThinkingLevel;
  /** The effort is the provider's own default: no switch is sent, and its model may think. */
  providerDefault: boolean;
  /** The connection the agent named is no longer there, and the call goes on the default connection (`used`, by name) with that one's own model. */
  standIn?: { named: string; used: string };
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
  /** How the agent's tools are offered; absent: `auto`. */
  toolsAs?: ToolsAs;
  /** How many times a call that failed before any piece of its answer came is made again here; absent: the connection's own count, else `calls.retries`. An agent's run that makes it again itself sets 0. */
  retries?: number;
  /** What the loop's options carry to pi-ai as they are. */
  carried: Pick<SimpleStreamOptions, "identity" | "transport" | "maxRetryDelayMs" | "timeoutMs" | "metadata" | "onResponse" | "onProviderStreamEvent" | "onPayload">;
  /** Where the agent's run is told of a wait for the connection's throttle, or of the limit it cannot be made within; absent: nobody is told. */
  heard?(event: LayerEvent): void;
}

/** A connection's throttle as the user's settings give it, each figure by the connection's id, else its name; its calls at once its own, else every connection's. */
export function throttleOf(settings: ModelSettings, connection: Connection): Throttle {
  const set = settings.throttles.connections;
  const own = [connection.id, connection.name].flatMap((key) => (Object.hasOwn(set, key) ? [set[key]] : []));
  const requestsPerMinute = own.find((t) => t?.requestsPerMinute !== undefined)?.requestsPerMinute;
  const tokensPerMinute = own.find((t) => t?.tokensPerMinute !== undefined)?.tokensPerMinute;
  const atOnce = own.find((t) => t?.atOnce !== undefined)?.atOnce ?? settings.throttles.atOnce;
  return { ...(requestsPerMinute !== undefined ? { requestsPerMinute } : {}), ...(tokensPerMinute !== undefined ? { tokensPerMinute } : {}), ...(atOnce !== undefined ? { atOnce } : {}) };
}

/** What a keyless call carries as its key: pi-ai's OpenAI and Anthropic clients need one, and a server that asks for none ignores it. */
const NO_KEY = "none";

/**
 * How a call on a connection signs, and the headers it sends: its key, the sign-in (read by pi-ai),
 * or the key-shaped nothing of a keyless server; and its headers' values. What waits for the host's
 * switches (book.ts) keeps the call from being made, in words that say so.
 */
export async function signingOf(book: Book, connection: Connection, kind: ProviderKind): Promise<{ apiKey: string | undefined; headers: Record<string, string> | undefined }> {
  if (connection.auth === "signin" && (await book.signin(kind.id)) === undefined) throw new Error(`There is no sign-in to ${kind.name}, which the connection "${connection.name}" uses: sign in on the Connections page.`);
  const signing = await book.signing(connection);
  if ("waits" in signing) throw new Error(signing.waits);
  if (connection.auth === "none") return { apiKey: NO_KEY, headers: signing.headers };
  if (connection.auth === "signin") return { apiKey: undefined, headers: signing.headers };
  if (signing.key === undefined) throw new Error(`The connection "${connection.name}" has no key: add one on the Connections page.`);
  return { apiKey: signing.key, headers: signing.headers };
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

/** The shape of a call on a choice (`CallShape`). Rejects in words that say what to do when its connection can't be used. */
export async function shapeOf(deps: Pick<CallDeps, "pi" | "book">, choice: AgentChoice): Promise<CallShape> {
  const connection = await deps.book.connection(choice.connectionId);
  if (connection === null) throw new Error(choice.connectionId === null ? "There is no default connection: add one on the Connections page, or pick one for this agent." : "This call's connection is no longer there: pick another on the Connections page.");
  const kind = kindOf(connection.provider);
  if (kind === undefined) throw new Error(`The connection "${connection.name}" names a provider that isn't offered.`);
  const id = choice.model ?? connection.model;
  if (id === undefined || id === "") throw new Error(`The connection "${connection.name}" names no model, and neither does this agent: pick one on the Connections page or in the agent's settings.`);
  const { model: found, listed } = modelFor(deps.pi, kind, connection, id);
  const limits = limitsOf(listed, own(connection.reported, id), own(connection.limits, id));
  // pi-ai fits a call's room to the window, and an Anthropic call's to the longest reply, by these two: they are the limits as resolved, 0 where nobody knows one. It takes pictures where someone said it does.
  let model: Model<Api> = { ...found, contextWindow: limits.contextWindow?.tokens ?? 0, maxTokens: limits.maxTokens?.tokens ?? 0, input: limits.pictures?.takes === true ? ["text", "image"] : ["text"] };
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
  return { connection, kind, model, limits, reasoning: level === "off" ? undefined : level, asked, providerDefault: false };
}

/**
 * The shape of an agent's call. Where the connection its definition names is no longer there, the
 * default connection stands in, with the default's own model, as today's build ran it (LumiAH
 * provider.ts:925-957); with no default either, it rejects in words that say so.
 */
export async function agentShapeOf(deps: Pick<CallDeps, "pi" | "book">, choice: AgentChoice): Promise<CallShape> {
  if (choice.connectionId === null || (await deps.book.connection(choice.connectionId)) !== null) return shapeOf(deps, choice);
  const standIn = await deps.book.connection(null);
  if (standIn === null) throw new Error(`The connection "${choice.connectionId}" this agent runs on is no longer there, and there is no default connection to run it on instead: add one, or pick another for this agent, on the Connections page.`);
  return { ...(await shapeOf(deps, { ...choice, connectionId: null, model: null })), standIn: { named: choice.connectionId, used: standIn.name } };
}

/** The unit `calls.toolRefusalMinutes` is in. */
const MINUTE_MS = 60_000;

/** DeepSeek's own host: a call there that continues the model's message goes to its prefix path, a beta of DeepSeek's. */
const DEEPSEEK_HOST = "api.deepseek.com";

/** A DeepSeek model at its prefix path where it is at DeepSeek's own address, as Lumiverse's DeepSeek provider sends a prefix; a proxy's address, or one already on the path, as it is. */
function onPrefixPath(model: Model<Api>): Model<Api> {
  const url = URL.parse(model.baseUrl);
  return url?.hostname === DEEPSEEK_HOST ? { ...model, baseUrl: `${url.origin}/beta` } : model;
}

/** Sets payload fields from `values`, by the payload's own name for each, leaving out any value that isn't there. */
function setAll(payload: Record<string, unknown>, values: Partial<Record<string, unknown>>, names: Readonly<Record<string, string>>): void {
  for (const [ours, theirs] of Object.entries(names)) if (values[ours] !== undefined) payload[theirs] = values[ours];
}

/** What a call does to the request pi-ai built before it is sent: the sampling parameters its API names its own way, one tool per answer, the fields a passed request sent, the sign-in line, DeepSeek's prefix mark, and pictures given by address sent by it. */
interface PayloadChanges {
  sampling: Partial<Record<SamplingName, unknown>>;
  serial: boolean;
  /** The provider's own default effort: pi-ai's switch for Gemini's thinking is taken away, so Gemini decides. */
  providerDefault: boolean;
  thinking: boolean;
  /** Nobody knows how long a reply the model can write and the call asked for no room: the cap pi-ai fills in on its own (one token, for a model with no limit) is taken out, so the provider's own default stands. */
  uncapped: boolean;
  /** A call on an Anthropic sign-in: the line pi-ai puts first in the system prompt is this one, or none where it is undefined. */
  signin?: { line: string | undefined };
  /** A call to DeepSeek whose transcript ends on the model's own message: that message is marked for DeepSeek to continue it, carrying the thinking it continues only where it has some, as Lumiverse sends one. */
  prefix: boolean;
  /** The transcript holds a picture given by its web address (`PICTURE_ADDRESS`): each is sent by that address. */
  addresses: boolean;
}

function changePayload(api: string, payload: unknown, changes: PayloadChanges): unknown {
  if (!isRecord(payload)) return undefined;
  const { sampling, serial, providerDefault, thinking, uncapped, signin, prefix, addresses } = changes;
  if (addresses) addressed(payload);
  const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
  switch (api) {
    case "anthropic-messages":
      // Anthropic takes no top_p or top_k while its model thinks.
      if (!thinking) setAll(payload, sampling, { top_p: "top_p", top_k: "top_k" });
      setAll(payload, sampling, { stop: "stop_sequences" });
      if (serial && hasTools) payload.tool_choice = { ...(isRecord(payload.tool_choice) ? payload.tool_choice : { type: "auto" }), disable_parallel_tool_use: true };
      // pi-ai puts its own line first on a sign-in's request (it signs the request as Claude Code's): the file's stands in its place.
      if (signin !== undefined && Array.isArray(payload.system) && isRecord(payload.system[0])) {
        if (signin.line !== undefined) payload.system[0] = { ...payload.system[0], text: signin.line };
        else payload.system.shift();
        if (payload.system.length === 0) delete payload.system;
      }
      break;
    case "openai-completions":
    case "openai-responses":
      if (uncapped) for (const cap of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) delete payload[cap];
      if (serial && hasTools) payload.parallel_tool_calls = false;
      if (prefix && Array.isArray(payload.messages)) {
        const last: unknown = payload.messages.at(-1);
        if (isRecord(last) && last.role === "assistant") {
          last.prefix = true;
          if (last.reasoning_content === "") delete last.reasoning_content;
        }
      }
      break;
    case "google-generative-ai": {
      const config = isRecord(payload.config) ? payload.config : {};
      setAll(config, sampling, { top_p: "topP", top_k: "topK", seed: "seed", stop: "stopSequences" });
      if (providerDefault) delete config.thinkingConfig;
      if (uncapped) delete config.maxOutputTokens;
      payload.config = config;
      break;
    }
    case "mistral-conversations":
      if (uncapped) delete payload.maxTokens;
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
 * Watches a call for silence, and calls `silent` once it has lasted `ms` (none at all where `ms` is
 * none: `calls.silentAfterSeconds` set to no limit). The wait starts with the answer, at its first piece of
 * text, of thinking or of a tool call: until then the model may still be reading a long prompt, or
 * thinking where nothing of it is shown, and a slow start is no dead stream. From then on anything
 * from the server is life: any byte of the response (a ping or a keep-alive that pi-ai never passes
 * on among them) and any event pi-ai makes of it.
 */
function silenceWatch(deps: CallDeps, ms: number | undefined, silent: (ms: number) => void): SilenceWatch {
  if (ms === undefined) return { alive() {}, begun() {}, stop() {} };
  const wait = ms;
  let started = false;
  let last = 0;
  let timer: unknown;
  const check = (): void => {
    const quiet = deps.now() - last;
    if (quiet >= wait) silent(wait);
    else timer = deps.setTimeout(check, Math.min(wait - quiet, LONGEST_TIMER));
  };
  return {
    alive() {
      last = deps.now();
    },
    begun() {
      if (started) return;
      started = true;
      last = deps.now();
      timer = deps.setTimeout(check, Math.min(wait, LONGEST_TIMER));
    },
    stop() {
      deps.clearTimeout(timer);
    },
  };
}

/** What a call's latest request met: the status its server answered with, that no server was reached, or a redirect refused. */
interface Wire {
  status?: number;
  unreached?: boolean;
  /** The server answered with a redirect, which is never followed: the call wasn't made. */
  redirected?: boolean;
  /** The wait a failed request's response asked for before the next try, in milliseconds. */
  asked?: number;
}

/** The fetch a call's client goes out through: it follows no redirect, notes on `wire` what each request met, and hands each piece of the response to `alive` as it passes. */
function callFetch(fetch: typeof globalThis.fetch, wire: Wire, alive: () => void, now: () => number): typeof globalThis.fetch {
  const watched = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(input, { ...init, redirect: "error" });
    } catch (error) {
      // A redirect refused or a stop is no server out of reach.
      const said = error instanceof Error ? `${error.name} ${error.message} ${"code" in error ? String(error.code) : ""}` : String(error);
      const redirected = REDIRECT_REFUSED.test(said);
      if (redirected) wire.redirected = true;
      wire.unreached = init?.signal?.aborted !== true && !redirected;
      throw error;
    }
    wire.status = response.status;
    const asked = response.status >= 400 ? askedWait(response.headers, now()) : undefined;
    if (asked !== undefined) wire.asked = asked;
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
 * Makes one call (see the head of this file) under its terms as its caller read them, its events
 * pushed to `out` as they come: whatever happens, `out` ends with a `done` or an `error` event.
 */
export async function makeCall(deps: CallDeps, shape: CallShape, context: TranscriptContext, ask: CallAsk, terms: CallTerms, signal: AbortSignal | undefined, out: AssistantMessageEventStream): Promise<void> {
  const { settings, texts } = terms;
  const { connection, kind, model, limits } = shape;
  // Ends a call that went silent, beside the caller's own signal, with words that say so.
  const quiet = new AbortController();
  let watch: SilenceWatch | undefined;
  /** Its hold on its connection's throttle, and what it spent as its provider reported it, which the hold settles with. */
  let hold: Hold | undefined;
  let spent: number | undefined;
  const spending = (answer: AssistantMessage): void => {
    const { input, cacheRead, cacheWrite, output } = answer.usage;
    if (input + cacheRead + cacheWrite + output > 0) spent = input + cacheRead + cacheWrite + output;
  };
  const secrets = (): Promise<string[]> => deps.book.secretValues().catch(() => []);
  /** How an answer that ended in an error or a stop goes on: in the words of whatever ended it. */
  const failure = async (message: AssistantMessage): Promise<AssistantMessage> => {
    if (signal?.aborted === true) return { ...message, content: [...message.content], stopReason: "aborted", errorMessage: message.errorMessage ?? stopWords(signal) };
    // The silence's own words, which hold no secret.
    if (quiet.signal.aborted) return { ...message, content: [...message.content], stopReason: "error", errorMessage: errorWords(quiet.signal.reason) };
    return { ...message, content: [...message.content], stopReason: "error", errorMessage: redact(failedWith(message, kind), await secrets(), settings) };
  };
  /** What its latest request met; and whether a request went out at all, so a failure before one is a call never made. */
  const wire: Wire = {};
  let sending = false;
  /** What the layer knew of the latest request's failure besides its words. */
  const factsOf = (): FailureFacts => ({
    ...(wire.status !== undefined ? { status: wire.status } : {}),
    ...(wire.unreached === true ? { unreached: true } : {}),
    ...(quiet.signal.aborted ? { silent: true } : {}),
    ...(!sending || wire.redirected === true ? { unmade: true } : {}),
    ...(wire.asked !== undefined ? { asked: wire.asked } : {}),
    ...(connection.retries !== undefined ? { retries: connection.retries } : {}),
  });
  /** Just before its answer ends in a failure, the run is told what the layer knew of it (`call_facts`), so it can sort it and decide whether to make it again. */
  const report = (ending: AssistantMessage): void => {
    if (ending.stopReason === "error") ask.heard?.({ kind: "call_facts", facts: factsOf() });
  };
  try {
    if (signal?.aborted === true) return endWith(out, emptyAnswer(model, "aborted", stopWords(signal), deps.now()));
    const { apiKey, headers } = await signingOf(deps.book, connection, kind);
    // A call never asks more room than its model can write; with no room asked, the model's longest reply, where anybody knows it.
    const most = limits.maxTokens?.tokens;
    const room = ask.maxTokens !== undefined ? Math.min(ask.maxTokens, most ?? Number.POSITIVE_INFINITY) : most;
    if (room === undefined && model.api === "anthropic-messages") throw new Error(`Nobody has said how long a reply "${model.id}" can write, and Anthropic's API must be told: enter it for the connection "${connection.name}" on the Connections page.`);
    // A level asked is the nearest the model has; none asked is no thinking, or the provider's own default where the agent's effort leaves it to the provider.
    // A level its provider refused for this model within the set time is passed over for the next one down it has, and the agent's run is told (effort.ts).
    const asked = ask.reasoning === undefined ? undefined : clampThinkingLevel(model, ask.reasoning);
    const refusedAt = (at: ModelThinkingLevel): string => JSON.stringify([connection.id, model.id, at]);
    let level = asked;
    while (level !== undefined && level !== "off" && deps.refusals.stands(refusedAt(level), deps.now(), settings.effortRefusalMinutes * MINUTE_MS)) level = levelBelow(model, level);
    let reasoning = level === undefined || level === "off" ? undefined : level;
    const leftToProvider = ask.reasoning === undefined && shape.providerDefault;
    const openAI = model.api === "openai-completions" || model.api === "openai-responses";
    // An Anthropic model that thinks to a budget gets the budget on top of the room it was asked for; the budget is taken out of the room instead, so the call writes no more than it was allowed.
    const budgetAt = (thinksAt: ThinkingLevel | undefined): Pick<SimpleStreamOptions, "maxTokens" | "thinkingBudgets"> => {
      const budgetLevel = clampReasoning(thinksAt);
      if (room !== undefined && thinksAt !== undefined && budgetLevel !== undefined && model.api === "anthropic-messages" && !compatSays(model, "forceAdaptiveThinking")) {
        const thinking = Math.min(ask.thinkingBudgets?.[budgetLevel] ?? DEFAULT_THINKING_BUDGETS[budgetLevel] ?? MIN_ANSWER_TOKENS, room - MIN_ANSWER_TOKENS);
        if (thinking >= MIN_ANSWER_TOKENS) return { maxTokens: room - thinking, thinkingBudgets: { [budgetLevel]: thinking } };
      }
      return room === undefined ? {} : { maxTokens: room };
    };
    const budget = budgetAt(reasoning);

    // The sampling parameters its provider takes; the rest are left out. OpenAI's reasoning models refuse a temperature or a top_p.
    const taken: Partial<Record<SamplingName, unknown>> = {};
    for (const name of kind.sampling) if (ask.sampling[name] !== undefined) taken[name] = ask.sampling[name];
    if (model.api === "openai-responses" && model.reasoning) {
      delete taken.temperature;
      delete taken.top_p;
    }
    const { temperature, ...rest } = taken;
    const given = answered(context.messages, texts.emptyAnswer, texts.picturesAnswer);
    /** The transcript as sent, its tools native or as text. */
    const sent = (toolsText: boolean): Message[] => inPlace(toolsText ? asText(given, texts.toolsText) : given, keepsSystemInPlace(model), texts.markNote);
    // Tools go as text where the agent's definition says so, or where its model's connection refused native tools within the set time.
    const offersTools = getCurrentTools(context.messages).length > 0;
    const refusal = JSON.stringify([connection.id, model.id]);
    let toolsAsText = offersTools && (ask.toolsAs === "text" || (ask.toolsAs !== "native" && deps.refusals.stands(refusal, deps.now(), settings.toolRefusalMinutes * MINUTE_MS)));
    let messages = sent(toolsAsText);
    // A transcript that ends on the model's own message: DeepSeek is asked to continue it, on its prefix path.
    const prefix = kind.id === "deepseek" && context.messages.at(-1)?.role === "assistant";
    const sentTo = prefix ? onPrefixPath(model) : model;
    // Under the provider's own default its model may think, so what thinking refuses is left out then too.
    const changes: PayloadChanges = {
      sampling: openAI ? {} : rest,
      serial: ask.serialTools,
      providerDefault: leftToProvider,
      thinking: reasoning !== undefined || leftToProvider,
      uncapped: room === undefined,
      ...(connection.auth === "signin" && model.api === "anthropic-messages" ? { signin: { line: texts.signinLine } } : {}),
      prefix,
      addresses: holdsAddress(context.messages),
    };
    const watching = silenceWatch(deps, settings.silentAfter, (silentFor) => quiet.abort(new Error(`The model went silent: nothing came from its server for ${durationWords(silentFor)} after its answer began, so the stream was ended. ${settingWords(MODELS.silentAfter)} says how long an answer may go silent.`)));
    watch = watching;
    const ended = signal === undefined ? quiet.signal : AbortSignal.any([signal, quiet.signal]);
    const theirs = ask.carried.onPayload;
    const options: SimpleStreamOptions = {
      ...ask.carried,
      signal: ended,
      // Google's client takes no fetch but the process's own (pi-ai refuses another), which is why its connections take no address of their own: only pi-ai's events tell of its life.
      ...(model.api === "google-generative-ai" ? {} : { fetch: callFetch(deps.fetch, wire, watching.alive, deps.now) }),
      ...budget,
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(openAI && Object.keys(rest).length > 0 ? { samplingParams: rest } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(ask.toolChoice !== undefined && !toolsAsText ? { toolChoice: ask.toolChoice } : {}),
      cacheRetention: ask.cacheRetention,
      ...(ask.sessionId !== undefined ? { sessionId: sessionKey(deps.user, ask.sessionId) } : {}),
      maxRetries: 0,
      // The caller sees the request as it is sent, after the changes, and may replace it.
      onPayload: async (payload, sent) => {
        const changed = changePayload(model.api, payload, changes) ?? payload;
        return (await theirs?.(changed, sent)) ?? changed;
      },
    };
    // The call goes at a lower level than it asked, where its provider refused that one: its budget with it, and the agent's run is told.
    const lowered = (to: ModelThinkingLevel): void => {
      level = to;
      reasoning = to === "off" ? undefined : to;
      changes.thinking = reasoning !== undefined || leftToProvider;
      delete options.reasoning;
      delete options.thinkingBudgets;
      Object.assign(options, budgetAt(reasoning), reasoning !== undefined ? { reasoning } : {});
      if (asked !== undefined) ask.heard?.({ kind: "effort_lowered", connection: connection.name, model: model.id, asked, sent: to });
    };
    if (asked !== undefined && level !== undefined && level !== asked) lowered(level);

    // Its connection's throttle: a place among its calls at once, then room in its minute, each waited for; the agent's run is told of each wait. A call bigger than the whole minute is not made, and the run is told that limit.
    const waited = (wait: "minute" | "place"): (() => void) => {
      const since = deps.now();
      ask.heard?.({ kind: "connection_wait", connection: connection.name, for: wait });
      return () => ask.heard?.({ kind: "connection_wait", connection: connection.name, for: wait, ms: deps.now() - since });
    };
    const throttled = await deps.throttles.take(connection.id, throttleOf(settings, connection), promptTokens(messages, settings.charsPerToken) + (budget.maxTokens ?? 0), ended, waited);
    if (throttled === undefined) return endWith(out, await failure(emptyAnswer(model, "aborted", stopWords(signal), deps.now())));
    if ("tooBig" in throttled) {
      const { max, value } = throttled.tooBig;
      ask.heard?.({ kind: "limit", hit: { limit: "tokensPerMinute", per: "connection", max, value, connection: connection.name } });
      throw new Error(`This call comes to about ${value} tokens, more than the ${max} a minute the connection "${connection.name}" takes, so it was not made. ${settingWords(MODELS.tokensPerMinute)} says how many it takes.`);
    }
    hold = throttled.hold;

    // The stream ends the moment the signal or the silence does, whether or not pi-ai's own end has come yet.
    const { promise: stopped, resolve: stop } = Promise.withResolvers<typeof STOPPED>();
    if (ended.aborted) stop(STOPPED);
    else ended.addEventListener("abort", () => stop(STOPPED), { once: true });
    /** Ends `out` with `ending`, the silence's wait let go first, so that nothing of the call waits once its answer has ended. */
    const close = (ending: AssistantMessage): void => {
      watching.stop();
      spending(ending);
      report(ending);
      endWith(out, ending);
    };
    /** One go at the call: `out` ended, or the failure of a go that received nothing, which may be made again. */
    const attempt = async (): Promise<AssistantMessage | undefined> => {
      const events = deps.pi.streamSimple(sentTo, { messages }, options);
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
        if (event.type === "done") {
          watching.stop();
          // Tools as text: the calls the answer's text holds are made its calls.
          const answer = toolsAsText ? withWrittenCalls(event.message, context.messages, deps.id) : event.message;
          spending(answer);
          out.push(answer === event.message ? event : { ...event, reason: "toolUse", message: answer });
          return undefined;
        }
        out.push(event);
      }
      const result = await events.result();
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        if (!received) return result;
        close(await failure(result));
        return undefined;
      }
      receive();
      watching.stop();
      spending(result);
      out.end(toolsAsText ? withWrittenCalls(result, context.messages, deps.id) : result);
      return undefined;
    };

    const retries = ask.retries ?? connection.retries ?? settings.retries;
    const again = retryTermsOf(settings);
    sending = true;
    for (let tried = 0; ; tried += 1) {
      delete wire.status;
      delete wire.unreached;
      delete wire.asked;
      delete wire.redirected;
      const failed = await attempt();
      if (failed === undefined) return;
      // A provider that refuses native tools is sent the same call at once with them as text, and its model is offered them so until the set time has passed.
      if (offersTools && !toolsAsText && ask.toolsAs !== "native" && refusesTools(failed.errorMessage)) {
        deps.refusals.note(refusal, deps.now());
        toolsAsText = true;
        messages = sent(true);
        delete options.toolChoice;
        tried -= 1;
        continue;
      }
      // A provider that refuses the thinking level asked is sent the same call at once at the next level down its model has, `off` at the last; the refused level is passed over until the set time has passed.
      if (level !== undefined && level !== "off" && !ended.aborted && refusesEffort(failed.errorMessage)) {
        deps.refusals.note(refusedAt(level), deps.now());
        lowered(levelBelow(model, level));
        tried -= 1;
        continue;
      }
      // Google's client goes out through no fetch of the layer's: its status is the one its words lead with.
      const broke = failureOf(failureWords(failed.errorMessage ?? ""), factsOf());
      if (ended.aborted || !retried(again, broke, tried, retries)) {
        const ending = await failure(failed);
        report(ending);
        return endWith(out, ending);
      }
      const { promise: waited, resolve: wake } = Promise.withResolvers<void>();
      const timer = deps.setTimeout(wake, retryWait(again, tried, broke.asked));
      const woke = await Promise.race([waited, stopped]);
      deps.clearTimeout(timer);
      if (woke === STOPPED) return endWith(out, await failure(emptyAnswer(model, "aborted", stopWords(signal), deps.now())));
    }
  } catch (error) {
    if (signal?.aborted === true) return endWith(out, emptyAnswer(model, "aborted", stopWords(signal), deps.now()));
    // Whatever words leave here, no key, token or header's value the layer holds is in them; a connection that broke is said in plain words.
    const ending = emptyAnswer(model, "error", redact(networkWords(errorWords(error)), await secrets(), settings), deps.now());
    report(ending);
    endWith(out, ending);
  } finally {
    watch?.stop();
    hold?.settle(spent);
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

/** What pi's loop asks of a call, from the options it hands its stream function and the agent's choice; the prompt cache is kept as `calls.cacheRetention` says. */
function askOf(options: SimpleStreamOptions & LayerOptions, choice: UserChoice, shape: CallShape, settings: ModelSettings): CallAsk {
  const { identity, transport, maxRetryDelayMs, timeoutMs, metadata, onResponse, onProviderStreamEvent, onPayload } = options;
  const carried = Object.fromEntries(Object.entries({ identity, transport, maxRetryDelayMs, timeoutMs, metadata, onResponse, onProviderStreamEvent, onPayload }).filter(([, v]) => v !== undefined)) as CallAsk["carried"];
  return {
    ...(isTokenCount(options.maxTokens) ? { maxTokens: options.maxTokens } : {}),
    ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    ...(options.thinkingBudgets !== undefined ? { thinkingBudgets: options.thinkingBudgets } : {}),
    sampling: samplingOf(options),
    ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
    serialTools: shape.connection.serialTools === true,
    cacheRetention: settings.cacheRetention,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(choice.toolsAs !== undefined ? { toolsAs: choice.toolsAs } : {}),
    ...(options.heard !== undefined ? { heard: options.heard } : {}),
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    carried,
  };
}

/**
 * pi's stream function over the layer's calls (see the head of this file). The model it is handed
 * must be one the layer made for an agent (`choiceOf`): the call is shaped from that agent's choice
 * as the connection stands at the time of the call, so a key, a model or a limit changed since takes
 * effect at once, and made under the terms at its agent's chat's levels as they stand then.
 */
export function streamFunction(deps: CallDeps, choiceOf: (model: Model<Api>) => UserChoice | undefined): StreamFn {
  return (model, context, given = {}) => {
    // The runner's own options ride beside pi-ai's (`LayerOptions`).
    const options: SimpleStreamOptions & LayerOptions = given;
    const out = createAssistantMessageEventStream();
    const choice = choiceOf(model);
    void (async () => {
      try {
        if (choice === undefined) throw new Error("This model wasn't made by the model layer, so the call has no connection to go on: ask the layer for the agent's model.");
        const shape = await agentShapeOf(deps, choice);
        if (shape.standIn !== undefined) options.heard?.({ kind: "connection_stand_in", ...shape.standIn });
        const terms = await termsOf(deps, choice.scope ?? { user: choice.user });
        await makeCall(deps, shape, context, askOf(options, choice, shape, terms.settings), terms, options.signal, out);
      } catch (error) {
        endWith(out, emptyAnswer(model, options.signal?.aborted === true ? "aborted" : "error", errorWords(error), deps.now()));
      }
    })();
    return out;
  };
}
