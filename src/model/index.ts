// RPH's model layer (STANDALONE-PLAN §13.2): every model call an agent makes, and every request
// passed through, goes straight to its provider through pi-ai, on the user's own connections.
// `createModelLayer` gives:
//
// - for each agent, the model pi's `Agent` runs on, the level it thinks at and the stream function
//   it calls its model through (`agentModel`, `streamFn`); each call is shaped from the agent's
//   connection as it stands at the time of the call;
// - the host's way in (the contract's `ModelsApi`): the connections as the Connections page keeps
//   them, a connection's test call and its models, each model's limits, the sign-ins to Anthropic
//   and OpenAI, and requests passed through;
// - the end of an agent session's prompt cache (`ended`).
//
// What the layer is handed (`ModelLayerDeps`) is everything it reaches the world through: where the
// host keeps the connections and their secrets, the clock, ids, timers, `fetch`, the log, the
// environment it takes the SDKs' own settings out of, its three waits (how long an answer may go
// silent, how long a provider may take to answer a test or list its models, how long a sign-in
// stays open), each read as it is used so a change of its setting holds from the next, and the text
// a connection's test sends, which comes from a shipped file like every text sent to a model.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { cleanupSessionResources, createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConnectionView, ModelChoice, ModelLimitsEntry, ModelsApi, ModelsPort, StoredConnection } from "../contract";
import { Book, sentHeaders } from "./book";
import type { CallDeps } from "./call";
import { makeCall, shapeOf, streamFunction } from "./call";
import { isRecord } from "./json";
import { KINDS, builtInProviders, kindOf } from "./kinds";
import { reportedOf } from "./limits";
import { passRequest } from "./pass";
import { createSignIn } from "./signin";
import type { AgentChoice, ModelSource } from "./source";
import { REDIRECT_REFUSED, REDIRECT_WORDS, durationWords, errorWords, failureWords, redact } from "./words";

export type { AgentChoice, AgentModel, ModelEffort, ModelSource } from "./source";
export { DEFAULT_CHARS_PER_TOKEN, callUsage, estimateOf, messageText, promptTokens, tokensOf } from "./tokens";
export type { CallUsage, UsageEstimate, UsageField } from "./tokens";
export { inPlace, keepsSystemInPlace } from "./transcript";
export { limitsOf } from "./limits";

/** The layer's waits, each a setting of the host's. */
export type ModelWait = "silentMs" | "askMs" | "signInMs";

