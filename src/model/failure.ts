// What broke a model call that failed (§13.2), and whether and when it is made again. A call is
// sorted by what its layer knew of it (the HTTP status its server answered with, that no server was
// reached, that its answer went silent, that it was never sent) and, where that says nothing, by
// its words: the plain words the layer gives a broken connection (words.ts) and the provider's own.
// What making it again can help is made again as the settings say; what it cannot help (no credit,
// a key refused, a request the provider calls invalid, a prompt past the model's window, a call
// never sent) never is. A stop and a limit are no failures: the work ends where it stands.
//
// The wait before each try starts at `calls.retryWaitSeconds` and grows as the settings say, never
// past the longest they allow; a provider that asks for a wait (a `Retry-After` header, or "try
// again in 6s" in its words) is waited for where the settings keep to it.

import type { CallFailureKind } from "../contract";

/** The kinds of failure making a call again can help, each with its own switch. */
export const RETRIED_KINDS = ["connection", "timeout", "overloaded", "server", "other"] as const satisfies readonly CallFailureKind[];

/** What the model layer knew of a failed call besides its words. */
export interface FailureFacts {
  /** The HTTP status its server answered with. */
  status?: number;
  /** No server was reached. */
  unreached?: boolean;
  /** Its answer went silent past `calls.silentAfterSeconds`. */
  silent?: boolean;
  /** It was never sent: no key, a switch not on, bigger than its connection's minute. */
  unmade?: boolean;
  /** The wait its provider asked for (`Retry-After`), in milliseconds. */
  asked?: number;
  /** Its connection's own count of retries, where the connection sets one. */
  retries?: number;
}

/** What broke a call: its kind, the HTTP status where there was one, and the wait its provider asked for where it asked one, in milliseconds. */
export interface CallFailure {
  kind: CallFailureKind;
  status?: number;
  asked?: number;
}

