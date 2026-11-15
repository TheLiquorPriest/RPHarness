// RPH's model layer (STANDALONE-PLAN §13.2): every model call an agent makes, and every request
// passed through, goes straight to its provider through pi-ai, on the user's own connections. Each
// user's connections, keys and sign-ins are his alone (READINGS R-52): the layer keeps a desk for each
// user it acts for (his documents read and kept through the host by his scope, pi-ai's models over
// his sign-ins, his sign-in flows), and every way in names the user. `createModelLayer` gives:
//
// - for each agent, the model pi's `Agent` runs on, the level it thinks at and the stream function
//   it calls its model through (`agentModel`, whose choice names the user the agent acts for); each
//   call is shaped from the agent's connection as it stands at the time of the call;
// - the host's way in (the contract's `ModelsApi`): the connections as the Connections page keeps
//   them, a connection's test call and its models, each model's limits, the sign-ins to Anthropic
//   and OpenAI, and requests passed through, each for the user it names;
// - the end of an agent session's prompt cache (`ended`), the user's session alone;
// - a turn's start (`turnStarting`): the user's connections are read again through the host, so that
//   a hand edit made since holds from the turn's first call.
//
// What the layer is handed (`ModelLayerDeps`) is everything it reaches the world through: where the
// host keeps each user's connections and their secrets, the host's switches (a connection's key and
// headers' values given for another place than it goes to wait on them, book.ts), the clock, ids,
// timers, `fetch`, the log, the environment it takes the SDKs' own settings out of, its settings
// (`calls.*`: its waits, its sizes, its retries and the prompt cache's retention) and its texts
// (texts.ts: the sign-in line, the mark of a system message sent in place, a connection's test, a
// tool answer with no text), each read as it is used so a change holds from the next call. What has
// no chat in view (a connection's test, its list of models, a sign-in, a request passed through)
// reads them at the levels every chat shares; an agent's call reads them at its chat's levels. A desk
// is kept only for a user the host answered for: one whose documents the host refused leaves none.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { cleanupSessionResources, createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConnectionView, ModelChoice, ModelLimitsEntry, ModelsApi, ModelsPort, Scope, SignInApi, Switchable, SwitchesPort, UserScope } from "../contract";
import type { ModelSettings } from "../harness/settings";
import { MODELS } from "../harness/settings/models";
import { promptMessages } from "../harness/prompt";
import type { Connection } from "./book";
import { Book } from "./book";
import type { CallDeps } from "./call";
import { agentShapeOf, makeCall, sessionKey, shapeOf, streamFunction, termsOf } from "./call";
import { isRecord } from "./json";
import { KINDS, builtInProviders, kindOf } from "./kinds";
import { reportedOf } from "./limits";
import { passRequest } from "./pass";
import { Refusals } from "./refusals";
import { Throttles } from "./throttle";
import { createSignIn } from "./signin";
import type { ModelSource, UserChoice } from "./source";
import { promptTokens } from "./tokens";
import type { ModelTexts } from "./texts";
import { REDIRECT_REFUSED, REDIRECT_WORDS, durationWords, errorWords, failureWords, redact, settingWords } from "./words";

export type { AgentChoice, AgentModel, LayerEvent, LayerOptions, ModelEffort, ModelSource, UserChoice } from "./source";
export { callUsage, estimateOf, messageText, promptTokens, requestTokens, tokensOf } from "./tokens";
export type { CallUsage, ProviderCount, UsageEstimate, UsageField } from "./tokens";
export { inPlace, keepsSystemInPlace } from "./transcript";
export { limitsOf } from "./limits";
export { connectionNamed, runOf } from "./runs-on";
export { sessionKey } from "./call";
export { modelTexts, type ModelTexts } from "./texts";

