// The user's connections and their secrets, kept through the host (store.ts): each connection (its
// provider, how it signs its calls, its address, model, effort and headers, whether it takes one
// tool call per answer, what the user entered of its models' limits and what its server reported
// of them) and which one is the default, in one document; the keys, by connection, the sign-ins'
// tokens, by provider, and this installation's id, in the other. Both are read once and kept here;
// each change writes its document whole, one write after another, so the last change always lands
// last.
//
// What was stored for one server goes to no other. A connection's key, its headers' values and what
// its server reported stay only while its provider and its address's origin do: a change of either
// keeps only what comes with it. A connection that signs in goes to its provider's own address, and
// an address holds no name or password. A save refuses a key shorter than `SECRET_FLOOR`: what a
// server says back can't be cleaned of one so short (words.ts). A header's value may be any length;
// a shorter one is then not taken out of a server's words.
//
// The sign-ins' tokens are pi-ai's to keep fresh: they reach it through a `CredentialStore` over
// the same secrets, whose `modify` runs one change of a provider's sign-in at a time and saves it
// before the next begins. pi-ai refreshes a token inside it and looks again once it holds it, so two
// calls that find a token expired at once refresh it once, and the token a refresh rotated is saved
// before anything can use the old one again.
//
// A document that can't be read stops the book with words that say so, rather than being written
// over with nothing: a hand edit gone wrong costs the user a fix, not their connections. A connection
// in it that a save would refuse is left out, with a line in the log that says why, though never for
// a key's length, which only a save checks.

import type { Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import type { ConnectionInput, ConnectionsDoc, Effort, ModelLimitsEntry, ModelsPort, SecretsDoc, SignInToken, StoredConnection } from "../contract";
import { isRecord, isTokenCount } from "./json";
import type { ProviderKind } from "./kinds";
import { kindOf } from "./kinds";
import { errorWords, SECRET_FLOOR } from "./words";

/** The documents' format: one of another is read as no book, with words that say so. */
const FORMAT = 1;

const LEVELS: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface Secrets {
  keys: Record<string, string>;
  signins: Record<string, SignInToken>;
  device?: string;
}

/** The book's state as its documents hold it. */
interface State {
  connections: StoredConnection[];
  default: string | null;
  secrets: Secrets;
}

export interface BookDeps {
  store: ModelsPort;
  log(text: string): void;
}

function isLevel(value: unknown): value is Effort {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

function isHeaderRecord(value: unknown): value is Record<string, string | null> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string" || v === null);
}

/** Limits by model id, as kept: each a window and a longest reply in tokens, either one there; null when it isn't that. */
function limitRecord(value: unknown): Record<string, ModelLimitsEntry> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, ModelLimitsEntry> = {};
  for (const [model, entry] of Object.entries(value)) {
    if (!isRecord(entry)) return null;
    const { contextWindow, maxTokens } = entry;
    if ((contextWindow !== undefined && !isTokenCount(contextWindow)) || (maxTokens !== undefined && !isTokenCount(maxTokens))) return null;
    if (contextWindow !== undefined || maxTokens !== undefined) out[model] = { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) };
  }
  return out;
}

