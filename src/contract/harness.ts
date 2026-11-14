// What RPH offers its host (Appendix A `Harness`): answer a turn, hear that a turn left the path,
// talk with an agent, and the pages' ways in (jobs, sessions, rules, the live view, usage,
// definitions, models). `createHarness` builds one over an environment.

import type { AgentRef, Effort, Scope, Usage } from "./common";
import type { Environment } from "./environment";
import type { RuleFiring } from "./events";
import type { LayerLevel } from "./files";
import type { ModelsApi } from "./models";
import type { TraceDelta, TraceRecord } from "./trace";
import type { ReplySink, TurnOutcome, TurnRequest } from "./turn";

// ---------------------------------------------------------------- jobs

/**
 * Where a job stands (§13.5): waiting for a place, running, ended with its report, failed,
 * cancelled, cut off because its turn left the path, or found running after a restart.
 */
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled" | "off-path" | "interrupted";

/** A job as the Jobs page lists it. */
export interface JobView {
  id: string;
  /** The definition its agent runs as. */
  agent: string;
  /** What it was asked to do. */
  brief: string;
  state: JobState;
  /** Its chat, its own session, and the turn that started it, where one did (§13.5: tied to the turn). */
  scope: Scope;
  /** Nothing starts a job but an agent's `job_start` or the user (§13.5). */
  startedBy: AgentRef | "user";
  started: number;
  ended?: number;
  usage: Usage;
  /** What its agent last wrote, once it ended: its report, or for an interrupted job what it had done. */
  report?: string;
}

/** A job the user starts: the definition its agent runs as, what to do, and what it is given by name. */
export interface JobStart {
  agent: string;
  brief: string;
  attach?: string[];
}

export interface JobsApi {
  list(filter: { user: string; chat?: string; states?: JobState[] }): Promise<JobView[]>;
  get(id: string): Promise<JobView | undefined>;
  /** The user starts a job. Code never does (§13.5). */
  start(scope: Scope, start: JobStart): Promise<JobView>;
  /** Stops a job; undefined when there is no such job. */
  cancel(id: string): Promise<JobView | undefined>;
}

// ---------------------------------------------------------------- sessions

/** A session (§11): one scene of the story, as a file of entries in a tree. */
export interface SessionView {
  id: string;
  user: string;
  chat: string;
  state: "open" | "closed";
  opened: number;
  /** The turn that closed it; closing belongs to that turn (§11). */
  closedBy?: string;
  /** The session and turn it was forked from, for a branch (§10.10). */
  from?: { chat: string; session: string; turn: string };
  /** Turns played in it. */
  turns: number;
}

export interface SessionsApi {
  /**
   * Opens the session `scope.session` (a scene opens, §11), starting from `summary`: the summary
   * the previous scene's session closed with.
   */
  open(scope: Scope, opening?: { summary?: string }): Promise<SessionView>;
  /** Closes it, as the work of `scope.turn` (§11: if that turn is swiped or deleted, the session is open again). */
  close(scope: Scope): Promise<SessionView>;
  /** A branch (§10.10): `to` starts as `from` stood at `from.turn`. */
  fork(from: Scope & { turn: string }, to: Scope): Promise<SessionView>;
  /** Compacts it now, on the user's word (§11). */
  compact(scope: Scope, signal?: AbortSignal): Promise<SessionView>;
  get(scope: Scope): Promise<SessionView | undefined>;
  list(user: string, chat: string): Promise<SessionView[]>;
}

// ---------------------------------------------------------------- rules

/** How a rule is triggered (§5.4): always on; a pattern; a question to a judging model; a moment, alone or with a fact; an interval. */
export type RuleTrigger = "always" | "pattern" | "question" | "moment" | "interval";

/** A rule as the Rules page lists it. */
export interface RuleView {
  name: string;
  path: string;
  level: LayerLevel;
  /** Its header's description; empty for a `broken` rule whose header does not give one. */
  description: string;
  /** Who it is for: every agent, or the definitions it names; none for a `broken` rule whose header does not say. */
  agents: "all" | string[];
  /** How it is triggered; absent for a `broken` rule whose header does not say. */
  trigger?: RuleTrigger;
  /** In force now. */
  inForce: boolean;
  /**
   * Why not: switched off; a file its `needs:` names is not in force (§5.4); it is one of the
   * examples under `examples/`, where nothing is in force (§5.4); or its header or text does not
   * parse.
   */
  why?: "off" | "needs" | "example" | "broken";
  /** The farther files of the same name it replaces (§5.2). */
  replaces: { level: LayerLevel; path: string }[];
}

/** A rule run against a past turn: whether it would have fired, and on what. */
export interface RuleTest {
  rule: string;
  turn: string;
  fired: boolean;
  firings: RuleFiring[];
}

export interface RulesApi {
  /** Every rule of the chat's stack, in force or not. */
  list(scope: Scope): Promise<RuleView[]>;
  /** Runs one rule against a past turn's record (§5.4: "the Rules page can run any rule against a past turn"). Absent until the harness has it; a host offers the page's button only when it is there. */
  test?(scope: Scope, rule: string, turn: string): Promise<RuleTest>;
}

