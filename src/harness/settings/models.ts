// The settings of the model layer (§13.2, §13.3; Appendix D.1 l.2416-2418; READINGS N-9), under
// `calls` in a config file: how long an answer that has begun may go silent, how long a provider has
// to answer a connection's test or list its models, how long a sign-in stays open; a test call's
// room, how much of a server's list of models is read, how much of a media address a refusal quotes,
// how long a failed sign-in's words are kept and how long any failure's words may be, and the length
// from which a secret is looked for anywhere in them; the wait before a failed call is made again,
// and how many times where its connection says nothing; how long a
// provider is asked to keep a prompt in its cache; how long a connection's model that refused
// native tools is offered them as text; each connection's throttle (§13.2): its requests and
// tokens a minute and its calls at once, with the calls at once of a connection that sets none; and
// the connection and model a host's search by meaning has its vectors made on (§9.4, §10.5), none
// until he names one, with how many texts go in each of its requests.
// Times are in seconds, that last in minutes, the list in megabytes.
//
// What these govern often has no chat in view (a connection's test, a sign-in, a request passed
// through), so each is read at the levels every chat shares, shipped and global; the silent wait is
// read at an agent's chat's levels too. A throttle holds one connection across every agent, turn and
// job, so it is the same for every chat. An agent's thinking effort is no setting: it is its
// definition's alone (READINGS N-7).

import { worded } from "./entry";
import { MODELS_WORDS } from "./models-words";

/** The levels every chat shares. */
const SHARED = ["shipped", "global"] as const;

const NO_LIMIT = "no limit";

export const MODELS = worded(
  {
    // Appendix D.1 l.2417: an answer that goes silent is ended after 5 minutes.
    silentAfter: { key: "calls.silentAfter", takes: { type: "whole", least: 1 }, default: 300, orNone: true, none: "no limit", perConnection: false, at: "calls.silentAfter", ms: true },
    providerWait: { key: "calls.providerWait", takes: { type: "whole", least: 1 }, default: 60, perConnection: false, levels: SHARED, at: "calls.providerWait", ms: true },
    signInOpen: { key: "calls.signInOpen", takes: { type: "whole", least: 1 }, default: 600, perConnection: false, levels: SHARED, at: "calls.signInOpen", ms: true },
    // Enough for any provider's smallest answer (OpenAI asks at least 16), little enough to cost nothing to speak of.
    testRoom: { key: "calls.testRoom", takes: { type: "whole", least: 1 }, default: 64, perConnection: false, levels: SHARED, at: "calls.testRoom" },
    // Lists of hundreds of models run to a few megabytes; an answer without end would otherwise grow until the process is restarted.
    listMost: { key: "calls.listMost", takes: { type: "whole", least: 1 }, default: 8, perConnection: false, levels: SHARED, at: "calls.listMost" },
    quoted: { key: "calls.quoted", takes: { type: "whole", least: 1 }, default: 80, perConnection: false, levels: SHARED, at: "calls.quoted" },
    // Long enough for a page that asks every few seconds, or one the user comes back to, to say why.
    signInWordsKept: { key: "calls.signInWordsKept", takes: { type: "whole", least: 0 }, default: 600, perConnection: false, levels: SHARED, at: "calls.signInWordsKept", ms: true },
    // A server's error body can be any length, and a page or a log line has no use for more.
    wordsMost: { key: "calls.wordsMost", takes: { type: "whole", least: 1 }, default: 2000, perConnection: false, levels: SHARED, at: "calls.wordsMost" },
    // Today's 8: a secret this long is looked for anywhere in a text, a shorter one as a word of its own, where it can't be part of an ordinary word.
    secretFloor: { key: "calls.secretFloor", takes: { type: "whole", least: 1 }, default: 8, perConnection: false, levels: SHARED, at: "calls.secretFloor" },
    // Appendix D.1 l.2416: 1 second, then twice the wait before; a connection's own count of tries stands over `retries`.
    retryWait: { key: "calls.retryWait", takes: { type: "whole", least: 0 }, default: 1, perConnection: false, levels: SHARED, at: "calls.retryWait", ms: true },
    retries: { key: "calls.retries", takes: { type: "whole", least: 0 }, default: 2, perConnection: false, levels: SHARED, at: "calls.retries" },
    cacheRetention: { key: "calls.cacheRetention", takes: { type: "oneOf", values: ["none", "short", "long"] }, default: "short", perConnection: false, levels: SHARED, at: "calls.cacheRetention" },
    // §13.2 "moved as it is": Build 1's 60 minutes, then native tools are tried again.
    toolRefusalMinutes: { key: "calls.toolRefusalMinutes", takes: { type: "whole", least: 1 }, default: 60, perConnection: false, levels: SHARED, at: "calls.toolRefusalMinutes" },
    // Today's `connections.throttles` and `connections.atOnce` (LumiAH provider.ts:606-660, 718-735), each none: a connection is held to nothing until he sets it.
    // By the connection's name or id, under `connections` as `jobs.connections` is, so `throttles.atOnce` is never taken for a connection's name.
    requestsPerMinute: { key: "throttles.connections.<connection>.requestsPerMinute", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: true, levels: SHARED, at: "calls.throttles.connections.<connection>.requestsPerMinute" },
    tokensPerMinute: { key: "throttles.connections.<connection>.tokensPerMinute", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: true, levels: SHARED, at: "calls.throttles.connections.<connection>.tokensPerMinute" },
    connectionAtOnce: { key: "throttles.connections.<connection>.atOnce", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: "as every connection", perConnection: true, levels: SHARED, at: "calls.throttles.connections.<connection>.atOnce" },
    atOnce: { key: "throttles.atOnce", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, levels: SHARED, at: "calls.throttles.atOnce" },
    // §9.4, §10.5: nothing is searched by meaning until he names a connection for it, and a model on it.
    embeddingConnection: { key: "embedding.connection", takes: { type: "text" }, default: null, orNone: true, none: "no search by meaning", perConnection: false, levels: SHARED, at: "calls.embedding.connection" },
    embeddingModel: { key: "embedding.model", takes: { type: "text" }, default: null, orNone: true, none: "none named", perConnection: false, levels: SHARED, at: "calls.embedding.model" },
    // A few dozen texts a request: well under every provider's own most (Google's is 100).
    embeddingBatch: { key: "embedding.batch", takes: { type: "whole", least: 1 }, default: 64, perConnection: false, levels: SHARED, at: "calls.embedding.batch" },
  },
  MODELS_WORDS,
);

/** Keys this group once read and reads no longer, each with what holds in its place: a file that still sets one is told so in the log. */
export const MODELS_GONE: Readonly<Record<string, string>> = {
  "effort.connections": "an agent thinks at the effort its definition gives, or where it gives none at its connection's own",
};
