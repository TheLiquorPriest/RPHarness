// The user's connections and their secrets, kept through the host (`ModelsPort`) in two documents.
// The connections document holds each connection (its provider, how it signs its calls, its address,
// model and effort, the names of the headers its calls send, whether it takes one tool call per
// answer, whether its Anthropic calls keep a message thread, how many times a failed call is made
// again, what the user entered of its models' limits and what its server reported of them) and which
// one is the default. The secrets document holds what is a credential: each connection's key and its
// headers' values, by the connection's id; the sign-ins' tokens, by provider; and this installation's
// id. A connections document saved the old way, the headers' values in it, is read as it is and moved
// on its next save.
//
// The connections may live in the user's own config file, where a hand edit is honoured: their
// document is read again when a turn starts (`refresh`) and immediately before every save, and a save
// writes the document as it was just read with its own change, so that nothing of a hand edit is
// written over with an older copy; an entry the book can't read goes back as it came. A document that
// can't be read is said in words, once in the log; the connections last read well stay in use, and a
// save is refused rather than written over it: a hand edit gone wrong costs the user a fix, not their
// connections. A connection in it that a save would refuse is left out, with a line in the log that
// says why, though never for a key's length, which only a save checks. The secrets are the book's
// own: read once and kept, each change written whole. Every read and write runs after the one before,
// so the last change always lands last.
//
// What was stored for one server goes to no other. A connection's key, its headers' values and what
// its server reported stay only while its provider and its address's origin do: a change of either,
// saved or made by hand, keeps only what comes with it, and a connection that first appears by hand
// takes nothing kept under its id for another. The place a key and headers' values were given for is
// kept beside them in the secrets, and every read compares with it, the first after a start too, so
// a change made while the host was stopped is told from a save as one made while it runs is. Secrets
// saved before places were kept take theirs from the first read, which writes them at once. A
// connection that signs in goes to its provider's own address, as does one of a
// provider whose calls can't go through the layer's own fetch (Google's, which would follow a
// redirect elsewhere and take the key with it); an address holds no name or password. A save refuses
// a key shorter than `SECRET_FLOOR`: what a server says back can't be cleaned of one so short
// (words.ts). A header's value may be any length; a shorter one is then not taken out of a server's
// words.
//
// The sign-ins' tokens are pi-ai's to keep fresh: they reach it through a `CredentialStore` over
// the same secrets, whose `modify` runs one change of a provider's sign-in at a time and saves it
// before the next begins. pi-ai refreshes a token inside it and looks again once it holds it, so two
// calls that find a token expired at once refresh it once, and the token a refresh rotated is saved
// before anything can use the old one again.