export interface ModelLayerDeps {
  /** Where the host keeps each user's connections and their secrets. */
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
  /** pi-ai providers that stand in for the built-in ones of the same id: tests give pi-ai's faux provider. */
  providers?: readonly Provider[];
  /** The process's environment, `process.env` when not given: what the SDKs under pi-ai would read in it for themselves (`STEERING`) is taken out as the layer is made. */
  env?: Record<string, string | undefined>;
  /**
   * The layer's settings (`calls.*`) at a scope's levels, read as each is used: an agent's call reads
   * them at its chat's levels, and what has no chat in view with a scope that names only the user.
   */
  settings(scope: Scope | UserScope): Promise<ModelSettings>;
  /** The layer's texts at a scope's levels, read as each is used, at the same levels as its settings. A request passed through goes with no mark on a system message in its place. */
  texts(scope: Scope | UserScope): Promise<ModelTexts>;
  /** The host's switches: without them, a key or a header's value that waits (book.ts) is sent nowhere. */
  switches?: SwitchesPort;
}

export interface ModelLayer extends ModelSource {
  /** The host's way to the layer. */
  api: ModelsApi;
  /** One of the user's agent sessions ended: what pi-ai keeps for its prompt cache (Anthropic's message threads) under that session of his is let go, and no other user's. */
  ended(user: string, sessionId: string): void;
  /**
   * A turn of `user`'s starts: his connections are read again through the host (book.ts), so that a
   * hand edit made since holds from this turn's first call. Resolves with what that read had to say,
   * in words, each also in the log once: a document that can't be read (the connections read before
   * it stay in use), a saved connection left out, a connection whose key or headers' values wait to
   * be switched on at the place it now goes to. Never rejects.
   */
  turnStarting(user: string): Promise<readonly string[]>;
  /** Ends open sign-ins and waits for the documents to be written. */
  close(): Promise<void>;
}

/** Megabytes, as `calls.listMost` counts them, in bytes. */
const MEGABYTE = 1024 * 1024;

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

/** One user's part of the layer (see the head of this file): his documents, the calls made on his connections over pi-ai's models with his sign-ins, his sign-in flows, and the stream function of the models made for his agents. */
interface Desk {
  book: Book;
  calls: CallDeps;
  signIn: SignInApi & { close(): void };
  streamFn: StreamFn;
}

