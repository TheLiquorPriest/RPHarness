// Models (§13.2): RPH's model layer calls every provider through pi-ai, on the user's connections.
// The host keeps two documents for each user (`ModelsPort`): his connections, and their secrets. The
// layer holds the rules (what a connection may say, keys kept only with their server, sign-in
// tokens pi-ai refreshes); the host persists. The host reaches the layer through `ModelsApi`, so no
// host code ever calls a model itself (§4.1, §18.4). Every document is one user's and every call
// names the user it acts for (READINGS R-52; Appendix B: every table carries the user): one user's
// connections, keys and sign-ins are never listed, used or changed for another.

import type { Effort, Scope, Usage, UserScope } from "./common";
import type { JsonObject, JsonValue } from "./json";
import type { PromptMessage } from "./prompt";

/** How a connection signs its calls: with its own key, with the sign-in to its provider, or with nothing (a local server that asks for none). */
export type ConnectionAuth = "key" | "signin" | "none";

/**
 * How an agent's tools are offered to its model, as its definition's `tools_as:` says: natively
 * until the model's connection refuses them, then as text for `calls.toolRefusalMinutes` (`auto`,
 * the default); always natively, a refusal failing the call (`native`); or always as text, from
 * `.prompts/tools-as-text.md` (`text`).
 */
export type ToolsAs = "auto" | "native" | "text";

/** A model's figures as entered or reported: its context window and its longest answer, in tokens, and whether it takes pictures. */
export interface ModelLimitsEntry {
  contextWindow?: number;
  maxTokens?: number;
  pictures?: boolean;
}

/** A connection as the layer keeps it. */
export interface StoredConnection {
  id: string;
  name: string;
  /** The provider kind the layer offers (`anthropic`, `deepseek`, `openai-compatible`, …). */
  provider: string;
  auth: ConnectionAuth;
  /** Where its calls go instead of the provider's own address: a compatible server's, or a proxy's. */
  baseUrl?: string;
  /** The API a compatible server speaks, where it may speak more than one. */
  api?: string;
  /** Its model, for an agent whose definition names none. */
  model?: string;
  /** Its own effort, for an agent that names none. */
  effort?: Effort;
  /**
   * The headers every call on it sends, by name alone. Their values are credentials, kept with the
   * secrets (`SecretsDoc.headers`); a header with no value there is not sent. A document saved
   * before, each value beside its name (`{ name: value | null }`), is still read, and its values
   * move to the secrets at the layer's next save.
   */
  headers?: string[];
  /** It takes one tool call per answer. */
  serialTools?: true;
  /** Message threads are on. Off unless set: every request then carries everything it is about. */
  messageThreads?: true;
  /** How many times a call that failed before any answer arrived is tried again; 2 when absent. */
  retries?: number;
  /** What the user entered as each model's limits, by model id (§13.3, Y33: an override per connection). */
  limits?: Record<string, ModelLimitsEntry>;
  /** What the connection's server reported as each model's limits, by model id. */
  reported?: Record<string, ModelLimitsEntry>;
}

/** The connections document: every connection, and which one is the default. */
export interface ConnectionsDoc {
  v: 1;
  default: string | null;
  connections: StoredConnection[];
}

/** A provider sign-in's tokens, as pi-ai keeps them fresh. */
export interface SignInToken {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [field: string]: JsonValue;
}

/**
 * The secrets document: each connection's key by connection id, each sign-in by provider, each
 * connection's header values, beside them the place they were given for, and this installation's id
 * for the providers that ask for one.
 */
export interface SecretsDoc {
  v: 1;
  keys: Record<string, string>;
  signins: Record<string, SignInToken>;
  /** Each connection's header values: by the connection's id, then by the header's name. Absent when no connection has one. */
  headers?: Record<string, Record<string, string>>;
  /**
   * Where each connection's key and header values were given for, by the connection's id: its
   * provider and its address, origin and path, in the layer's own form (`placeOf` in RPH's helpers).
   * A connection whose document now names another place, or whose values have no place here, keeps
   * them and sends them nowhere until the host's switches have the connection on at its place
   * (§16; READINGS R-53). Absent when no connection has a key or a header's value.
   */
  places?: Record<string, string>;
  /**
   * The secrets his HTTP tools and MCP servers send, by the name their files give (C4): a file names
   * the secret and never holds its value, so no value is ever in the tree (§16). Absent when none is set.
   */
  tools?: Record<string, string>;
  device?: string;
}

/**
 * Where the host keeps each user's two documents. Storage only: keep each document whole as last
 * given for the user `scope` names and give it back, never another user's. RPH writes one at a
 * time. The connections may live in the user's own config file, and a hand edit there is honoured:
 * RPH reads them through this port whenever it needs them and keeps nothing of them past a turn.
 * Keys and header values are never in the connections document. The secrets are written so a reader
 * never meets half a file, readable by the user alone, and never in the agents' file tree, a
 * transcript or a page (§16).
 */
