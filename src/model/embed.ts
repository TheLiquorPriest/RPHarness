// Embeddings (§9.4, §10.5; C-M6): the vectors a host's search by meaning compares, made on the
// user's embedding connection (`embedding.connection`, `embedding.model`) through the layer, so no
// host calls a model to build its index. pi-ai has no embedding call, so the layer speaks each
// provider's endpoint itself: OpenAI's shape (OpenAI, Mistral, OpenAI-compatible servers) and
// Google's batch call; kinds.ts says which provider offers which. Texts go `embedding.batch` to a
// request, and each request keeps the rules every call keeps: it follows no redirect, the
// connection's key and headers go only where they were given for (book.ts), it waits no longer than
// the provider wait, one that met no server or a 429 or 5xx is made again as a failed call is (its kind switched on, the wait as the settings say), it
// holds its connection's throttle, and no secret is in its failure words.

import type { Embedded } from "../contract";
import { MODELS } from "../harness/settings/models";
import type { Connection } from "./book";
import { type CallDeps, throttleOf } from "./call";
import { askedWait, type FailureFacts, failureOf, retried, retryTermsOf, retryWait } from "./failure";
import { isRecord } from "../contract/json";
import { KINDS, type ProviderKind, kindOf } from "./kinds";
import { REDIRECT_REFUSED, REDIRECT_WORDS, durationWords, errorWords, failureWords, redact, settingWords } from "./words";

type Wire = NonNullable<ProviderKind["embeddings"]>;

/** One request's end: its vectors (with the tokens its provider counted, where it did), or why none came and, where it may be made again, what was known of it. */
type Sent = { vectors: number[][]; tokens?: number } | { failed: string; again?: FailureFacts };

/** The providers that make embeddings, by name, for words that say which to name. */
const OFFERING = KINDS.filter((k) => k.embeddings !== undefined)
  .map((k) => k.name)
  .join(", ");

const STOPPED = "Making the vectors was stopped.";

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** The vectors an answer holds, in the order its texts were sent, or words that say what is wrong with it. */
function vectorsOf(wire: Wire, body: unknown, count: number): number[][] | string {
  const out: (number[] | undefined)[] = new Array(count).fill(undefined);
  if (wire.shape === "google") {
    const list = isRecord(body) && Array.isArray(body.embeddings) ? body.embeddings : [];
    list.forEach((entry, at) => {
      if (at < count && isRecord(entry) && isVector(entry.values)) out[at] = entry.values;
    });
  } else {
    const list = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    list.forEach((entry, i) => {
      if (!isRecord(entry)) return;
      const at = typeof entry.index === "number" ? entry.index : i;
      if (Number.isInteger(at) && at >= 0 && at < count && isVector(entry.embedding)) out[at] = entry.embedding;
    });
  }
  const made = out.filter((v): v is number[] => v !== undefined);
  return made.length === count ? made : `its answer holds ${made.length} vectors for the ${count} texts sent.`;
}

/** The tokens an OpenAI-shaped answer says it read, where it says. */
function tokensOf(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined;
  const n = body.usage.total_tokens ?? body.usage.prompt_tokens;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Waits `ms` on the layer's clock: true once they have passed, false the moment `signal` aborts. */
function pause(deps: Pick<CallDeps, "setTimeout" | "clearTimeout">, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const abort = (): void => {
    deps.clearTimeout(timer);
    resolve(false);
  };
  const timer = deps.setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve(true);
  }, ms);
  signal?.addEventListener("abort", abort, { once: true });
  return promise;
}

/** Where `connection`'s embedding requests go: its own address, or its provider's where it gives none or may give none of its own. */
function addressOf(deps: Pick<CallDeps, "pi">, kind: ProviderKind, connection: Connection): string {
  const provider = deps.pi.getProvider(kind.id)?.baseUrl ?? "";
  return (kind.ownAddress === true ? provider : (connection.baseUrl ?? provider)).replace(/\/+$/, "");
}

/** The embedding connection the user's settings name, by its name or its id, with its provider's way to embeddings; or words that say why it makes none. */
async function embedderOf(deps: CallDeps, named: string): Promise<{ connection: Connection; kind: ProviderKind; wire: Wire } | string> {
  const connections = await deps.book.connections();
  const connection = connections.find((c) => c.id === named) ?? connections.find((c) => c.name === named);
  const setting = settingWords(MODELS.embeddingConnection);
  if (connection === undefined) return `${setting} names "${named}", and none of your connections is called that: name one that is there.`;
  const kind = kindOf(connection.provider);
  if (kind?.embeddings === undefined) return `${setting} names the connection "${connection.name}", whose provider${kind === undefined ? "" : `, ${kind.name},`} offers no embeddings: name a connection on one that does (${OFFERING}).`;
  if (connection.auth === "signin") return `${setting} names the connection "${connection.name}", which is signed in to ${kind.name}, and a sign-in makes no embeddings: name a connection that has a key.`;
  return { connection, kind, wire: kind.embeddings };
}

