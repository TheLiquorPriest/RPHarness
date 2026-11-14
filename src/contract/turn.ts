// One request to answer (§10.1, §10.2), where its reply goes (§10.7), and how the lead's run ended.

import type { HistoryRange } from "./chat";
import type { AgentRef, Scope, Usage } from "./common";
import type { ContextBlock } from "./events";
import type { PromptMessage } from "./prompt";

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
  /**
   * The reply went out with no intent record of the turn taken before it (§10.3): none was written,
   * or the host had not taken it when the user's bound on that wait (`reply.intentWait`) ran out.
   */
  withoutIntent?: true;
}

/** A limit the user sets (§10.11): model calls, tokens in and out, wall time, sub-agent depth and count, and jobs started in a day (§13.5). */
export type LimitName = "calls" | "tokensIn" | "tokensOut" | "time" | "depth" | "agents" | "jobs";

/** A limit reached: which, over what (a turn, one agent, one job's run, or the user's day: the daily caps), the limit and the count. */
export interface LimitHit {
  limit: LimitName;
  per: "turn" | "agent" | "job" | "day";
  max: number;
  value: number;
  /** For a limit per agent: whose. */
  agent?: AgentRef;
  /** For a day's count of jobs on one connection: which, by the name or id its setting gives. */
  connection?: string;
}

/**
 * Why the reply failed, as facts: no reply was released (§10.7); a limit was reached; the model's
 * provider failed (`detail`: its own words); the signal stopped the turn; or RPH itself failed.
 * The host says it in its own words.
 */
export interface ReplyError {
  code: "no-reply" | "limit" | "provider" | "stopped" | "failed";
  limit?: LimitHit;
  detail?: string;
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
