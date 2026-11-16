// What every part of the contract uses: where a call happens (`Scope`, or `UserScope` for a call
// that acts for a user and no chat), which agent acts (`AgentRef`), what model calls cost in tokens
// (`Usage`), how hard a model reasons (`Effort`), a found thing (`SearchHit`), time (`Clock`) and
// diagnostics (`Log`).

import type { JsonValue } from "./json";

/**
 * Where a call happens: whose it is, which chat, which session of that chat, and which turn when
 * there is one. Every port call that reads or writes for an agent carries one, and the host limits
 * what it gives to that user's data (§4.4: every read is limited to its own user's rows).
 */
export interface Scope {
  /** The user the host serves. */
  user: string;
  /** The chat. */
  chat: string;
  /**
   * The session the work belongs to: for a turn, the session of the scene it is played in (§11);
   * for a job or a talk with an agent, the session that run opened.
   */
  session: string;
  /**
   * The turn, when the work belongs to one: the turn being answered, or the turn that started a job
   * (§13.5: jobs are tied to a turn when they come from one). Absent for work tied to no turn: a job
   * the user started, a talk with an agent.
   */
  turn?: string;
}

/**
 * The scope of a call that acts for a user and no chat (READINGS R-52; Appendix B: every table
 * carries the user): what is the user's across his chats, as his day's counts, his connections and
 * his keys. Every `Scope` is one too, so a call made for a chat may be given where this is taken; the
 * host keeps what it holds for one user apart from every other user's.
 */
export interface UserScope {
  /** The user the host serves. */
  user: string;
}

/**
 * Where a job the owner starts for no chat runs (C-23; the Build page's model jobs): the user and
 * the job's own session, which sits at the user's level; no chat and no turn. Its files are the
 * shipped and global levels (C19).
 */
export interface UserSessionScope extends UserScope {
  /** The job's own session, at the user's level. */
  session: string;
  chat?: undefined;
  turn?: undefined;
}

/**
 * Where a run's work happens: a chat's (`Scope`), or that of a job of no chat (`UserSessionScope`).
 * Every port and tool a job's run reaches takes this, and one that cannot do its work without a chat
 * says so in its own words; `answer`, `talk` and a turn's own work keep a chat.
 */
export type RunScope = Scope | UserSessionScope;

/** One agent of a run, as RPH names it to the host: for the record of who wrote what, for dropping one agent's staged writes, and for who reads lore. */
export interface AgentRef {
  /** The agent's handle, unique within its run (a turn, a job or a talk). The lead continues a sub-agent by it (§13.4). */
  id: string;
  /** The definition it runs as: the name of its definition file (`gm` for `agents/gm.md`). */
  definition: string;
  /** The handle of the agent that started it; absent for the agent its run started with (a turn's lead, a job's agent). */
  parent?: string;
  /** The job it runs in, when it runs in one. */
  job?: string;
  /**
   * The character it plays, by the host's id for that character, when it plays one (a character's
   * agent, §13.4), as the agent that started it said. Absent for an agent that plays none (the lead,
   * the GM). A host that keeps who may know a lore entry reads by it (`LorePort`, §9.4).
   */
  plays?: string;
}

/**
 * Model calls and their tokens: one call's, one agent's, or a whole run's. Limits (§10.11) and the
 * window gauge are counted from these.
 */
export interface Usage {
  /** Model calls made. */
  calls: number;
  /** Tokens sent, cached ones included. */
  input: number;
  /** Of `input`, the tokens the provider read from its cache. */
  cacheRead: number;
  /** Of `input`, the tokens the provider wrote to its cache. */
  cacheWrite: number;
  /** Tokens written, reasoning included. */
  output: number;
  /** Of `output`, the model's reasoning, where the provider reported it. */
  reasoning?: number;
}

/** How hard a model reasons on a call: pi's levels (`ThinkingLevel`), from off to the most the model offers. */
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * One thing a search found, in any store a search reaches (the host's other stores, the searchers
 * `gap_check` uses). What was searched and what came back is saved as evidence (§10.5), so a hit
 * carries what an agent needs to read it again.
 */
export interface SearchHit {
  /** What was found, by the name the store reads it again by (an entry's id, a record's path). */
  ref: string;
  /** Its title or name. */
  title: string;
  /** The words around the match. */
  snippet: string;
  /** How it matched: by the names and words given, or by meaning where the host has that set up (§10.5). */
  how: "words" | "meaning";
}

/**
 * Time, as the host keeps it. Everything in RPH that waits, times out or stamps a time goes through
 * here, so a test can run the clock by hand.
 */
export interface Clock {
  /** Now, in milliseconds since 1970 (UTC). */
  now(): number;
  /** Runs `run` once after `ms` milliseconds; the handle cancels it. A silent turn's progress line (§10.7) and every wait are built on this. */
  setTimeout(run: () => void, ms: number): unknown;
  /** Cancels a `setTimeout` that has not run yet; a handle already run or cancelled is passed over. */
  clearTimeout(handle: unknown): void;
}

/** How serious a log line is. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * The host's log, for whoever runs the host. Never shown to an agent and never sent to a model.
 * `fields` carry the facts of the line (ids, counts, codes); never a secret.
 */
export interface Log {
  debug(message: string, fields?: Record<string, JsonValue>): void;
  info(message: string, fields?: Record<string, JsonValue>): void;
  warn(message: string, fields?: Record<string, JsonValue>): void;
  error(message: string, fields?: Record<string, JsonValue>): void;
}