export interface ModelsPort {
  /** The user's connections document as last saved or as he edited it, as it comes (the layer checks it); null when there is none. */
  loadConnections(scope: UserScope): Promise<unknown>;
  saveConnections(scope: UserScope, doc: ConnectionsDoc): Promise<void>;
  /** The user's secrets document as last saved, as it comes; null when none was ever saved. */
  loadSecrets(scope: UserScope): Promise<unknown>;
  saveSecrets(scope: UserScope, doc: SecretsDoc): Promise<void>;
  /**
   * False: the secrets document this port gives is never to be written. A script fills it in memory
   * from its environment, each key with the place it is for, and the layer keeps every change of it
   * in memory alone, its places too: `saveSecrets` is never called (C27).
   */
  secretsWritten?: false;
}

// ---------------------------------------------------------------- what the host calls

/** A connection as the Connections page shows it: never a key's or a header's value. */
export interface ConnectionView extends Omit<StoredConnection, "headers"> {
  /** Its headers by name, and whether each has a value. */
  headers?: { name: string; set: boolean }[];
  default: boolean;
  /**
   * Whether a key is set, and whether it waits: a key, or a header's value, given for another place
   * than the connection now goes to, or kept with no place, is sent nowhere until the host's
   * switches have the connection on there (§16). Null for a connection that signs with no key. No
   * character of a key is ever in it.
   */
  key: { set: boolean; waiting: boolean } | null;
  /** For a connection that signs in: whether the sign-in holds. */
  signedIn?: boolean;
}

/**
 * A connection to save, whole: with the `id` of one that exists it replaces that one, and a field
 * left out (or null) is cleared; without an `id` it adds one. `headers` is the one exception: absent
 * keeps the stored headers.
 */
export interface ConnectionInput {
  id?: string;
  name: string;
  provider: string;
  auth: ConnectionAuth;
  baseUrl?: string | null;
  api?: string | null;
  model?: string | null;
  effort?: Effort | null;
  /** Absent: the stored headers stay. Null: all are taken away. A record: exactly these, a text setting a value and null keeping the stored one. */
  headers?: Record<string, string | null> | null;
  serialTools?: boolean | null;
  messageThreads?: boolean | null;
  retries?: number | null;
  /** The user's limits for its models, by model id. Null clears them. */
  limits?: Record<string, ModelLimitsEntry> | null;
}

/** A provider the Connections page offers, and how its connections may sign their calls. */
export interface ProviderOffer {
  id: string;
  name: string;
  auth: ConnectionAuth[];
  apis: string[];
  /** A connection of it must give its address (a compatible server). */
  needsBaseUrl: boolean;
  /** It makes embeddings (`ModelsApi.embed`), for a connection of it that signs with a key or with nothing: one signed in makes none. */
  embeds: boolean;
}

/** The Connections page's list. */
export interface ConnectionList {
  connections: ConnectionView[];
  default: string | null;
  providers: ProviderOffer[];
}

/** A connection test's outcome: how long it took, and the model that answered or the provider's words. */
export type ConnectionTest = { ok: true; ms: number; model: string } | { ok: false; ms: number; error: string };

/** A model a connection offers, for a picker. */
export interface ModelChoice {
  id: string;
  name: string;
}

/**
 * Vectors made on the user's embedding connection (C-M6; the settings `embedding.connection` and
 * `embedding.model`, at the levels every chat shares): one per text, in the order given, with the
 * connection and the model that made them. `none`: no embedding connection is set, so nothing is
 * searched by meaning. `failed`: the one set can't make them (gone, its provider offers none, no
 * model named, its key waits) or its provider failed; `words` say what to do, with no secret in them.
 */
export type Embedded =
  | { status: "embedded"; connection: string; model: string; vectors: number[][] }
  | { status: "none"; words: string }
  | { status: "failed"; words: string };

/** One limit of a model, in tokens, and where it came from. */
export interface ModelLimit {
  tokens: number;
  from: "user" | "pi" | "connection";
}

/** Whether a model takes pictures, and where that came from. */
export interface ModelPictures {
  takes: boolean;
  from: "user" | "pi" | "connection";
}

/** A figure of a model the Connections page asks for where nobody has given it. */
export type ModelFigure = "contextWindow" | "maxTokens" | "pictures";

/**
 * A model's limits as RPH uses them (§13.3, Y33), each found on its own: the user's entry, else
 * pi's catalog, else what the connection's server reported. Null: nobody knows it, so the page asks
 * (§18.1 row 0.10); none is assumed. A model nobody has said takes pictures is not known to (C26):
 * RPH leaves no picture out by itself, and the host leaves them out of what it gives that agent.
 */
export interface ModelLimits {
  contextWindow: ModelLimit | null;
  maxTokens: ModelLimit | null;
  pictures: ModelPictures | null;
  /** The figures nobody has given, in this order: the ones the page asks for. */
  asked: ModelFigure[];
}

/** The providers RPH can sign in to (§13.2). */
export type SignInProvider = "anthropic" | "openai";