export function createModelLayer(deps: ModelLayerDeps): ModelLayer {
  const env = deps.env ?? process.env;
  const steering = STEERING.filter((name) => env[name] !== undefined);
  for (const name of steering) delete env[name];
  // Their names alone: a value may be a credential.
  if (steering.length > 0) deps.log(`took out of the environment what would sign or steer model calls and sign-ins: ${steering.join(", ")}`);
  // pi-ai loads its sign-in flows by a path a single-file bundle can't follow; these load them from the bundle. pi-ai registers all its flows at once (its other providers' too): it has no way to register two alone.
  registerLazyOAuthFlows();

  /** Each model `agentModel` made, with the user's choice it was made for. */
  const made = new WeakMap<Model<Api>, UserChoice>();
  /** Each user's desk, by the user, made the first time the layer acts for him. */
  const desks = new Map<string, Desk>();

  /** The user's desk: his documents are first read when it is made (book.ts). */
  const deskOf = (user: string): Desk => {
    const known = desks.get(user);
    if (known !== undefined) return known;
    // A key given for another place than its connection goes to waits on the host's switches, asked for the connection at its place.
    const switchedOn = async (thing: Switchable): Promise<boolean> => deps.switches !== undefined && (await deps.switches.state(user, thing)) === "on";
    const book = new Book({ store: deps.store, scope: { user }, log: deps.log, switchedOn });
    const pi = createModels({ credentials: book.credentials, authContext: NOWHERE });
    for (const provider of [...builtInProviders(), ...(deps.providers ?? [])]) pi.setProvider(provider);
    const calls: CallDeps = { pi, book, user, fetch: deps.fetch, now: deps.now, id: deps.id, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, settings: deps.settings, texts: deps.texts, refusals: new Refusals(), throttles: new Throttles({ now: deps.now, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout }) };
    // A sign-in has no chat in view: its settings are the levels every chat shares.
    const signIn = createSignIn({ pi, book, id: deps.id, uuid: deps.uuid, now: deps.now, log: deps.log, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, settings: () => deps.settings({ user }), appName: deps.appName });
    // A model made for another user's agent is none of this desk's: its call goes on no connection of his.
    const streamFn = streamFunction(calls, (model) => {
      const choice = made.get(model);
      return choice?.user === user ? choice : undefined;
    });
    const desk: Desk = { book, calls, signIn, streamFn };
    desks.set(user, desk);
    // A user the host refused, as one it does not serve, keeps no desk: his name holds nothing here.
    void book.answered.then((answered) => {
      if (!answered && desks.get(user) === desk) desks.delete(user);
    });
    return desk;
  };

  /** A signal the layer's own wait ends after the provider wait (`calls.providerWait`), with words that say what didn't come in time (`late`, given the wait in words) and name that setting; and its timer's release. */
  const deadline = (settings: ModelSettings, late: (wait: string) => string): { signal: AbortSignal; clear(): void } => {
    const ms = settings.providerWait;
    const stop = new AbortController();
    const timer = deps.setTimeout(() => stop.abort(new Error(`${late(durationWords(ms))} ${settingWords(MODELS.providerWait)} says how long to wait for it.`)), ms);
    return { signal: stop.signal, clear: () => deps.clearTimeout(timer) };
  };

  const viewOf = async (book: Book, c: Connection, chosen: string | null): Promise<ConnectionView> => {
    const { headers, ...shown } = c;
    return {
      ...shown,
      ...(headers !== undefined ? { headers: Object.entries(headers).map(([name, value]) => ({ name, set: value !== null })) } : {}),
      default: c.id === chosen,
      // Whether a key is set and whether it waits; never a character of it.
      key: c.auth === "key" ? { set: (await book.key(c.id)) !== undefined, waiting: await book.waiting(c) } : null,
      ...(c.auth === "signin" ? { signedIn: (await book.signin(c.provider)) !== undefined } : {}),
    };
  };

  /**
   * A compatible server's own list of its models (`GET …/models`, Anthropic's under `/v1`), with what
   * it says of each one's limits: no redirect followed, since its key and headers would go with it,
   * and no more of it read than `calls.listMost`. A list has no chat in view: its settings are the
   * levels every chat shares.
   */
  const serverModels = async (desk: Desk, c: Connection, api: string): Promise<(ModelChoice & { reported: ModelLimitsEntry })[]> => {
    const { book, calls } = desk;
    const settings = await calls.settings({ user: calls.user });
    // Its key and headers' values go only where they were given for, or where the host's switches have the connection on.
    const signing = await book.signing(c);
    if ("waits" in signing) throw new Error(signing.waits);
    const key = c.auth === "key" ? signing.key : undefined;
    const anthropic = api === "anthropic-messages";
    const signs: Record<string, string> = key === undefined ? {} : anthropic ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
    const wait = deadline(settings, (ms) => `it didn't answer within ${ms}.`);
    try {
      const response = await deps.fetch(`${c.baseUrl ?? ""}${anthropic ? "/v1/models" : "/models"}`, { headers: { accept: "application/json", ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}), ...signs, ...signing.headers }, redirect: "error", signal: wait.signal });
      const text = await cappedText(response, settings.listMost * MEGABYTE);
      if (text === null) throw new Error(`${response.ok ? "" : `${response.status}: `}its answer is larger than ${settings.listMost} MB, more than is read. ${settingWords(MODELS.listMost)} says how much of it is read.`);
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
      throw new Error(redact(`The server didn't list its models: ${REDIRECT_REFUSED.test(words) ? REDIRECT_WORDS : words}`, await book.secretValues(), settings));
    } finally {
      wait.clear();
    }
  };

  const api: ModelsApi = {
    async list(user) {
      const { book } = deskOf(user);
      const chosen = await book.defaultId();
      const views = await Promise.all((await book.connections()).map((c) => viewOf(book, c, chosen)));
      return { connections: views, default: chosen, providers: KINDS.map((k) => ({ id: k.id, name: k.name, auth: [...k.auth], apis: [...k.apis], needsBaseUrl: k.needsBaseUrl })) };
    },
    async save(user, input, key, id) {
      const { book } = deskOf(user);
      // A save has no chat in view: the floor a key is held to is the levels every chat shares'.
      const { secretFloor } = await deps.settings({ user });
      const saved = await book.save(input, key, id ?? deps.id, secretFloor);
      return viewOf(book, saved, await book.defaultId());
    },
    remove: (user, id) => deskOf(user).book.remove(id),
    setDefault: (user, id) => deskOf(user).book.setDefault(id),
    async test(user, id, signal) {
      const { calls } = deskOf(user);
      const t0 = deps.now();
      let wait: { signal: AbortSignal; clear(): void } | undefined;
      try {
        // A test has no chat in view: its terms are the levels every chat shares.
        const terms = await termsOf(calls, { user });
        const timed = deadline(terms.settings, (ms) => `The provider didn't answer within ${ms}.`);
        wait = timed;
        const ended = signal === undefined ? timed.signal : AbortSignal.any([signal, timed.signal]);
        const shape = await shapeOf(calls, { connectionId: id, model: null, effort: "off" });
        const context = normalizeContext({ messages: [{ role: "user", content: terms.texts.testPrompt, timestamp: deps.now() }] });
        const out = createAssistantMessageEventStream();
        // A test says how the connection stands now: it is never made again, and keeps nothing in the provider's cache.
        await makeCall(calls, shape, context, { maxTokens: terms.settings.testRoom, sampling: {}, serialTools: false, cacheRetention: "none", retries: 0, carried: {} }, terms, ended, out);
        const result = await out.result();
        if (result.stopReason !== "error" && result.stopReason !== "aborted") return { ok: true, ms: deps.now() - t0, model: result.responseModel ?? result.model };
        return { ok: false, ms: deps.now() - t0, error: timed.signal.aborted ? errorWords(timed.signal.reason) : (result.errorMessage ?? "") };
      } catch (error) {
        return { ok: false, ms: deps.now() - t0, error: errorWords(error) };
      } finally {
        wait?.clear();
      }
    },
    async models(user, connectionId) {
      const desk = deskOf(user);
      const { book, calls } = desk;
      const c = await book.connection(connectionId);
      if (c === null) throw new Error(connectionId === null ? "There is no default connection to list models for." : "That connection is no longer there: reload the page.");
      const kind = kindOf(c.provider);
      if (kind === undefined) throw new Error(`The connection "${c.name}" names a provider that isn't offered.`);
      if (!kind.needsBaseUrl) return calls.pi.getModels(kind.id).map((m) => ({ id: m.id, name: m.name }));
      const listed = await serverModels(desk, c, c.api ?? kind.apis[0]);
      // What the server says of each model's limits is kept with the connection, for a model pi doesn't know.
      await book.noteReported(c, Object.fromEntries(listed.filter((m) => Object.keys(m.reported).length > 0).map((m) => [m.id, m.reported])));
      return listed.map(({ id, name }) => ({ id, name }));
    },
    async limits(user, connectionId, model) {
      return (await shapeOf(deskOf(user).calls, { connectionId, model: model ?? null })).limits;
    },
    async count(scope, connectionId, prompt) {
      // The connection must be one the call could go on. The prompt is counted as RPH's own fit check counts a request before a provider has: its messages as pi's loop is given them, at the chat's ratio. No provider has counted a host's prompt, so there is no count to start from.
      const { model } = await shapeOf(deskOf(scope.user).calls, { connectionId, model: null });
      const { charsPerToken } = await deps.settings(scope);
      return promptTokens(promptMessages(prompt, model, 0).messages, charsPerToken);
    },
    signIn: (user) => deskOf(user).signIn,
    pass: (user, request, sink, signal) => passRequest(deskOf(user).calls, request, sink, signal),
  };

  return {
    async agentModel(choice) {
      const desk = deskOf(choice.user);
      // An agent whose connection is gone is made on the default's, as its calls go (`agentShapeOf`).
      const shape = await agentShapeOf(desk.calls, choice);
      // A model of the agent's own: its user's stream function knows the agent's choice by it.
      const model: Model<Api> = { ...shape.model };
      made.set(model, { ...choice });
      return { model, thinkingLevel: shape.reasoning ?? "off", streamFn: desk.streamFn, limits: shape.limits };
    },
    api,
    ended(user, sessionId) {
      cleanupSessionResources(sessionKey(user, sessionId));
    },
    turnStarting: (user) => deskOf(user).book.refresh(),
    async close() {
      for (const desk of desks.values()) desk.signIn.close();
      await Promise.all([...desks.values()].map((desk) => desk.book.settled()));
    },
  };
}
