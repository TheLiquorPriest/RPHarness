// Models (§13.2): RPH's model layer calls every provider through pi-ai, on the user's connections.
// The host keeps two documents for it (`ModelsPort`): the connections, and their secrets. The
// layer holds the rules (what a connection may say, keys kept only with their server, sign-in
// tokens pi-ai refreshes); the host persists. The host reaches the layer through `ModelsApi`, so no
// host code ever calls a model itself (§4.1, §18.4).

import type { Effort, Usage } from "./common";
import type { JsonObject, JsonValue } from "./json";

/** How a connection signs its calls: with its own key, with the sign-in to its provider, or with nothing (a local server that asks for none). */
export type ConnectionAuth = "key" | "signin" | "none";

/** A model's limits as entered or reported: its context window and its longest answer, in tokens. */
export interface ModelLimitsEntry {
  contextWindow?: number;
  maxTokens?: number;
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
  /** Headers every call on it sends, by name; null: a value that was dropped when its provider or address changed. */
  headers?: Record<string, string | null>;
  /** It takes one tool call per answer. */
  serialTools?: true;
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

/** The secrets document: each connection's key by connection id, each sign-in by provider, and this installation's id for the providers that ask for one. */
export interface SecretsDoc {
  v: 1;
  keys: Record<string, string>;
  signins: Record<string, SignInToken>;
  device?: string;
}

/**
 * Where the host keeps the two documents. Storage only: keep each document whole as last given and
 * give it back. RPH is their one writer and writes one at a time. The secrets are written so a
 * reader never meets half a file, readable by the user alone, and never in the agents' file tree,
 * a transcript or a page (§16).
 */
export interface ModelsPort {
  /** The connections document as last saved, as it comes (the layer checks it); null when none was ever saved. */
  loadConnections(): Promise<unknown>;
  saveConnections(doc: ConnectionsDoc): Promise<void>;
  /** The secrets document as last saved, as it comes; null when none was ever saved. */
  loadSecrets(): Promise<unknown>;
  saveSecrets(doc: SecretsDoc): Promise<void>;
}

// ---------------------------------------------------------------- what the host calls

/** A connection as the Connections page shows it: never a key's or a header's value. */
export interface ConnectionView extends Omit<StoredConnection, "headers"> {
  /** Its headers by name, and whether each has a value. */
  headers?: { name: string; set: boolean }[];
  default: boolean;
  /** Whether a key is set, and its last four characters; null for a connection that signs with no key. */
  key: { set: boolean; last4: string | null } | null;
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

/** One limit of a model, in tokens, and where it came from. */
export interface ModelLimit {
  tokens: number;
  from: "user" | "pi" | "connection";
}

/**
 * A model's limits as RPH uses them (§13.3, Y33), each found on its own: the user's entry, else
 * pi's catalog, else what the connection's server reported. Null: nobody knows it, so the page asks
 * (§18.1 row 0.10).
 */
export interface ModelLimits {
  contextWindow: ModelLimit | null;
  maxTokens: ModelLimit | null;
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

/** The host's way to the model layer: the Connections page, sign-ins, each model's limits, and requests passed through. */
export interface ModelsApi {
  list(): Promise<ConnectionList>;
  /** Adds or changes a connection. `key`: a new key; null takes it away; absent keeps it. */
  save(input: ConnectionInput, key?: string | null): Promise<ConnectionView>;
  remove(id: string): Promise<void>;
  setDefault(id: string | null): Promise<void>;
  /** One tiny call on the connection. */
  test(id: string, signal?: AbortSignal): Promise<ConnectionTest>;
  /** The models a connection offers (null: the default connection). */
  models(connection: string | null): Promise<ModelChoice[]>;
  /** A model's limits as RPH uses them; the connection's own model when `model` is absent. */
  limits(connection: string | null, model?: string): Promise<ModelLimits>;
  signIn: SignInApi;
  /** Passes a request through to its connection and streams the answer to `sink`. Resolves after `finish` or `error`. */
  pass(request: PassRequest, sink: PassSink, signal: AbortSignal): Promise<void>;
}