// ---------------------------------------------------------------- the live view

/** A run going on now. */
export interface RunView {
  run: string;
  scope: Scope;
  what: "turn" | "job" | "talk";
  agents: AgentRef[];
  started: number;
}

/** Which runs to follow: a user's, one chat's, or one run. */
export interface LiveFilter {
  user: string;
  chat?: string;
  run?: string;
}

/** What the live view is sent: every event, and the text of model calls as it streams. */
export type LiveItem = { type: "event"; record: TraceRecord } | { type: "delta"; scope: Scope; delta: TraceDelta };

export interface LiveApi {
  /** The user's runs going on now. */
  running(user: string): RunView[];
  /** Sends every item of the runs that match, as it happens. The returned function stops it. */
  subscribe(filter: LiveFilter, listener: (item: LiveItem) => void): () => void;
}

// ---------------------------------------------------------------- usage

/** What one run spent, in all and by agent. */
export interface RunUsage {
  run: string;
  total: Usage;
  agents: { agent: AgentRef; usage: Usage }[];
}

/** How full an agent's context is (the window gauge): tokens it holds, its model's window, and the room kept for its answer. */
export interface WindowGauge {
  used: number;
  window: number;
  reserve: number;
}

export interface UsageApi {
  run(run: string): Promise<RunUsage | undefined>;
  /** What the user's runs spent on a day (`Clock.day`; today when absent): what the daily caps count (§10.11). */
  day(user: string, day?: string): Promise<Usage>;
  /** An agent's gauge, by its handle, while its run lasts. */
  window(scope: Scope, agent: string): Promise<WindowGauge | undefined>;
}

// ---------------------------------------------------------------- definitions

/** An agent definition as the Files page shows it (§5.4), and where it came from. */
export interface DefinitionView {
  name: string;
  description: string;
  path: string;
  level: LayerLevel;
  /** The farther files of the same name it replaces. */
  replaces: { level: LayerLevel; path: string }[];
  off: boolean;
  /** Its connection profile's name and effort, as its header says. */
  model?: string;
  effort?: Effort;
  /** Its fixed tools, the instruction files it reads, and what it is given at the start of a run. */
  tools: string[];
  reads: string[];
  given: string[];
}

/**
 * Why a part an agent's definition names is left out of its stack: no file at any level; switched
 * off; nothing in it but headings and comments; its header or text does not parse; or a file its
 * `needs:` names is not in force.
 */
export type StackLeft = "missing" | "off" | "empty" | "broken" | "needs";

/**
 * One part of an agent's stack (§5.2): which part, the file it came from, and whether it sits in the
 * opening block or comes with the briefing. A part left out is listed too, with why, so the Files
 * page says so.
 */
export interface StackPart {
  part: string;
  /** The file it came from; for a part left out as `missing`, where it would be. */
  path: string;
  level: LayerLevel;
  /** SHA-256 of the file, lower-case hex; absent for a part left out as `missing`. */
  hash?: string;
  /** Where it sits, or for a part left out, where it would. */
  where: "opening" | "briefing";
  /** Why it is left out; absent for a part in the stack. */
  left?: StackLeft;
}

export interface DefinitionsApi {
  list(scope: Scope): Promise<DefinitionView[]>;
  /** The exact stack an agent will get, and where each part came from (§5.2). */
  stack(scope: Scope, agent: string): Promise<StackPart[]>;
}

// ---------------------------------------------------------------- the harness

export interface Harness {
  /**
   * Answers one turn. The reply goes to `sink` as it is written, ending at release with `finish`;
   * the lead's run may go on after (§10.9). Resolves once the lead's run is over, after
   * `TurnEvents.ended`. The signal stops every agent of the turn.
   */
  answer(req: TurnRequest, sink: ReplySink, signal: AbortSignal): Promise<TurnOutcome>;
  /** The host: this turn is off the path (swiped away, deleted). Its work is cancelled, its jobs too, and a session it closed is open again (§11, §13.5). */
  turnLeft(scope: Scope): Promise<void>;
  /**
   * The user talks with an agent (the assistant, or one kept alive past the reply, §13.4); its answer goes to `sink`.
   * `talk`, `jobs` and `sessions` are absent until the harness has them: a host asks whether each is
   * there and offers what depends on it only then. Nothing stands in for a missing one.
   */
  talk?(scope: Scope, agent: string, message: string, sink: ReplySink, signal?: AbortSignal): Promise<void>;
  jobs?: JobsApi;
  sessions?: SessionsApi;
  rules: RulesApi;
  live: LiveApi;
  usage: UsageApi;
  definitions: DefinitionsApi;
  models: ModelsApi;
  /** Stops every run and job (a running job is kept as interrupted, §13.5) and waits for what RPH keeps to be written. */
  close(): Promise<void>;
}

/** What a host may set when it builds a harness that is neither a port nor one of the user's settings. */
export interface HarnessOptions {
  /** Makes RPH's own ids (agents' handles, jobs, runs, session entries); random UUIDs when absent. A test gives a counter so a run repeats exactly. */
  ids?: () => string;
}

/** Builds a harness over a host's environment. */
export type CreateHarness = (env: Environment, options?: HarnessOptions) => Harness;
