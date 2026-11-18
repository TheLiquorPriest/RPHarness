// One request to answer (§10.1, §10.2), where its reply goes (§10.7), and how the lead's run ended.

import type { HistoryRange } from "./chat";
import type { AgentRef, Scope, Usage } from "./common";
import type { ContextBlock } from "./events";
import type { PromptMessage } from "./prompt";
import type { CallFailureKind } from "./trace";

/** What a generation asks for (§10.10): a new reply, another attempt at one, more of one, or a draft for the player's own character. */
export type TurnKind = "new" | "swipe" | "regenerate" | "continue" | "impersonate";

/**
 * How much of the session's earlier turns the lead's context holds (§11): what it did, given as
 * text and compacted when it outgrows its room; its record of each turn; or only the summary the
 * session opened with.
 */
export type Carry = "continuing" | "records" | "nothing";

/** Sampling by its usual names, as a preset sets it (§10.2 "Sampling and length"); each one absent is the connection's own. */
export interface Sampling {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string[];
}

/**
 * Something that happened since the last turn (§10.10, §6.3), shown where the briefing's template
 * puts it. `text` is the host's, compiled from its own template; `kind` lets the template place it.
 * `edit`: a reply or an earlier message was edited (old and new text). `delete`: turns left the path.
 * `unplayed`: replies made without the host. `job`: a job finished, with what it changed. `awaiting`:
 * a change waits for the user. `restacked`: an earlier swipe was flipped, and later turns' changes
 * were applied again. `player-edit`: the user's own corrections. `saved-differs`: what the chat
 * application saved is not what was released. `cut-short`: part of a reply was saved. `swiped`:
 * another attempt of the newest reply is showing. `request`: something the user asked for outside
 * the chat (a panel, a page). `migrated`: the chat was carried over from an earlier system.
 */
export interface SinceItem {
  kind: "edit" | "delete" | "unplayed" | "job" | "awaiting" | "restacked" | "player-edit" | "saved-differs" | "cut-short" | "swiped" | "request" | "migrated";
  text: string;
  /** The turn it is about, where there is one. */
  turn?: string;
  /** The stretch of the chat it is about, where there is one. */
  range?: HistoryRange;
}

/** One request to answer. */
export interface TurnRequest {
  /** Where the turn is played; `turn` is the turn being answered, made by the host before it asks (§10.1 step 4). */
  scope: Scope & { turn: string };
  /**
   * The turn this one follows; where the session forks for a swipe (§10.10). Left out: the host
   * keeps no tree, and the turn follows the session's latest turn. `null`: the turn follows no turn
   * of the session, as the first turn and every swipe of it do.
   */
  parent?: string | null;
  kind: TurnKind;
  /**
   * Whether the run owes the player a reply (§10.7): absent or true, it does; false for a run that
   * writes nothing into the chat (one asked for to settle a turn's records, say). A fact, and
   * nothing more: the rules read it as `reply.owed` (1 while a reply is owed and none has been
   * released), and it changes nothing of how the run ends: when the lead's message makes no tool call, and as its rules say.
   */
  owesReply?: boolean;
  /** Who the reply speaks as, in a group chat (§10.10). */
  speaker?: string;
  /** Which agent definition leads. */
  lead: string;
  /** The assembled prompt, in order, exactly as the chat application sent it (§10.2 block 2). */
  prompt: PromptMessage[];
  /** History the window left out of the prompt, and whether the host's record covers each stretch (§4.2). */
  leftOut?: HistoryRange[];
  /**
   * The host's parts of the briefing, compiled from its templates (world state, lore map, story
   * brief, the story so far, §10.2 block 4). RPH adds its own: prompt notices, the text of rules
   * due at a turn's start, files added for this turn, files changed since the session opened.
   */
  briefing: ContextBlock[];
  carry: Carry;
  /** What the player asked for with the composer's controls or a panel, as lines for the briefing (§10.3, §10.10). */
  asked?: string[];
  /** What happened since the last turn. */
  since: SinceItem[];
  /** The preset's prefill: the start of the reply the chat application puts in front of it (§10.2 "A prefilled start"). */
  prefill?: string;
  /** The preset's sampling, applied exactly to a narrator's call (§10.2). */
  presetSampling?: Sampling;
  /** The preset's longest reply, in tokens. */
  replyMaxTokens?: number;
}

/** Which ways a reply was released (§10.6, §10.7): the lead's own text in the reply tag; the plain text of a message of its own (the two-step form); the narrator's draft, or the narrator live; a finished file. */
export type ReleaseForm = "tags" | "message" | "narrator" | "narrator-live" | "file";

/** The reply's release, as the host is told it (once per generation). */
export interface Release {
  /** The agent whose text was released, or who released a file. */
  by: AgentRef;
  form: ReleaseForm;
  /** For a file released: its path in the agents' view. */
  path?: string;
  /** The reply's length, in UTF-16 code units. */
  length: number;
}