import type { Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import type { ConnectionInput, ConnectionsDoc, Effort, ModelLimitsEntry, ModelsPort, SecretsDoc, SignInToken, StoredConnection } from "../contract";
import { isRecord, isTokenCount, own } from "./json";
import type { ProviderKind } from "./kinds";
import { kindOf } from "./kinds";
import { errorWords, SECRET_FLOOR } from "./words";

/** The documents' format: one of another is read as no book, with words that say so. */
const FORMAT = 1;

const LEVELS: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// The host's own words are never passed on for a document: they may quote a key or a header's value.
const NOT_READ = "The saved connections couldn't be read: fix what keeps them.";
const NOT_A_LIST = "The saved connections aren't a list this build reads: fix or remove them.";
const NOT_WRITTEN = "The connections couldn't be saved: fix what keeps them.";
const SECRETS_NOT_WRITTEN = "The keys and sign-ins couldn't be saved: fix what keeps them.";
/** Said after the words of a connections document that can't be read, while the connections read before it are in use. */
const LAST_READ_USED = "Until then, the connections as last read are used.";

/**
 * A connection as the layer uses it: as its document keeps it, with each header's value from the
 * secrets (null for one that has none, which is not sent until it is given again).
 */
export type Connection = Omit<StoredConnection, "headers"> & { headers?: Record<string, string | null> };

interface Secrets {
  keys: Record<string, string>;
  /** Each connection's header values, by its id, then by the header's name. */
  headers: Record<string, Record<string, string>>;
  /** Where each connection's key and headers' values were given for, by its id (`placeOf`). */
  places: Record<string, string>;
  signins: Record<string, SignInToken>;
  device?: string;
}

/** The connections as their document holds them, read well: the ones a call may use, and which is the default. */
interface Kept {
  connections: Connection[];
  default: string | null;
}

/** The connections document as last read well: every entry as it came, the book able to read it or not. */
interface Given {
  entries: unknown[];
  default: string | null;
}

/** A read of the connections document. */
interface Read {
  given: Given;
  /** The connections it holds that the book can read, each header with the value the document itself gives (saved the old way), else none. */
  connections: Connection[];
  /** Where each entry with an id goes, read well or not (`placeOf`). */
  places: Map<string, string>;
  /** What was left out, and why: a line of the log each. */
  notes: string[];
}

export interface BookDeps {
  store: ModelsPort;
  log(text: string): void;
}

function isLevel(value: unknown): value is Effort {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** Headers as a connection gave them the old way, each name with its value or none. */
function isHeaderRecord(value: unknown): value is Record<string, string | null> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string" || v === null);
}

/** Headers as the connections document keeps them: their names. */
function isHeaderNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
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

/** A count of retries: a whole number, none at least. */
function isRetries(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A connection read from its document's entry, each header with the value the entry itself gives (saved the old way), else none; null when it isn't one this build can read. */
function storedOf(raw: unknown): Connection | null {
  if (!isRecord(raw)) return null;
  const { id, name, provider, auth, baseUrl, api, model, effort, headers, serialTools, messageThreads, retries, limits, reported } = raw;
  if (typeof id !== "string" || typeof name !== "string" || typeof provider !== "string" || (auth !== "key" && auth !== "signin" && auth !== "none")) return null;
  if ((baseUrl !== undefined && typeof baseUrl !== "string") || (api !== undefined && typeof api !== "string") || (model !== undefined && typeof model !== "string") || (effort !== undefined && !isLevel(effort))) return null;
  if ((serialTools !== undefined && serialTools !== true) || (messageThreads !== undefined && messageThreads !== true) || (retries !== undefined && !isRetries(retries))) return null;
  let named: Record<string, string | null> | undefined;
  if (isHeaderNames(headers)) named = Object.fromEntries(headers.map((header): [string, null] => [header, null]));
  else if (isHeaderRecord(headers)) named = headers;
  else if (headers !== undefined) return null;
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
    ...(named !== undefined ? { headers: named } : {}),
    ...(serialTools === true ? { serialTools } : {}),
    ...(messageThreads === true ? { messageThreads } : {}),
    ...(retries !== undefined ? { retries } : {}),
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
function checked(input: ConnectionInput, id: string): Connection {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") throw new Error("Give the connection a name.");
  const kind: ProviderKind | undefined = typeof input.provider === "string" ? kindOf(input.provider) : undefined;
  if (kind === undefined) throw new Error(`"${String(input.provider)}" isn't a provider that is offered.`);
  if (!kind.auth.includes(input.auth)) throw new Error(`${kind.name} connections can't use ${input.auth === "signin" ? "a sign-in" : input.auth === "none" ? "no key" : "a key"}.`);
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() !== "" ? addressOf(input.baseUrl) : undefined;
  // A sign-in's token is good at its provider alone, so its calls go nowhere else.
  if (baseUrl !== undefined && input.auth === "signin") throw new Error(`A connection that signs in to ${kind.name} goes to ${kind.name}'s own address: leave the address out.`);
  if (baseUrl !== undefined && kind.ownAddress === true) throw new Error(`A ${kind.name} connection goes to its provider's own address: its calls can't be kept from following a redirect, which would take its key elsewhere. Leave the address out.`);
  if (kind.needsBaseUrl && baseUrl === undefined) throw new Error(`An ${kind.name} connection needs the server's address.`);
  const api = typeof input.api === "string" && input.api !== "" ? input.api : undefined;
  if (api !== undefined && !kind.apis.includes(api)) throw new Error(`${kind.name} connections speak ${kind.apis.join(" or ")}, not ${api}.`);
  const model = typeof input.model === "string" && input.model.trim() !== "" ? input.model.trim() : undefined;
  const effort = input.effort ?? undefined;
  if (effort !== undefined && !isLevel(effort)) throw new Error(`"${String(effort)}" isn't an effort: use one of ${LEVELS.join(", ")}.`);
  const limits = input.limits === undefined || input.limits === null ? undefined : limitRecord(input.limits);
  if (limits === null) throw new Error("A model's window and longest reply are whole numbers of tokens above 0.");
  const retries = input.retries ?? undefined;
  if (retries !== undefined && !isRetries(retries)) throw new Error("Retries are a whole number: 0 for none.");
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
    ...(input.messageThreads === true ? { messageThreads: true as const } : {}),
    ...(retries !== undefined ? { retries } : {}),
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
function headersOf(given: ConnectionInput["headers"], had: Connection["headers"], carried: boolean): Connection["headers"] {
  if (given === null) return undefined;
  const asked: unknown = given ?? had ?? {};
  if (!isHeaderRecord(asked)) throw new Error("A connection's headers are names with text values.");
  const headers: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(asked)) {
    // Not repeated: a name typed wrong is often a whole header pasted in, its credential with it.
    if (!HEADER_NAME.test(name)) throw new Error("A header's name is a single word, such as x-team, with no space or colon in it: give its value in its own field.");
    if (given === undefined || value === null) {
      headers[name] = carried ? (own(had, name) ?? null) : null;
      continue;
    }
    if (/[\r\n\0]/.test(value)) throw new Error(`The header "${name}" can't hold a line break.`);
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Where what is kept for a connection goes: its provider and its address's origin, none for the provider's own address. */
function placeOf(provider: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl.trim() === "") return JSON.stringify([provider, null]);
  try {
    return JSON.stringify([provider, new URL(baseUrl.trim()).origin]);
  } catch {
    // What isn't an address is a place of its own: an address it becomes is another.
    return JSON.stringify([provider, baseUrl]);
  }
}

/** Whether two records of places name the same place for the same connections. */
function samePlaces(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => Object.hasOwn(b, id) && b[id] === a[id]);
}

/** Each header's value: the one the document gives (saved the old way), else the one kept with the secrets, else none. */
function valuesOf(given: Readonly<Record<string, string | null>>, kept: Readonly<Record<string, string>> | undefined): Record<string, string | null> {
  return Object.fromEntries(Object.entries(given).map(([name, value]) => [name, value ?? own(kept, name) ?? null]));
}

/** A connection with each header's value (`valuesOf`). */
function withValues(connection: Connection, kept: Readonly<Record<string, string>> | undefined): Connection {
  return connection.headers === undefined ? connection : { ...connection, headers: valuesOf(connection.headers, kept) };
}

/** The place of an entry of the connections document as it came, read well or not; undefined for one that names no provider or address as a connection does. */
function givenPlaceOf(entry: Record<string, unknown>): string | undefined {
  const { provider, baseUrl } = entry;
  if (typeof provider !== "string" || (baseUrl !== undefined && typeof baseUrl !== "string")) return undefined;
  return placeOf(provider, baseUrl);
}

/** The headers a call on a connection sends: those that have a value. */
export function sentHeaders(connection: Connection): Record<string, string> | undefined {
  const sent = Object.entries(connection.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null);
  return sent.length > 0 ? Object.fromEntries(sent) : undefined;
}

/** Reads the connections document as the host gave it (see `Read`); throws the words for one this build can't read. */
function readConnections(raw: unknown): Read {
  if (raw !== null && raw !== undefined && !(isRecord(raw) && raw.v === FORMAT && Array.isArray(raw.connections))) throw new Error(NOT_A_LIST);
  const entries: unknown[] = isRecord(raw) && Array.isArray(raw.connections) ? raw.connections : [];
  const chosen = isRecord(raw) && typeof raw.default === "string" ? raw.default : null;
  const connections: Connection[] = [];
  const places = new Map<string, string>();
  const notes: string[] = [];
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.id === "string" && !places.has(entry.id)) {
      const place = givenPlaceOf(entry);
      if (place !== undefined) places.set(entry.id, place);
    }
    const stored = storedOf(entry);
    if (stored === null) {
      notes.push("left out a saved connection this build can't read");
      continue;
    }
    // Held to what a save takes, so that a hand edit can't send a call where no save could: a sign-in's token to another address, or a compatible server's key to its SDK's own host.
    try {
      const headers = headersOf(stored.headers, stored.headers, true);
      connections.push({ ...checked(stored, stored.id), ...(headers !== undefined ? { headers } : {}), ...(stored.reported !== undefined ? { reported: stored.reported } : {}) });
    } catch (error) {
      notes.push(`left out the saved connection "${stored.name}": ${errorWords(error)}`);
    }
  }
  return { given: { entries, default: chosen }, connections, places, notes };
}

/** The connections and their secrets (see the head of this file). */
export class Book {
  /** The connections document as last read well, and its connections as the book uses them; undefined until a read goes well. */
  private given: Given | undefined;
  private kept: Kept | undefined;
  /** Why the connections document as last read can't be used, in words; undefined when it can. */
  private trouble: string | undefined;
  /** The secrets, read once; undefined when they couldn't be, `secretsTrouble` saying why. */
  private secrets: Secrets | undefined;
  private secretsTrouble = "The saved keys and sign-ins couldn't be read: fix what keeps them, then start again.";
  /** Where what is kept for each connection, by its id, was given for (`placeOf`): what the first good read found, then each save and read since. */
  private readonly places = new Map<string, string>();
  /** The latest read's words, each already in the log. */
  private said = new Set<string>();
  /** Every read and write, one after another. */
  private tail: Promise<unknown> = Promise.resolve();
  /** The documents' first read. */
  private readonly opened: Promise<void>;
  /** Each provider's sign-in changes, one after another. */
  private readonly signinChanges = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BookDeps) {
    this.opened = this.serial(async () => {
      await this.readSecrets();
      await this.readAgain().catch(() => undefined);
    });
  }

  /** Runs `step` once every step before it has ended, however it ended. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.tail.then(step, step);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Waits for every read and write queued so far. */
  async settled(): Promise<void> {
    await this.tail;
  }

  /** Reads the secrets, once: no one but the book writes them. */
  private async readSecrets(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.deps.store.loadSecrets();
    } catch {
      return;
    }
    if (raw !== null && raw !== undefined && !(isRecord(raw) && raw.v === FORMAT && isRecord(raw.keys) && isRecord(raw.signins) && (raw.headers === undefined || isRecord(raw.headers)) && (raw.places === undefined || isRecord(raw.places)))) {
      this.secretsTrouble = "The saved keys and sign-ins aren't in a form this build reads: fix or remove them, then start again.";
      return;
    }
    const secrets: Secrets = { keys: {}, headers: {}, places: {}, signins: {} };
    if (isRecord(raw)) {
      if (isRecord(raw.keys)) for (const [id, key] of Object.entries(raw.keys)) if (typeof key === "string") secrets.keys[id] = key;
      if (isRecord(raw.headers)) {
        for (const [id, values] of Object.entries(raw.headers)) {
          if (!isRecord(values)) continue;
          const kept = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string");
          if (kept.length > 0) secrets.headers[id] = Object.fromEntries(kept);
        }
      }
      if (isRecord(raw.places)) for (const [id, place] of Object.entries(raw.places)) if (typeof place === "string") secrets.places[id] = place;
      if (isRecord(raw.signins)) {
        for (const [provider, credential] of Object.entries(raw.signins)) {
          const token = tokenOf(credential);
          if (token !== null) secrets.signins[provider] = token;
        }
      }
      if (typeof raw.device === "string") secrets.device = raw.device;
    }
    this.secrets = secrets;
  }

  /**
   * Reads the connections document again, in a step of the queue: the book then holds it as the host
   * gives it now. A connection that first appears, or that now goes to another place than the book
   * knew it to, takes nothing kept under its id for another place, and what was taken is written so
   * at once. Resolves with what the read had to say; rejects in words, the connections last read well
   * kept, when the document can't be read, or when what was taken away can't be written.
   */
  private async reread(): Promise<string[]> {
    let raw: unknown;
    try {
      raw = await this.deps.store.loadConnections();
    } catch {
      this.trouble = NOT_READ;
      throw new Error(NOT_READ);
    }
    let read: Read;
    try {
      read = readConnections(raw);
    } catch (error) {
      this.trouble = errorWords(error);
      throw error;
    }
    this.trouble = undefined;
    // The first good read takes each connection's place from the secrets, where its key and headers' values were kept beside the place they were given for, and any other's from the document as it stands. Secrets kept before places were take the document's, and are written with them below.
    let learned = false;
    if (this.kept === undefined) {
      for (const [id, place] of read.places) {
        const given = own(this.secrets?.places, id);
        this.places.set(id, given ?? place);
        learned ||= given === undefined && this.secrets !== undefined && (Object.hasOwn(this.secrets.keys, id) || Object.hasOwn(this.secrets.headers, id));
      }
    }
    const secrets = this.secrets;
    const notes = [...read.notes];
    const moved: Connection[] = [];
    let taken = false;
    const connections = read.connections.map((c): Connection => {
      const place = placeOf(c.provider, c.baseUrl);
      const was = this.places.get(c.id);
      if (was === place) return withValues(c, own(secrets?.headers, c.id));
      // What is kept under its id was given for another place: none of it goes with it, here at once and in what is kept.
      const keyed = secrets !== undefined && Object.hasOwn(secrets.keys, c.id);
      const valued = secrets !== undefined && Object.hasOwn(secrets.headers, c.id);
      if (secrets !== undefined) {
        delete secrets.keys[c.id];
        delete secrets.headers[c.id];
      }
      taken ||= keyed || valued;
      if (was === undefined) {
        this.places.set(c.id, place);
        if (keyed || valued) notes.push(`took away the key and headers' values kept under the id of the saved connection "${c.name}", which is new: they were given for another connection; give this one its own on the Connections page`);
        return c;
      }
      const { headers, reported, ...rest } = c;
      if (!keyed && !valued && reported === undefined && !Object.values(headers ?? {}).some((v) => v !== null)) {
        this.places.set(c.id, place);
        return c;
      }
      // Its place is learned once this is written, so that a write that fails is made again at the next read.
      const left: Connection = { ...rest, ...(headers !== undefined ? { headers: Object.fromEntries(Object.keys(headers).map((name): [string, null] => [name, null])) } : {}) };
      moved.push(left);
      notes.push(`took away the key and headers' values of the saved connection "${c.name}": it now goes to another provider or address than they were given for; give them again on the Connections page`);
      return left;
    });
    this.given = read.given;
    this.kept = { connections, default: read.given.default };
    if (moved.length > 0) {
      await this.writeConnections(moved, [], read.given.default, undefined, taken || learned);
      for (const c of moved) this.places.set(c.id, placeOf(c.provider, c.baseUrl));
    } else if (taken || learned) await this.writeSecrets();
    return notes;
  }

  /** Logs each of the latest read's words that the read before it didn't have. */
  private say(words: readonly string[]): void {
    for (const line of words) if (!this.said.has(line)) this.deps.log(line);
    this.said = new Set(words);
  }

  /** Reads the connections again and says what the read had to say, each line once in the log; rejects with the words of a read or a write that failed. */
  private async readAgain(): Promise<string[]> {
    try {
      const notes = await this.reread();
      this.say(notes);
      return notes;
    } catch (error) {
      const words = errorWords(error);
      this.say([this.trouble !== undefined && this.kept !== undefined ? `${words} ${LAST_READ_USED}` : words]);
      throw new Error(words);
    }
  }

  /** A turn starts: the connections are read again, after every read and write before it (see the head of this file). Resolves with what the read had to say, in words; never rejects. */
  refresh(): Promise<readonly string[]> {
    return this.serial(() => this.readAgain().catch(() => [...this.said]));
  }

  /**
   * Writes the connections document as last read, with each of `put` in place of the entry of its id
   * (after the rest, where it has none) and every entry of an id in `gone` taken out, `chosen` the
   * default: each header's name goes to the document and its value to the secrets, entries saved the
   * old way moved with them; everything else goes back as the host gave it. The secrets go first, when
   * anything of them changed (`keys`, the keys to keep; `secretsChanged`, a change already made; the
   * place a connection's key and values are kept for), so that no value leaves the document before it
   * is kept; the book then holds what was written.
   */
  private async writeConnections(put: readonly Connection[], gone: readonly string[], chosen: string | null, keys?: Record<string, string>, secretsChanged = false): Promise<void> {
    const secrets = this.secrets;
    const values: Record<string, Record<string, string>> = { ...secrets?.headers };
    let changed = secretsChanged || (secrets !== undefined && keys !== undefined && JSON.stringify(keys) !== JSON.stringify(secrets.keys));
    /** Keeps `headers`' values as connection `id`'s. */
    const keep = (id: string, headers: Connection["headers"]): void => {
      const before = JSON.stringify(own(values, id) ?? null);
      const set = Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null);
      if (set.length > 0) values[id] = Object.fromEntries(set);
      else delete values[id];
      if (JSON.stringify(own(values, id) ?? null) !== before) changed = true;
    };
    const entries: unknown[] = [];
    /** The place of each connection whose values this write keeps, as written here. */
    const placed = new Map<string, string>();
    for (const entry of this.given?.entries ?? []) {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
      if (id !== undefined && gone.includes(id)) {
        keep(id, undefined);
        continue;
      }
      // Saved the old way, its headers' values in it: the values move to the secrets, the names stay.
      if (secrets !== undefined && id !== undefined && isRecord(entry) && isHeaderRecord(entry.headers) && !put.some((c) => c.id === id)) {
        const inUse = this.kept?.connections.find((c) => c.id === id);
        keep(id, inUse !== undefined ? inUse.headers : valuesOf(entry.headers, own(values, id)));
        const place = givenPlaceOf(entry);
        if (place !== undefined) placed.set(id, place);
        entries.push({ ...entry, headers: Object.keys(entry.headers) });
        continue;
      }
      entries.push(entry);
    }
    for (const c of put) {
      keep(c.id, c.headers);
      placed.set(c.id, placeOf(c.provider, c.baseUrl));
      const { headers, ...rest } = c;
      const kept: StoredConnection = { ...rest, ...(headers !== undefined ? { headers: Object.keys(headers) } : {}) };
      const at = entries.findIndex((e) => isRecord(e) && e.id === c.id);
      if (at === -1) entries.push(kept);
      else entries[at] = kept;
    }
    if (secrets !== undefined) {
      const places = this.placesFor(keys ?? secrets.keys, values, placed);
      if (changed || !samePlaces(places, secrets.places)) await this.writeSecrets(keys, values, places);
    }
    // An entry the book can't read goes back exactly as the host gave it, which the host keeps whole whatever it holds: a save changes nothing of the user's but its own change.
    const asGiven = entries as StoredConnection[];
    const doc: ConnectionsDoc = { v: FORMAT, default: chosen, connections: asGiven };
    try {
      await this.deps.store.saveConnections(structuredClone(doc));
    } catch {
      throw new Error(NOT_WRITTEN);
    }
    const read = readConnections(doc);
    this.given = read.given;
    this.kept = { connections: read.connections.map((c) => withValues(c, own(this.secrets?.headers, c.id))), default: chosen };
  }

  /** Writes the secrets as the book holds them, with `keys`, `headers` and `places` in place of its own where given; the book holds those once they are written. */
  private async writeSecrets(keys?: Record<string, string>, headers?: Record<string, Record<string, string>>, places?: Record<string, string>): Promise<void> {
    const secrets = this.secrets;
    if (secrets === undefined) return;
    const next = { keys: keys ?? secrets.keys, headers: headers ?? secrets.headers };
    const at = places ?? this.placesFor(next.keys, next.headers);
    const doc: SecretsDoc = {
      v: FORMAT,
      keys: next.keys,
      signins: secrets.signins,
      ...(secrets.device !== undefined ? { device: secrets.device } : {}),
      ...(Object.keys(next.headers).length > 0 ? { headers: next.headers } : {}),
      ...(Object.keys(at).length > 0 ? { places: at } : {}),
    };
    try {
      await this.deps.store.saveSecrets(structuredClone(doc));
    } catch {
      throw new Error(SECRETS_NOT_WRITTEN);
    }
    secrets.keys = next.keys;
    secrets.headers = next.headers;
    secrets.places = at;
  }

  /** The place each connection that has a key or headers' values kept was given for, as the secrets keep it beside them: `placed` where it names one, else the book's own. */
  private placesFor(keys: Readonly<Record<string, string>>, headers: Readonly<Record<string, unknown>>, placed?: ReadonlyMap<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of new Set([...Object.keys(keys), ...Object.keys(headers)])) {
      const place = placed?.get(id) ?? this.places.get(id) ?? own(this.secrets?.places, id);
      if (place !== undefined) out[id] = place;
    }
    return out;
  }

  /** The connections as last read well; rejects with the words of a document never read well. */
  private async keptNow(): Promise<Kept> {
    await this.opened;
    if (this.kept === undefined) throw new Error(this.trouble ?? NOT_READ);
    return this.kept;
  }

  /** The secrets; rejects with the words of a document that couldn't be read. */
  private async secretsNow(): Promise<Secrets> {
    await this.opened;
    if (this.secrets === undefined) throw new Error(this.secretsTrouble);
    return this.secrets;
  }

  async connections(): Promise<readonly Connection[]> {
    return (await this.keptNow()).connections;
  }

  async defaultId(): Promise<string | null> {
    return (await this.keptNow()).default;
  }

  /** One connection (null: the default); null when there is no such connection. */
  async connection(id: string | null): Promise<Connection | null> {
    const kept = await this.keptNow();
    const wanted = id ?? kept.default;
    return wanted === null ? null : (kept.connections.find((c) => c.id === wanted) ?? null);
  }

  async key(id: string): Promise<string | undefined> {
    return own((await this.secretsNow()).keys, id);
  }

  /**
   * Adds a connection or changes one, and its key: a key given is kept, null takes it away, absent
   * leaves it as it was. A connection that no longer signs with a key keeps none. What was stored
   * for one server goes to no other: a connection whose provider, or whose address's origin, changes
   * keeps its key and its headers' values only where this save gives them again, and none of what
   * its old server reported; a new one starts with only what it is given. The first connection is
   * the default. The document is read again first, and written as it was read with this change.
   */
  async save(input: ConnectionInput, key: string | null | undefined, newId: () => string): Promise<Connection> {
    return this.serial(async () => {
      const secrets = await this.secretsNow();
      await this.readAgain();
      const kept = await this.keptNow();
      const at = input.id === undefined ? -1 : kept.connections.findIndex((c) => c.id === input.id);
      if (input.id !== undefined && at === -1) throw new Error("That connection is no longer there: reload the page.");
      const connection = checked(input, input.id ?? newId());
      if (key !== undefined && key !== null && (typeof key !== "string" || key.trim() === "")) throw new Error("A key can't be empty: leave it out to keep the one there is.");
      if (typeof key === "string" && key.trim().length < SECRET_FLOOR) throw new Error(`A key needs ${SECRET_FLOOR} characters at least: a key is taken out of whatever a server says back (some repeat a key they refuse), and a shorter one can't be told from ordinary words. For a server that takes any key, choose No key: its calls then send "none".`);
      const before = at === -1 ? undefined : kept.connections[at];
      const carried = before !== undefined && placeOf(before.provider, before.baseUrl) === placeOf(connection.provider, connection.baseUrl);
      const headers = headersOf(input.headers, before?.headers, carried);
      const saved: Connection = { ...connection, ...(headers !== undefined ? { headers } : {}), ...(carried && before?.reported !== undefined ? { reported: before.reported } : {}) };
      const keys = { ...secrets.keys };
      if (saved.auth !== "key" || key === null || (key === undefined && !carried)) delete keys[saved.id];
      else if (typeof key === "string") keys[saved.id] = key.trim();
      await this.writeConnections([saved], [], kept.default ?? saved.id, keys);
      this.places.set(saved.id, placeOf(saved.provider, saved.baseUrl));
      return saved;
    });
  }

  /** Takes a connection away, with its key and its headers' values; when it was the default there is none until the user picks one. */
  async remove(id: string): Promise<void> {
    await this.serial(async () => {
      const secrets = await this.secretsNow();
      await this.readAgain();
      const kept = await this.keptNow();
      const keys = { ...secrets.keys };
      delete keys[id];
      await this.writeConnections([], [id], kept.default === id ? null : kept.default, keys);
      this.places.delete(id);
    });
  }

  async setDefault(id: string | null): Promise<void> {
    await this.serial(async () => {
      await this.readAgain();
      const kept = await this.keptNow();
      if (id !== null && !kept.connections.some((c) => c.id === id)) throw new Error("That connection is no longer there: reload the page.");
      await this.writeConnections([], [], id);
    });
  }

  /** Keeps what a connection's server reported of its models' limits, by model id, when it listed them: kept while the connection still goes to that server. */
  async noteReported(listed: Connection, reported: Record<string, ModelLimitsEntry>): Promise<void> {
    await this.serial(async () => {
      // A document that can't be read is said by the read: the report waits for the next list.
      if (!(await this.readAgain().then(() => true, () => false))) return;
      const kept = await this.keptNow();
      const was = kept.connections.find((c) => c.id === listed.id);
      if (was === undefined || placeOf(was.provider, was.baseUrl) !== placeOf(listed.provider, listed.baseUrl) || JSON.stringify(was.reported ?? {}) === JSON.stringify(reported)) return;
      const { reported: _old, ...rest } = was;
      await this.writeConnections([Object.keys(reported).length > 0 ? { ...rest, reported } : rest], [], kept.default);
    });
  }

  /** This installation's id, made the first time it is asked for and kept. */
  async device(make: () => string): Promise<string> {
    return this.serial(async () => {
      const secrets = await this.secretsNow();
      const device = secrets.device ?? make();
      if (secrets.device === undefined) {
        secrets.device = device;
        await this.writeSecrets();
      }
      return device;
    });
  }

  async signin(provider: string): Promise<SignInToken | undefined> {
    return own((await this.secretsNow()).signins, provider);
  }

  /** Every secret the book holds, for words that must never show one: keys, headers' values, which may carry a gateway's or a proxy's credential, and sign-ins' tokens. */
  async secretValues(): Promise<string[]> {
    await this.opened;
    const inUse = (this.kept?.connections ?? []).flatMap((c) => Object.values(c.headers ?? {}).filter((v): v is string => v !== null));
    const secrets = this.secrets;
    if (secrets === undefined) return inUse;
    return [...Object.values(secrets.keys), ...Object.values(secrets.headers).flatMap((values) => Object.values(values)), ...Object.values(secrets.signins).flatMap((c) => [c.access, c.refresh]), ...inUse];
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
    list: async () => Object.keys((await this.secretsNow()).signins).map((providerId) => ({ providerId, type: "oauth" as const })),
    modify: (providerId, fn, options) =>
      this.signinChange(
        providerId,
        async (): Promise<Credential | undefined> => {
          const secrets = await this.secretsNow();
          const current: OAuthCredential | undefined = own(secrets.signins, providerId);
          const next = await fn(current);
          if (next === undefined) return current;
          // The book keeps sign-ins alone: a key is a connection's, never a provider's.
          const token = next.type === "oauth" ? tokenOf(next) : null;
          if (token === null) throw new Error("Keys are kept with their connections, not by provider.");
          secrets.signins[providerId] = token;
          await this.serial(() => this.writeSecrets());
          return token;
        },
        options?.signal,
      ),
    delete: (providerId, options) =>
      this.signinChange(
        providerId,
        async () => {
          const secrets = await this.secretsNow();
          if (!Object.hasOwn(secrets.signins, providerId)) return;
          delete secrets.signins[providerId];
          await this.serial(() => this.writeSecrets());
        },
        options?.signal,
      ),
  };
}