export interface ModelLayerDeps {
  /** Where the host keeps the connections and their secrets. */
  store: ModelsPort;
  now(): number;
  /** A new id: a connection's, a sign-in flow's. */
  id(): string;
  /** A new random UUID: this installation's id for OpenAI's sign-in, made once and kept. */
  uuid(): string;
  log(text: string): void;
  /** How HTTP goes out: a provider's calls, where pi-ai's client for its API takes it, and a server's list of models. */
  fetch: typeof globalThis.fetch;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** The name the app goes by where a sign-in shows one (OpenAI's page). */
  appName: string;
  /** The text a connection's test call sends: read from a shipped file. */
  testPrompt(): Promise<string>;
  /** pi-ai providers that stand in for the built-in ones of the same id: tests give pi-ai's faux provider. */
  providers?: readonly Provider[];
  /** The process's environment, `process.env` when not given: what the SDKs under pi-ai would read in it for themselves (`STEERING`) is taken out as the layer is made. */
  env?: Record<string, string | undefined>;
  /** How long an answer that has begun may go with nothing at all from its server before it is ended: `SILENT_MS` when not given, 0 for no limit. */
  silentMs?(): number | Promise<number>;
  /** How long a connection's test call, or a server's list of its models, waits for its answer: `ASK_MS` when not given. */
  askMs?(): number | Promise<number>;
  /** How long a sign-in flow stays open: `SIGN_IN_MS` when not given. */
  signInMs?(): number | Promise<number>;
  /** The words that name a wait's setting and where it is changed, for the words of a wait that ran out: `The setting "<its name>"` when not given. */
  settingWords?(wait: ModelWait): string;
  /** The text a system message is sent as, in its place, where its model takes no system message mid-conversation: from a shipped file's mark. Absent: its own text, unmarked. Never applied to a request passed through. */
  markNote?(text: string): string;
}

export interface ModelLayer extends ModelSource {
  /** pi's stream function for every model `agentModel` makes: the `streamFn` of each agent's `Agent`. */
  streamFn: StreamFn;
  /** The host's way to the layer. */
  api: ModelsApi;
  /** An agent session ended: what pi-ai keeps for its prompt cache (Anthropic's message threads) is let go. */
  ended(sessionId: string): void;
  /** Ends open sign-ins and waits for the documents to be written. */
  close(): Promise<void>;
}

/** The waits' own defaults, where their setting gives none: an answer may go silent 5 minutes, a provider has a minute to answer a test or list its models, a sign-in stays open 10 minutes. */
const SILENT_MS = 5 * 60_000;
const ASK_MS = 60_000;
const SIGN_IN_MS = 10 * 60_000;
/** Each wait's setting, by its name, for words where the host gives none of its own. */
const WAIT_NAMES: Readonly<Record<ModelWait, string>> = { silentMs: 'The setting "Silent answer ends after"', askMs: 'The setting "Provider wait"', signInMs: 'The setting "Sign-in stays open"' };

/** The room a test call gives its answer: enough for any provider's smallest answer (OpenAI asks at least 16), little enough to cost nothing to speak of. */
const TEST_ROOM = 64;
/** The most of a server's list of models read: lists of hundreds of models run to a few megabytes, and an answer without end would otherwise grow until the process is restarted. */
const LIST_MAX = 8 * 1024 * 1024;
/** A key's last four characters are shown for a key long enough that they don't give it away. */
const SHOWN_FROM = 12;

/** pi-ai reads credentials from nowhere but the book: no environment variable, no file of another program's, ever signs a call. */
const NOWHERE = { env: async (): Promise<string | undefined> => undefined, fileExists: async (): Promise<boolean> => false };

/**
 * What the SDKs under pi-ai, and pi-ai itself, read in the environment for themselves, past pi-ai's
 * own lookup (`NOWHERE`): each could sign a call, send it or a sign-in somewhere else, add to what a
 * call carries, or write what it sent to the log. Only the user's connections may decide those, so
 * they are taken out of the environment before anything reads them. Some are read today only where
 * pi-ai passes no value of its own (a key, an address): they go too, so that a pi-ai that stops
 * passing one lets none in.
 */
const STEERING: readonly string[] = [
  // Anthropic's SDK: headers added to every call after its key (an `x-api-key` line replaces the key), its own key, token and address, its log of requests with their headers, and its profiles and workload federation (pi-ai reads the federation's too).
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_LOG",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_SCOPE",
  // OpenAI's SDK, which calls OpenRouter, DeepSeek, Groq, xAI and the compatible servers too: headers added to every call, the organization and project sent with each, its keys and address, its log of requests.
  "OPENAI_CUSTOM_HEADERS",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_LOG",
  // Google's SDK: Vertex AI in place of the Gemini API, another address, its keys.
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  // pi-ai: the address a sign-in's callback listens on, and a prompt cache kept longer than a call asks.
  "PI_OAUTH_CALLBACK_HOST",
  "PI_CACHE_RETENTION",
];

/** A response's body as text, or null when it runs past `max` bytes: no more of it than that is read. */
async function cappedText(response: Response, max: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createModelLayer(deps: ModelLayerDeps): ModelLayer {
  const env = deps.env ?? process.env;
  const steering = STEERING.filter((name) => env[name] !== undefined);
  for (const name of steering) delete env[name];
  // Their names alone: a value may be a credential.
  if (steering.length > 0) deps.log(`took out of the environment what would sign or steer model calls and sign-ins: ${steering.join(", ")}`);
  // pi-ai loads its sign-in flows by a path a single-file bundle can't follow; these load them from the bundle. pi-ai registers all its flows at once (its other providers' too): it has no way to register two alone.
  registerLazyOAuthFlows();
  const settingWords = (wait: ModelWait): string => deps.settingWords?.(wait) ?? WAIT_NAMES[wait];
  const book = new Book({ store: deps.store, log: deps.log });
  const pi = createModels({ credentials: book.credentials, authContext: NOWHERE });
  for (const provider of [...builtInProviders(), ...(deps.providers ?? [])]) pi.setProvider(provider);
  const callDeps: CallDeps = { pi, book, fetch: deps.fetch, now: deps.now, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, silentMs: async () => (await deps.silentMs?.()) ?? SILENT_MS, silentSetting: () => settingWords("silentMs"), ...(deps.markNote !== undefined ? { markNote: deps.markNote } : {}) };
  const signIn = createSignIn({ pi, book, id: deps.id, uuid: deps.uuid, now: deps.now, log: deps.log, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, signInMs: async () => (await deps.signInMs?.()) ?? SIGN_IN_MS, signInSetting: () => settingWords("signInMs"), appName: deps.appName });

  /** Each model `agentModel` made, with the agent's choice it was made for. */
  const made = new WeakMap<Model<Api>, AgentChoice>();
  const streamFn = streamFunction(callDeps, (model) => made.get(model));

  /** A signal the layer's own wait ends after the provider wait (`askMs`, else `ASK_MS`), with words that say what didn't come in time (`late`, given the wait in words) and where that wait is changed; and its timer's release. */
  const deadline = async (late: (wait: string) => string): Promise<{ signal: AbortSignal; clear(): void }> => {
    const ms = (await deps.askMs?.()) ?? ASK_MS;
    const stop = new AbortController();
    const timer = deps.setTimeout(() => stop.abort(new Error(`${late(durationWords(ms))} ${settingWords("askMs")} says how long to wait for it.`)), ms);
    return { signal: stop.signal, clear: () => deps.clearTimeout(timer) };
  };

  const viewOf = async (c: StoredConnection, chosen: string | null): Promise<ConnectionView> => {
    const key = c.auth === "key" ? await book.key(c.id) : undefined;
    const { headers, ...shown } = c;
    return {
      ...shown,
      ...(headers !== undefined ? { headers: Object.entries(headers).map(([name, value]) => ({ name, set: value !== null })) } : {}),
      default: c.id === chosen,
      key: c.auth === "key" ? { set: key !== undefined, last4: key !== undefined && key.length >= SHOWN_FROM ? key.slice(-4) : null } : null,
      ...(c.auth === "signin" ? { signedIn: (await book.signin(c.provider)) !== undefined } : {}),
    };
  };

  /**
   * A compatible server's own list of its models (`GET …/models`, Anthropic's under `/v1`), with what
   * it says of each one's limits: no redirect followed, since its key and headers would go with it,
   * and no more of it read than `LIST_MAX`.
   */
  const serverModels = async (c: StoredConnection, api: string): Promise<(ModelChoice & { reported: ModelLimitsEntry })[]> => {
    const key = c.auth === "key" ? await book.key(c.id) : undefined;
    const anthropic = api === "anthropic-messages";
    const signs: Record<string, string> = key === undefined ? {} : anthropic ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
    const wait = await deadline((ms) => `it didn't answer within ${ms}.`);
    try {
      const response = await deps.fetch(`${c.baseUrl ?? ""}${anthropic ? "/v1/models" : "/models"}`, { headers: { accept: "application/json", ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}), ...signs, ...sentHeaders(c) }, redirect: "error", signal: wait.signal });
      const text = await cappedText(response, LIST_MAX);
      if (text === null) throw new Error(`${response.ok ? "" : `${response.status}: `}its answer is larger than ${LIST_MAX / 1024 / 1024} MB, more than is read.`);
      if (!response.ok) throw new Error(failureWords(`${response.status}: ${text}`));
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Said plainly: the parser's own words quote whatever the server sent.
        throw new Error("its answer isn't JSON.");
      }
      const list: unknown[] = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : isRecord(body) && Array.isArray(body.models) ? body.models : [];
      return list.flatMap((m) => {
        if (!isRecord(m) || typeof m.id !== "string") return [];
        const name = typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : m.id;
        return [{ id: m.id, name, reported: reportedOf(m) }];
      });
    } catch (error) {
      const words = errorWords(wait.signal.aborted ? wait.signal.reason : error);
      throw new Error(redact(`The server didn't list its models: ${REDIRECT_REFUSED.test(words) ? REDIRECT_WORDS : words}`, await book.secretValues()));
    } finally {
      wait.clear();
    }
  };

  const api: ModelsApi = {
    async list() {
      const chosen = await book.defaultId();
      const views = await Promise.all((await book.connections()).map((c) => viewOf(c, chosen)));
      return { connections: views, default: chosen, providers: KINDS.map((k) => ({ id: k.id, name: k.name, auth: [...k.auth], apis: [...k.apis], needsBaseUrl: k.needsBaseUrl })) };
    },
    async save(input, key) {
      const saved = await book.save(input, key, deps.id);
      return viewOf(saved, await book.defaultId());
    },
    remove: (id) => book.remove(id),
    setDefault: (id) => book.setDefault(id),
    async test(id, signal) {
      const t0 = deps.now();
      const wait = await deadline((ms) => `The provider didn't answer within ${ms}.`);
      const ended = signal === undefined ? wait.signal : AbortSignal.any([signal, wait.signal]);
      try {
        const shape = await shapeOf(callDeps, { connectionId: id, model: null, effort: "off" });
        const context = normalizeContext({ messages: [{ role: "user", content: await deps.testPrompt(), timestamp: deps.now() }] });
        const out = createAssistantMessageEventStream();
        // A test says how the connection stands now: it is never made again.
        await makeCall(callDeps, shape, context, { maxTokens: TEST_ROOM, sampling: {}, serialTools: false, cacheRetention: "none", retries: 0, carried: {} }, ended, out);
        const result = await out.result();
        if (result.stopReason !== "error" && result.stopReason !== "aborted") return { ok: true, ms: deps.now() - t0, model: result.responseModel ?? result.model };
        return { ok: false, ms: deps.now() - t0, error: wait.signal.aborted ? errorWords(wait.signal.reason) : (result.errorMessage ?? "") };
      } catch (error) {
        return { ok: false, ms: deps.now() - t0, error: errorWords(error) };
      } finally {
        wait.clear();
      }
    },
    async models(connectionId) {
      const c = await book.connection(connectionId);
      if (c === null) throw new Error(connectionId === null ? "There is no default connection to list models for." : "That connection is no longer there: reload the page.");
      const kind = kindOf(c.provider);
      if (kind === undefined) throw new Error(`The connection "${c.name}" names a provider that isn't offered.`);
      if (!kind.needsBaseUrl) return pi.getModels(kind.id).map((m) => ({ id: m.id, name: m.name }));
      const listed = await serverModels(c, c.api ?? kind.apis[0]);
      // What the server says of each model's limits is kept with the connection, for a model pi doesn't know.
      await book.noteReported(c.id, Object.fromEntries(listed.filter((m) => Object.keys(m.reported).length > 0).map((m) => [m.id, m.reported])));
      return listed.map(({ id, name }) => ({ id, name }));
    },
    async limits(connectionId, model) {
      return (await shapeOf(callDeps, { connectionId, model: model ?? null })).limits;
    },
    signIn,
    pass: (request, sink, signal) => passRequest(callDeps, request, sink, signal),
  };

  return {
    streamFn,
    async agentModel(choice) {
      const shape = await shapeOf(callDeps, choice);
      // A model of the agent's own: the stream function knows the agent's choice by it.
      const model: Model<Api> = { ...shape.model };
      made.set(model, { ...choice });
      return { model, thinkingLevel: shape.reasoning ?? "off", streamFn, limits: shape.limits };
    },
    api,
    ended(sessionId) {
      cleanupSessionResources(sessionId);
    },
    async close() {
      signIn.close();
      await book.settled();
    },
  };
}