/**
 * A limit the user sets (§10.11): model calls, tokens in and out (tokens sent counting a token read
 * again from the cache at `limits.cachedWeight`), tokens sent and written together (`tokens`: the
 * jobs' tokens in the user's day), wall time, sub-agent depth and count (the sub-agents one turn's or
 * one job's run may start), and jobs started (§13.5) in the user's day, or by the agents of one
 * turn's or one job's run; and an agent's own controls (C-M3): its prompt on one call
 * (`callTokensIn`), its answer (`callTokensOut`) and its time (`callTime`), its answers that call
 * tools, its own and the turn's (`toolRounds`), the same tool call with the same arguments in a row
 * with nothing written between (`repeats`, the loop's count), and a connection's tokens in a minute
 * (`tokensPerMinute`).
 */
export type LimitName = "calls" | "tokensIn" | "tokensOut" | "tokens" | "time" | "depth" | "agents" | "jobs" | "callTokensIn" | "callTokensOut" | "callTime" | "toolRounds" | "repeats" | "tokensPerMinute";

/** A limit reached: which, over what (a turn, one agent, one job's run, the user's day: the daily caps, or one connection: its throttle), the limit and the count. */
export interface LimitHit {
  limit: LimitName;
  per: "turn" | "agent" | "job" | "day" | "connection";
  max: number;
  value: number;
  /** For a limit per agent: whose. */
  agent?: AgentRef;
  /** For a day's count of jobs on one connection, or a connection's throttle: which, by the name or id its setting gives. */
  connection?: string;
}

/**
 * Why the reply failed, as facts: no reply was released (§10.7); a limit was reached; the model's
 * provider failed (`detail`: its own words); the signal stopped the turn; RPH itself failed; no
 * definition in force names the turn's lead (`no-definition`); or the connection's replies are marked
 * by tags and no reply contract in force names them (`no-tags`). The host says it in its own words.
 */
export interface ReplyError {
  code: "no-reply" | "limit" | "provider" | "stopped" | "failed" | "no-definition" | "no-tags" | "hook";
  /** For `hook`: the turn-start hook that blocked the turn (§5.4 "Hooks"); `detail` is its reason, in its own words. */
  hook?: string;
  limit?: LimitHit;
  detail?: string;
  /**
   * For `no-definition` and `no-tags`: the name of the agent definition the turn named as its lead. `no-definition`: no
   * file in force for the chat defines it. `no-tags`: the connection's replies are marked by tags (§10.7) and no reply contract
   * in force names them. RPH words neither: the host does, from its own file. For `failed`, `detail` is the failure's own words, never an RPH sentence
   * written in code; for a run whose session file could not be written, it is the shipped line `session_unwritten` (`.prompts/tool-notices.md`),
   * naming the file and the host's reason.
   */
  agent?: string;
  /**
   * For `no-reply`, `limit` and `stopped`: the lead's last plain text outside any mark, trimmed: in
   * the tag form, every tagged part (the intent record, a reply) and what it holds taken out; in the
   * two-step form, the message's text as is. It is the last of its messages in the run that ended
   * whole with any such text; absent when none had any. A host's setting may send it in place of its
   * own line (§10.7).
   */
  text?: string;
  /**
   * For `provider`: what broke the lead's last call (`failure`, a kind of `CallFailureKind`) and how
   * many times that call was made, its retries among them (`tries`), where the harness sorted it. The
   * host says it in its own words, with `detail`.
   */
  broke?: { failure: CallFailureKind; tries: number };
}

/**
 * Where the reply goes as it is written. `progress` lines go to the chat's thinking block (§10.7:
 * short progress lines only); `content` is the reply's text. It ends with exactly one `finish`, at
 * release, or one `error`; nothing follows.
 */
export interface ReplySink {
  progress(line: string): void;
  content(delta: string): void;
  /** The reply is complete; `usage` is the turn's so far. The lead's run may go on after it (§10.9). */
  finish(usage: Usage): void;
  error(e: ReplyError): void;
}

/** How a run ended: its reply released; no reply; stopped by the signal; a limit; or a failure. */
export type RunStatus = "released" | "no-reply" | "stopped" | "limit" | "failed";

/** How the lead's run ended, with what every agent of it spent. */
export interface RunOutcome {
  status: RunStatus;
  /** Whether a reply was released, whatever happened after. */
  released: boolean;
  /** For `limit`: which. */
  limit?: LimitHit;
  /** For `failed`: what failed. */
  error?: ReplyError;
  usage: Usage;
}

/** What `answer` gives back once the lead's run is over: the outcome and the reply as released (empty with none). */
export interface TurnOutcome extends RunOutcome {
  reply: string;
  form?: ReleaseForm;
}