/** A status at the head of the layer's words ("529: Overloaded"). */
const STATUS = /^(\d{3}):/;
const TOO_LONG = /prompt is too long|context[_ ]length|maximum context|context window|input is too long|too many input tokens/i;
const CREDIT = /insufficient[_ ](?:balance|quota|funds|credits?)|out of credits?|credit balance|exceeded your current quota|billing|payment required/i;
const KEY = /invalid[_ ](?:api[_ ])?key|incorrect api key|unauthori[sz]ed|authentication|sign-in couldn't be renewed|permission denied|forbidden/i;
const OVERLOADED = /overloaded|rate[_ ]limit|too many requests|slow down|at capacity|server is busy|try again later/i;
const CONNECTION = /closed or reset|connection was refused|was refused|could not be resolved|\bE(?:CONNRESET|CONNABORTED|CONNREFUSED|PIPE|NOTFOUND|AI_AGAIN)\b|socket|stream ended|ended before|premature|fetch failed|network|terminated/i;
const TIMEOUT = /timed out|timeout|went silent/i;
const SERVER = /internal server error|server error|bad gateway|service unavailable|\bapi_error\b/i;
/** A wait a provider asks for in its words: "Please try again in 6.124s", "retry after 20 seconds". */
const ASKED = /(?:try again|retry)(?: (?:in|after))? (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i;

/** The wait a provider's words ask for, in milliseconds. */
function askedIn(words: string): number | undefined {
  const found = ASKED.exec(words);
  if (found?.[1] === undefined || found[2] === undefined) return undefined;
  const n = Number(found[1]);
  const unit = found[2].toLowerCase();
  const ms = unit.startsWith("ms") || unit.startsWith("milli") ? n : unit.startsWith("m") ? n * 60_000 : n * 1000;
  return Math.ceil(ms);
}

/** The wait a failed request's response asks for before the next try, in milliseconds: `retry-after-ms`, else `retry-after` in seconds or as a date. */
export function askedWait(headers: Headers, now: number): number | undefined {
  const ms = Number(headers.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  const after = headers.get("retry-after")?.trim() ?? "";
  if (after === "") return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** What a status says broke the call, given its words. */
function byStatus(status: number, words: string): CallFailureKind {
  if (status === 401 || status === 403) return "key";
  if (status === 402) return "credit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 413) return "too-long";
  if (status === 429) return CREDIT.test(words) ? "credit" : "overloaded";
  if (status === 503 || status === 529) return "overloaded";
  if (status >= 500) return "server";
  return TOO_LONG.test(words) ? "too-long" : "invalid";
}

/** What broke a call, by what the layer knew of it and else by its words. */
export function failureOf(words: string, facts: FailureFacts = {}): CallFailure {
  const said = Number(STATUS.exec(words.trim())?.[1]);
  const status = facts.status !== undefined && facts.status >= 400 ? facts.status : said >= 400 && said <= 599 ? said : undefined;
  const asked = facts.asked ?? askedIn(words);
  const kind: CallFailureKind =
    status !== undefined
      ? byStatus(status, words)
      : facts.unmade === true
        ? "unmade"
        : facts.silent === true
          ? "timeout"
          : TOO_LONG.test(words)
            ? "too-long"
            : CREDIT.test(words)
              ? "credit"
              : KEY.test(words)
                ? "key"
                : OVERLOADED.test(words)
                  ? "overloaded"
                  : facts.unreached === true || CONNECTION.test(words)
                    ? "connection"
                    : TIMEOUT.test(words)
                      ? "timeout"
                      : SERVER.test(words)
                        ? "server"
                        : "other";
  return { kind, ...(status !== undefined ? { status } : {}), ...(asked !== undefined ? { asked } : {}) };
}

/** How a failed call is made again, as the settings say. */
export interface RetryTerms {
  /** Times a failed call is made again (`calls.retries`), where its connection sets no count of its own. */
  retries: number;
  /** The wait before the first try, in milliseconds (`calls.retryWaitSeconds`). */
  wait: number;
  /** Each wait after the first is the one before times this (`calls.retryWaitGrowth`). */
  growth: number;
  /** The longest any wait is, in milliseconds (`calls.maxRetryWaitSeconds`). */
  most: number;
  /** A wait its provider asked for is waited for, up to `most` (`calls.retryWaitAsAsked`). */
  asked: boolean;
  /** The kinds of failure that are made again (`calls.retryOn.<kind>`): never one a try cannot help. */
  kinds: readonly CallFailureKind[];
}

/** The model layer's retry settings, as `calls.*` gives them (times in milliseconds). */
export interface RetrySettings {
  retries: number;
  retryWait: number;
  retryGrowth: number;
  retryMost: number;
  retryAsked: boolean;
  retryOn: Readonly<Record<(typeof RETRIED_KINDS)[number], boolean>>;
}

/** The terms a failed call is made again under, from the settings. */
export function retryTermsOf(settings: RetrySettings): RetryTerms {
  return { retries: settings.retries, wait: settings.retryWait, growth: settings.retryGrowth, most: settings.retryMost, asked: settings.retryAsked, kinds: RETRIED_KINDS.filter((kind) => settings.retryOn[kind]) };
}

/** Whether a failure is made again under the terms, its kind's switch on and a try left: `tried` is how many tries it was made again already. */
export function retried(terms: RetryTerms, failure: CallFailure, tried: number, retries = terms.retries): boolean {
  return tried < retries && (RETRIED_KINDS as readonly CallFailureKind[]).includes(failure.kind) && terms.kinds.includes(failure.kind);
}

/** The wait before a try, in milliseconds: `tried` tries made again before it, the wait grown that many times, the provider's asked wait where it is kept to, never past the longest. */
export function retryWait(terms: RetryTerms, tried: number, asked?: number): number {
  const grown = terms.wait * terms.growth ** tried;
  return Math.min(terms.most, terms.asked && asked !== undefined ? Math.max(grown, asked) : grown);
}