/** The vectors of `texts` on the user's embedding connection (`ModelsApi.embed`). */
export async function embed(deps: CallDeps, texts: readonly string[], signal?: AbortSignal): Promise<Embedded> {
  // The embedding connection is the user's own, for every chat: read at the levels every chat shares.
  const settings = await deps.settings({ user: deps.user });
  const set = settings.embedding;
  const failed = async (words: string): Promise<Embedded> => ({ status: "failed", words: redact(words, await deps.book.secretValues().catch(() => []), settings) });
  if (set.connection === undefined) return { status: "none", words: `No connection is set to make embeddings, so nothing is searched by meaning. ${settingWords(MODELS.embeddingConnection)} names one.` };
  const embedder = await embedderOf(deps, set.connection);
  if (typeof embedder === "string") return failed(embedder);
  const { connection, kind, wire } = embedder;
  if (set.model === undefined) return failed(`${settingWords(MODELS.embeddingModel)} names no model to make embeddings on the connection "${connection.name}": name one of its provider's embedding models.`);
  const model = set.model;
  if (texts.length === 0) return { status: "embedded", connection: connection.name, model, vectors: [] };
  if (signal?.aborted === true) return failed(STOPPED);

  const signing = await deps.book.signing(connection);
  if ("waits" in signing) return failed(signing.waits);
  const key = connection.auth === "key" ? signing.key : undefined;
  if (connection.auth === "key" && key === undefined) return failed(`The connection "${connection.name}" has no key: add one on the Connections page.`);
  const base = addressOf(deps, kind, connection);
  const google = wire.shape === "google" ? (model.startsWith("models/") ? model : `models/${model}`) : undefined;
  // Google's API takes its key as the address's `key` parameter, the others as a bearer header.
  const url = google !== undefined ? `${base}/${google.split("/").map(encodeURIComponent).join("/")}:batchEmbedContents${key === undefined ? "" : `?key=${encodeURIComponent(key)}`}` : `${base}${wire.shape === "openai" ? wire.path : ""}`;
  const signs: Record<string, string> = key === undefined || google !== undefined ? {} : { authorization: `Bearer ${key}` };
  const headers = { "content-type": "application/json", accept: "application/json", ...signs, ...signing.headers };
  const bodyOf = (batch: readonly string[]): string => JSON.stringify(google !== undefined ? { requests: batch.map((text) => ({ model: google, content: { parts: [{ text }] } })) } : { model, input: batch });

  /** One go at a request, held to the provider wait. */
  const once = async (batch: readonly string[]): Promise<Sent> => {
    const wait = new AbortController();
    const timer = deps.setTimeout(() => wait.abort(new Error(`The provider didn't answer within ${durationWords(settings.providerWait)}. ${settingWords(MODELS.providerWait)} says how long to wait for it.`)), settings.providerWait);
    const ended = signal === undefined ? wait.signal : AbortSignal.any([signal, wait.signal]);
    try {
      let response: Response;
      try {
        response = await deps.fetch(url, { method: "POST", headers, body: bodyOf(batch), redirect: "error", signal: ended });
      } catch (error) {
        const said = error instanceof Error ? `${error.name} ${error.message} ${"code" in error ? String(error.code) : ""}` : String(error);
        if (REDIRECT_REFUSED.test(said)) return { failed: REDIRECT_WORDS };
        if (ended.aborted) throw error;
        // No server was reached: it may be made again.
        return { failed: errorWords(error), again: { unreached: true } };
      }
      const text = await response.text();
      if (!response.ok) {
        const failed = failureWords(`${response.status}: ${text}`);
        if (response.status !== 429 && (response.status < 500 || response.status > 599)) return { failed };
        const asked = askedWait(response.headers, deps.now());
        return { failed, again: { status: response.status, ...(asked !== undefined ? { asked } : {}) } };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Said plainly: the parser's own words quote whatever the server sent.
        return { failed: "its answer isn't JSON." };
      }
      const vectors = vectorsOf(wire, body, batch.length);
      if (typeof vectors === "string") return { failed: vectors };
      const tokens = tokensOf(body);
      return { vectors, ...(tokens !== undefined ? { tokens } : {}) };
    } catch (error) {
      if (signal?.aborted === true) return { failed: STOPPED };
      return { failed: errorWords(wait.signal.aborted ? wait.signal.reason : error) };
    } finally {
      deps.clearTimeout(timer);
    }
  };

  const vectors: number[][] = [];
  const retries = connection.retries ?? settings.retries;
  const terms = retryTermsOf(settings);
  const forever = new AbortController().signal;
  for (let from = 0; from < texts.length; from += set.batch) {
    const batch = texts.slice(from, from + set.batch);
    // Its connection's throttle: a place among its calls at once and room in its minute, the texts' tokens estimated as every call's are.
    const estimate = Math.ceil(batch.reduce((n, t) => n + t.length, 0) / settings.charsPerToken);
    const taken = await deps.throttles.take(connection.id, throttleOf(settings, connection), estimate, signal ?? forever, () => () => {});
    if (taken === undefined) return failed(STOPPED);
    if ("tooBig" in taken) return failed(`These texts come to about ${taken.tooBig.value} tokens, more than the ${taken.tooBig.max} a minute the connection "${connection.name}" takes, so they were not sent. ${settingWords(MODELS.tokensPerMinute)} says how many it takes, ${settingWords(MODELS.embeddingBatch)} how many texts go at once.`);
    let spent: number | undefined;
    try {
      for (let tried = 0; ; tried += 1) {
        const sent = await once(batch);
        if ("vectors" in sent) {
          spent = sent.tokens;
          vectors.push(...sent.vectors);
          break;
        }
        const failure = sent.again !== undefined ? failureOf(sent.failed, sent.again) : undefined;
        if (failure === undefined || !retried(terms, failure, tried, retries)) return failed(`The connection "${connection.name}" made no embeddings: ${sent.failed}`);
        if (!(await pause(deps, retryWait(terms, tried, failure.asked), signal))) return failed(STOPPED);
      }
    } finally {
      taken.hold.settle(spent);
    }
  }
  return { status: "embedded", connection: connection.name, model, vectors };
}