/** A sign-in started: the flow to finish, the address the user opens, and what to know first. */
export interface SignInStart {
  flow: string;
  url: string;
  note: string;
}

/** Where a provider's sign-in stands. */
export interface SignInState {
  provider: SignInProvider;
  signedIn: boolean;
  /** Until when its token holds (RPH renews it when a call needs it); null when not signed in. */
  until: number | null;
  /** The flow open for it, if one is. */
  flow: string | null;
  /** Why its last flow ended without signing in, for a while after; null otherwise. */
  ended: string | null;
}

export interface SignInApi {
  start(provider: SignInProvider): Promise<SignInStart>;
  /** Finishes a flow with what the user pasted back; resolves once signed in, or rejects with why not. */
  finish(flow: string, code: string): Promise<SignInState>;
  cancel(flow: string): Promise<void>;
  /** Forgets a provider's tokens. */
  out(provider: SignInProvider): Promise<void>;
  state(provider: SignInProvider): Promise<SignInState>;
}

/**
 * A request that is not a turn (§4.2 "Every request RPE can receive": titles, summaries, quiet
 * generations, anything another extension sends), passed on untouched: its body as the provider
 * endpoint received it, on the connection the host names (null: the default).
 */
export interface PassRequest {
  connection: string | null;
  body: JsonObject;
}

/** A passed request's answer, whole. */
export interface PassResult {
  content: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; args: JsonValue }[];
  /** How the call ended, as the provider said (`stop`, `length`, `tool_calls`, …). */
  finishReason: string;
  model?: string;
  usage: Usage;
}

/**
 * Why a passed request has no answer: no connection to send it on; something in it the connection
 * cannot carry (never sent with a part dropped); the provider's failure; or the signal stopped it.
 * `detail` holds the provider's or the layer's own words.
 */
export interface PassError {
  code: "no-connection" | "not-carried" | "provider" | "stopped";
  detail?: string;
}

/** Where a passed request's answer goes as it streams. It ends with exactly one `finish` or one `error`. */
export interface PassSink {
  content(delta: string): void;
  reasoning(delta: string): void;
  finish(result: PassResult): void;
  error(e: PassError): void;
}

/**
 * The host's way to the layer: the Connections page, sign-ins, each model's limits, and requests
 * passed through. Each member names first the user it acts for, and works on his documents alone: a
 * connection's id is his own, and so is which connection is his default.
 */
export interface ModelsApi {
  list(user: string): Promise<ConnectionList>;
  /**
   * Adds or changes a connection of the user's: the owner's own act, on his press (C27). `key`: a new
   * key; null takes it away; absent keeps it. `id`: the id a new connection is made under (one copied
   * from elsewhere keeps its id there); refused, named, where one of his connections has it already,
   * or where `input` names a connection to change.
   */
  save(user: string, input: ConnectionInput, key?: string | null, id?: string): Promise<ConnectionView>;
  remove(user: string, id: string): Promise<void>;
  setDefault(user: string, id: string | null): Promise<void>;
  /** One tiny call on the user's connection. */
  test(user: string, id: string, signal?: AbortSignal): Promise<ConnectionTest>;
  /** The models a connection of the user's offers (null: his default connection). */
  models(user: string, connection: string | null): Promise<ModelChoice[]>;
  /** A model's limits as RPH uses them; the connection's own model when `model` is absent. */
  limits(user: string, connection: string | null, model?: string): Promise<ModelLimits>;
  /**
   * The tokens of a prompt going to a connection of the user's (null: his default) in a chat (C-M7),
   * counted as RPH counts its own calls' prompts before a provider does: at the chat's
   * `tokens.charsPerToken`. Rejects, in words that say what to do, where the connection can't be used.
   */
  count(scope: Scope, connection: string | null, prompt: readonly PromptMessage[]): Promise<number>;
  /**
   * The vectors of `texts` for a search by meaning (§9.4, §10.5; C-M6), made on the user's embedding
   * connection through the layer, so a host never calls a model to build its index. Sent in batches
   * of `embedding.batch` under the rules every call keeps: no redirect followed, a key only to its
   * place, the provider wait, a call that met nothing or 429 or 5xx made again, its connection's throttle.
   */
  embed(user: string, texts: readonly string[], signal?: AbortSignal): Promise<Embedded>;
  /** The user's sign-ins: their tokens are his alone. */
  signIn(user: string): SignInApi;
  /** Passes a request through to the user's connection and streams the answer to `sink`. Resolves after `finish` or `error`. */
  pass(user: string, request: PassRequest, sink: PassSink, signal: AbortSignal): Promise<void>;
  /** The names of the secrets set for his tools and servers (C4), sorted; never a character of a value. */
  toolSecrets(user: string): Promise<string[]>;
  /** Sets the secret of a name for his tools and servers, or (null) takes it away: the owner's own act, on his press (C4). */
  setToolSecret(user: string, name: string, value: string | null): Promise<void>;
}