/** A stored connection read from the document; null when it isn't one this build can read. */
function storedOf(raw: unknown): StoredConnection | null {
  if (!isRecord(raw)) return null;
  const { id, name, provider, auth, baseUrl, api, model, effort, headers, serialTools, limits, reported } = raw;
  if (typeof id !== "string" || typeof name !== "string" || typeof provider !== "string" || (auth !== "key" && auth !== "signin" && auth !== "none")) return null;
  if ((baseUrl !== undefined && typeof baseUrl !== "string") || (api !== undefined && typeof api !== "string") || (model !== undefined && typeof model !== "string") || (effort !== undefined && !isLevel(effort)) || (headers !== undefined && !isHeaderRecord(headers))) return null;
  if (serialTools !== undefined && serialTools !== true) return null;
  const entered = limits === undefined ? undefined : limitRecord(limits);
  const told = reported === undefined ? undefined : limitRecord(reported);
  if (entered === null || told === null) return null;
  return {
    id,
    name,
    provider,
    auth,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(api !== undefined ? { api } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(serialTools === true ? { serialTools } : {}),
    ...(entered !== undefined ? { limits: entered } : {}),
    ...(told !== undefined ? { reported: told } : {}),
  };
}

function tokenOf(value: unknown): SignInToken | null {
  if (!isRecord(value) || value.type !== "oauth" || typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") return null;
  // A token's other fields (an account's id, a scope) are pi-ai's: they are kept as JSON, as the document holds them.
  return JSON.parse(JSON.stringify(value)) as SignInToken;
}

/** A header's name as HTTP allows one: a token of the characters a field name may hold. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The address a connection gives, checked: an http or https URL with no name or password in it (a
 * credential belongs in the key or a header, where words never show it), and no query or fragment
 * (the paths a call adds would land in them), with the slashes it ends in taken off. Its words never
 * repeat what was typed: it may hold a password.
 */
function addressOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("That isn't an address: give one such as https://example.com/v1.");
  }
  if (url.username !== "" || url.password !== "") throw new Error("An address can't hold a name or a password: give the key in its own field, or a header.");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`An address starts with http:// or https://, not ${url.protocol}//.`);
  if (url.search !== "" || url.hash !== "" || url.href.includes("?")) throw new Error(`Give the address without what follows "?" or "#": ${url.origin}${url.pathname}`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** A connection to save, checked against what its provider takes, its headers aside (`headersOf`); throws the words a page shows. */
function checked(input: ConnectionInput, id: string): StoredConnection {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") throw new Error("Give the connection a name.");
  const kind: ProviderKind | undefined = typeof input.provider === "string" ? kindOf(input.provider) : undefined;
  if (kind === undefined) throw new Error(`"${String(input.provider)}" isn't a provider that is offered.`);
  if (!kind.auth.includes(input.auth)) throw new Error(`${kind.name} connections can't use ${input.auth === "signin" ? "a sign-in" : input.auth === "none" ? "no key" : "a key"}.`);
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() !== "" ? addressOf(input.baseUrl) : undefined;
  // A sign-in's token is good at its provider alone, so its calls go nowhere else.
  if (baseUrl !== undefined && input.auth === "signin") throw new Error(`A connection that signs in to ${kind.name} goes to ${kind.name}'s own address: leave the address out.`);
  if (kind.needsBaseUrl && baseUrl === undefined) throw new Error(`An ${kind.name} connection needs the server's address.`);
  const api = typeof input.api === "string" && input.api !== "" ? input.api : undefined;
  if (api !== undefined && !kind.apis.includes(api)) throw new Error(`${kind.name} connections speak ${kind.apis.join(" or ")}, not ${api}.`);
  const model = typeof input.model === "string" && input.model.trim() !== "" ? input.model.trim() : undefined;
  const effort = input.effort ?? undefined;
  if (effort !== undefined && !isLevel(effort)) throw new Error(`"${String(effort)}" isn't an effort: use one of ${LEVELS.join(", ")}.`);
  const limits = input.limits === undefined || input.limits === null ? undefined : limitRecord(input.limits);
  if (limits === null) throw new Error("A model's window and longest reply are whole numbers of tokens above 0.");
  return {
    id,
    name,
    provider: kind.id,
    auth: input.auth,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(api !== undefined && kind.apis.length > 1 ? { api } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(input.serialTools === true ? { serialTools: true as const } : {}),
    ...(limits !== undefined && Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

/**
 * The headers a saved connection keeps: with `given` absent, the ones it had; null, none; a record,
 * exactly those, a text setting a value and null keeping the one it had under that name. A value
 * stays only with the server it was given for: unless `carried` (the same provider at the same
 * origin), a value this save doesn't give is dropped and its name kept, so it is sent no more until
 * it is given again.
 */
function headersOf(given: ConnectionInput["headers"], had: StoredConnection["headers"], carried: boolean): StoredConnection["headers"] {
  if (given === null) return undefined;
  const asked: unknown = given ?? had ?? {};
  if (!isHeaderRecord(asked)) throw new Error("A connection's headers are names with text values.");
  const headers: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(asked)) {
    // Not repeated: a name typed wrong is often a whole header pasted in, its credential with it.
    if (!HEADER_NAME.test(name)) throw new Error("A header's name is a single word, such as x-team, with no space or colon in it: give its value in its own field.");
    if (given === undefined || value === null) {
      headers[name] = carried ? (had?.[name] ?? null) : null;
      continue;
    }
    if (/[\r\n\0]/.test(value)) throw new Error(`The header "${name}" can't hold a line break.`);
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Where a connection's calls go, as far as anything stored for them is concerned: its address's origin, or null for its provider's own. */
function originOf(baseUrl: string | undefined): string | null {
  return baseUrl === undefined ? null : new URL(baseUrl).origin;
}

/** The headers a call on a connection sends: those that have a value. */
export function sentHeaders(connection: StoredConnection): Record<string, string> | undefined {
  const sent = Object.entries(connection.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null);
  return sent.length > 0 ? Object.fromEntries(sent) : undefined;
}

async function load(store: ModelsPort, log: (text: string) => void): Promise<State> {
  let raw: unknown;
  let secret: unknown;
  try {
    [raw, secret] = await Promise.all([store.loadConnections(), store.loadSecrets()]);
  } catch {
    // The host's own words are left out: reading the secrets, they may quote one.
    throw new Error("The saved connections and their keys couldn't be read: fix what keeps them, then start again.");
  }
  if (raw !== null && raw !== undefined && !(isRecord(raw) && raw.v === FORMAT && Array.isArray(raw.connections))) throw new Error("The saved connections aren't a list this build reads: fix or remove them, then start again.");
  if (secret !== null && secret !== undefined && !(isRecord(secret) && secret.v === FORMAT && isRecord(secret.keys) && isRecord(secret.signins))) throw new Error("The saved keys and sign-ins aren't in a form this build reads: fix or remove them, then start again.");
  const connections: StoredConnection[] = [];
  for (const entry of isRecord(raw) && Array.isArray(raw.connections) ? raw.connections : []) {
    const stored = storedOf(entry);
    if (stored === null) {
      log("left out a saved connection this build can't read");
      continue;
    }
    // Held to what a save takes, so that a hand edit can't send a call where no save could: a sign-in's token to another address, or a compatible server's key to its SDK's own host.
    try {
      const headers = headersOf(stored.headers, stored.headers, true);
      connections.push({ ...checked(stored, stored.id), ...(headers !== undefined ? { headers } : {}), ...(stored.reported !== undefined ? { reported: stored.reported } : {}) });
    } catch (error) {
      log(`left out the saved connection "${stored.name}": ${errorWords(error)}`);
    }
  }
  const keys: Record<string, string> = {};
  const signins: Record<string, SignInToken> = {};
  let device: string | undefined;
  if (isRecord(secret) && isRecord(secret.keys) && isRecord(secret.signins)) {
    for (const [id, key] of Object.entries(secret.keys)) if (typeof key === "string") keys[id] = key;
    for (const [provider, credential] of Object.entries(secret.signins)) {
      const token = tokenOf(credential);
      if (token !== null) signins[provider] = token;
    }
    if (typeof secret.device === "string") device = secret.device;
  }
  const chosen = isRecord(raw) && typeof raw.default === "string" ? raw.default : null;
  return { connections, default: chosen, secrets: { keys, signins, ...(device !== undefined ? { device } : {}) } };
}

/** The connections and their secrets. Each method waits for the documents to be read first. */
export class Book {
  private readonly ready: Promise<State>;
  /** Every write, one after another. */
  private writes: Promise<void> = Promise.resolve();
  /** Each provider's sign-in changes, one after another. */
  private readonly signinChanges = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BookDeps) {
    this.ready = load(deps.store, deps.log);
    // A failed read is answered by every method that waits on it.
    this.ready.catch(() => undefined);
  }

  /** Queues a write of a document from the state as it is when its turn comes, so the last change always lands last. */
  private queue(name: "connections" | "secrets"): Promise<void> {
    const run = async (): Promise<void> => {
      const s = await this.ready;
      if (name === "connections") {
        const doc: ConnectionsDoc = { v: FORMAT, default: s.default, connections: s.connections };
        await this.deps.store.saveConnections(structuredClone(doc));
      } else {
        const doc: SecretsDoc = { v: FORMAT, ...s.secrets };
        await this.deps.store.saveSecrets(structuredClone(doc));
      }
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Waits for every write queued so far. */
  async settled(): Promise<void> {
    await this.writes;
  }

  async connections(): Promise<readonly StoredConnection[]> {
    return (await this.ready).connections;
  }

  async defaultId(): Promise<string | null> {
    return (await this.ready).default;
  }

  /** One connection (null: the default); null when there is no such connection. */
  async connection(id: string | null): Promise<StoredConnection | null> {
    const s = await this.ready;
    const wanted = id ?? s.default;
    return wanted === null ? null : (s.connections.find((c) => c.id === wanted) ?? null);
  }

  async key(id: string): Promise<string | undefined> {
    const { keys } = (await this.ready).secrets;
    return Object.hasOwn(keys, id) ? keys[id] : undefined;
  }

  /**
   * Adds a connection or changes one, and its key: a key given is kept, null takes it away, absent
   * leaves it as it was. A connection that no longer signs with a key keeps none. What was stored
   * for one server goes to no other: a connection whose provider, or whose address's origin, changes
   * keeps its key and its headers' values only where this save gives them again, and none of what
   * its old server reported; a new one starts with only what it is given. The first connection is
   * the default.
   */
  async save(input: ConnectionInput, key: string | null | undefined, newId: () => string): Promise<StoredConnection> {
    const s = await this.ready;
    const at = input.id === undefined ? -1 : s.connections.findIndex((c) => c.id === input.id);
    if (input.id !== undefined && at === -1) throw new Error("That connection is no longer there: reload the page.");
    const connection = checked(input, input.id ?? newId());
    if (key !== undefined && key !== null && (typeof key !== "string" || key.trim() === "")) throw new Error("A key can't be empty: leave it out to keep the one there is.");
    if (typeof key === "string" && key.trim().length < SECRET_FLOOR) throw new Error(`A key needs ${SECRET_FLOOR} characters at least: a key is taken out of whatever a server says back (some repeat a key they refuse), and a shorter one can't be told from ordinary words. For a server that takes any key, choose No key: its calls then send "none".`);
    const before = at === -1 ? undefined : s.connections[at];
    const carried = before !== undefined && before.provider === connection.provider && originOf(before.baseUrl) === originOf(connection.baseUrl);
    const headers = headersOf(input.headers, before?.headers, carried);
    const saved: StoredConnection = { ...connection, ...(headers !== undefined ? { headers } : {}), ...(carried && before?.reported !== undefined ? { reported: before.reported } : {}) };
    if (at === -1) s.connections.push(saved);
    else s.connections[at] = saved;
    if (s.default === null) s.default = saved.id;
    const had = s.secrets.keys[saved.id];
    if (saved.auth !== "key" || key === null || (key === undefined && !carried)) delete s.secrets.keys[saved.id];
    else if (typeof key === "string") s.secrets.keys[saved.id] = key.trim();
    const writes = [this.queue("connections")];
    if (s.secrets.keys[saved.id] !== had) writes.push(this.queue("secrets"));
    await Promise.all(writes);
    return saved;
  }

  /** Takes a connection away, with its key; when it was the default there is none until the user picks one. */
  async remove(id: string): Promise<void> {
    const s = await this.ready;
    const at = s.connections.findIndex((c) => c.id === id);
    if (at === -1) return;
    s.connections.splice(at, 1);
    if (s.default === id) s.default = null;
    const hadKey = s.secrets.keys[id] !== undefined;
    delete s.secrets.keys[id];
    await Promise.all([this.queue("connections"), ...(hadKey ? [this.queue("secrets")] : [])]);
  }

  async setDefault(id: string | null): Promise<void> {
    const s = await this.ready;
    if (id !== null && !s.connections.some((c) => c.id === id)) throw new Error("That connection is no longer there: reload the page.");
    s.default = id;
    await this.queue("connections");
  }

  /** Keeps what a connection's server reported of its models' limits, by model id, when it listed them; the connection as it is then. */
  async noteReported(id: string, reported: Record<string, ModelLimitsEntry>): Promise<void> {
    const s = await this.ready;
    const at = s.connections.findIndex((c) => c.id === id);
    const was = s.connections[at];
    if (was === undefined || JSON.stringify(was.reported ?? {}) === JSON.stringify(reported)) return;
    const { reported: _old, ...rest } = was;
    s.connections[at] = Object.keys(reported).length > 0 ? { ...rest, reported } : rest;
    await this.queue("connections");
  }

  /** This installation's id, made the first time it is asked for and kept. */
  async device(make: () => string): Promise<string> {
    const s = await this.ready;
    if (s.secrets.device === undefined) {
      s.secrets.device = make();
      await this.queue("secrets");
    }
    return s.secrets.device;
  }

  async signin(provider: string): Promise<SignInToken | undefined> {
    const { signins } = (await this.ready).secrets;
    return Object.hasOwn(signins, provider) ? signins[provider] : undefined;
  }

  /** Every secret the book holds, for words that must never show one: keys, sign-ins' tokens, and headers' values, which may carry a gateway's or a proxy's credential. */
  async secretValues(): Promise<string[]> {
    const { secrets, connections } = await this.ready;
    const headerValues = connections.flatMap((c) => Object.values(c.headers ?? {}).filter((v): v is string => v !== null));
    return [...Object.values(secrets.keys), ...Object.values(secrets.signins).flatMap((c) => [c.access, c.refresh]), ...headerValues];
  }

  /**
   * Runs one change of a provider's sign-in after the ones before it. A wait the signal ends never
   * starts its change; a change that started finishes, since a refresh may already have rotated the
   * token it is saving.
   */
  private signinChange<T>(provider: string, change: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    const start = (): Promise<T> => {
      signal?.throwIfAborted();
      return change();
    };
    const run = (this.signinChanges.get(provider) ?? Promise.resolve()).then(start, start);
    const settled = run.catch(() => undefined);
    this.signinChanges.set(provider, settled);
    void settled.then(() => {
      if (this.signinChanges.get(provider) === settled) this.signinChanges.delete(provider);
    });
    if (signal === undefined) return run;
    // Only the wait gives way to the signal: once the change runs, its result stands.
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const stop = (): void => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    void run.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    return promise;
  }

  /** pi-ai's view of the sign-ins: read, list, change one at a time per provider, and forget. */
  readonly credentials: CredentialStore = {
    read: async (providerId) => this.signin(providerId),
    list: async () => Object.keys((await this.ready).secrets.signins).map((providerId) => ({ providerId, type: "oauth" as const })),
    modify: (providerId, fn, options) =>
      this.signinChange(
        providerId,
        async (): Promise<Credential | undefined> => {
          const s = await this.ready;
          const current: OAuthCredential | undefined = Object.hasOwn(s.secrets.signins, providerId) ? s.secrets.signins[providerId] : undefined;
          const next = await fn(current);
          if (next === undefined) return current;
          // The book keeps sign-ins alone: a key is a connection's, never a provider's.
          const token = next.type === "oauth" ? tokenOf(next) : null;
          if (token === null) throw new Error("Keys are kept with their connections, not by provider.");
          s.secrets.signins[providerId] = token;
          await this.queue("secrets");
          return token;
        },
        options?.signal,
      ),
    delete: (providerId, options) =>
      this.signinChange(
        providerId,
        async () => {
          const s = await this.ready;
          if (!Object.hasOwn(s.secrets.signins, providerId)) return;
          delete s.secrets.signins[providerId];
          await this.queue("secrets");
        },
        options?.signal,
      ),
  };
}
