// What RPH offers its host (Appendix A `Harness`): answer a turn, hear that a turn left the path,
// talk with an agent, and the pages' ways in (jobs, sessions, rules, the live view, usage,
// definitions, models). `createHarness` builds one over an environment.

import type { AgentRef, Effort, Scope, Usage } from "./common";
import type { Environment } from "./environment";
import type { RuleFiring } from "./events";
import type { LayerLevel } from "./files";
import type { ModelsApi, ToolsAs } from "./models";
import type { TraceDelta, TraceRecord } from "./trace";
import type { JobPage, JobQuery } from "./store";
import type { LimitHit, ReplySink, TurnOutcome, TurnRequest } from "./turn";

// ---------------------------------------------------------------- jobs

/**
 * Where a job stands (§13.5): waiting for a place, held by the owner while it waits, running, held
 * at the point its start named to ask him whether to go on, ended with its report, failed,
 * cancelled, cut off because its turn left the path, or found running after a restart.
 */
export type JobState = "queued" | "held" | "running" | "asking" | "done" | "failed" | "cancelled" | "off-path" | "interrupted";

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
  /** What it has spent so far, kept at the end of each of its calls, so an interrupted job shows what it spent. */
  usage: Usage;
  /** What its agent last wrote, kept as it writes: its report once it ended, or for an interrupted job what it had done. */
  report?: string;
  /** For a job that ended at one of the user's limits (§10.11): which. It ends with what it has. */
  limit?: LimitHit;
  /** The attachments its start named, by name, kept with the rest of its start (agent, brief, limits, the turn in `scope`) so a job that waited can wait again after a restart. */
  attach?: string[];
  /** The limits of its own its start gave. */
  limits?: JobLimits;
  /** What its agent was not given: the names in `attach` nobody could find (§4.8). */
  missing?: string[];
  /** Each write it made, its sub-agents' included, in order, so an interrupted job shows what it had done. */
  wrote?: JobWrite[];
  /** For a job the owner started again (§13.5): the job it repeats, whose agent, brief, attachments and limits it has. */
  repeats?: string;
  /** For a job that asks (state `asking`): the ask point it reached, and the tokens it had spent when it did, counted as `JobLimits.tokens` is. */
  asks?: { at: number; tokens: number };
}

/** A write a job made: the tool, the lane it writes to where it names one, and the first line of the tool's own answer. */
export interface JobWrite {
  tool: string;
  lane?: string;
  line: string;
}

/**
 * Limits of one job's own run (§10.11), beside the user's `jobs.run` settings: each holds only where
 * it is tighter than the setting's, so a start can tighten what the settings allow and never loosen
 * it. Each is a whole number above 0; absent leaves the setting's alone.
 */
export interface JobLimits {
  /** Model calls across every agent of the job's run. */
  calls?: number;
  /** Tokens sent, cached ones included, across every agent of the job's run: each in full. */
  tokensIn?: number;
  /** Tokens written across every agent of the job's run: each in full. */
  tokensOut?: number;
  /**
   * Tokens sent and written together, counted as the day's job tokens are: a token read again from
   * a provider's cache at the weight the setting `jobs.cachedWeight` gives (a tenth of one by
   * default), every other token in full. The record of a job it stopped gives that count.
   */
  tokens?: number;
  /** Seconds of the job's run, as `jobs.run.time` is written. */
  time?: number;
  /**
   * Tokens, counted as `tokens` is, at which the job is held, not ended, and the owner is asked
   * whether to go on (R-31; bootstrap's 200,000): its state is `asking` until he answers. The
   * point is the owner's word and is no limit: the other limits hold as they did.
   */
  askAt?: number;
}

/** A job the user starts: the definition its agent runs as, what to do, what it is given by name, and limits of its own. A job held to one of them ends with what it has, and its record says which (`JobView.limit`). */
export interface JobStart {
  agent: string;
  brief: string;
  attach?: string[];
  limits?: JobLimits;
}

/** The owner's two switches over all of his jobs (today's Jobs page): none may start; every job held. Kept in the host's store, so a restart keeps them. */
export interface JobSwitches {
  /** Jobs switched off: no job may start, by an agent's `job_start` or by the owner; those waiting keep waiting. */
  off: boolean;
  /** All jobs held: each running one waits at its next call, and none starts, until he lets them go. */
  held: boolean;
}

/** The owner's answer to a job that asks: go on, with the point it asks at next (none: it asks no more), or end it with what it has. */
export type JobAnswer = { go: "on"; askAt?: number } | { go: "end" };

/**
 * Why no job was started, or why a control did nothing (§3.4: no sentence of RPH's own reaches a
 * person): the fact with its numbers, which the host words from its own file.
 */
export type JobRefusal =
  /** The owner switched jobs off. */
  | { refused: "off" }
  /** The day's count of jobs, of every job or of those on one connection, is reached. */
  | { refused: "day-count"; max: number; value: number; connection?: string }
  /** What jobs sent and wrote in the day counts as `value` tokens, and the setting allows `max`. */
  | { refused: "day-tokens"; max: number; value: number }
  /** A limit of the start is not a whole number above 0. */
  | { refused: "limit"; limit: keyof JobLimits; value: number }
  /** No agent definition by this name, or no model for it to run on. */
  | { refused: "agent"; agent: string }
  /** The user has no job by this id. */
  | { refused: "no-job"; id: string }
  /** The job is not in a state the control applies to. */
  | { refused: "state"; id: string; state: JobState; applies: JobState[] };

/**
 * The Jobs page's way to the jobs (§13.5). Each member names the user it acts for, and a job is found
 * only under its own user's name, so no user reads or stops another's job by its id (READINGS R-52).
 * After a restart, a job the store holds as under way and running is kept as interrupted, with what it
 * had done and spent, and told, on its user's first call here; one that was only waiting is queued
 * again from its kept start (§13.5). A list is such a call, so it is listed so. A host that wants that
 * done at its start, as before, calls `list` for each user it knows.
 */
export interface JobsApi {
  /** The user's jobs a page at a time, the latest started first: only that page is read (`JobQuery`). */
  list(filter: { user: string } & JobQuery): Promise<JobPage>;
  /** The user's job; undefined when he has none by that id. */
  get(user: string, id: string): Promise<JobView | undefined>;
  /** The user's two switches over all his jobs. */
  switches(user: string): Promise<JobSwitches>;
  /**
   * The user starts a job, or learns why none was started. Code never does (§13.5). Called only
   * from the owner's own presses (C-5, C-24).
   */
  start(scope: Scope, start: JobStart): Promise<JobView | JobRefusal>;
  /** Stops the user's job; undefined when he has none by that id. Owner's presses only (C-24). */
  cancel(user: string, id: string): Promise<JobView | undefined>;
  /** Sets either switch, or both, and answers how they stand. A job that waits starts only while neither is on. Owner's presses only (C-24). */
  setSwitches(user: string, change: Partial<JobSwitches>): Promise<JobSwitches>;
  /** Holds a job that waits for a place: it keeps its place and does not start until let go. Owner's presses only (C-24). */
  hold(user: string, id: string): Promise<JobView | JobRefusal>;
  /** Lets a held job that waits go on waiting. Owner's presses only (C-24). */
  letGo(user: string, id: string): Promise<JobView | JobRefusal>;
  /** Starts an interrupted, failed or cancelled job again, as a new job with the same agent, brief, attachments and limits, that names the one it repeats. Owner's presses only (C-24). */
  again(user: string, id: string): Promise<JobView | JobRefusal>;
  /** The owner's answer to a job that asks: it goes on in its own session, or ends with what it has. Owner's presses only (C-24). */
  answer(user: string, id: string, answer: JobAnswer): Promise<JobView | JobRefusal>;
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
  /** A compaction the host asked for (`compact`), waiting for the session's next turn. */
  compactAsked?: true;
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
  /** Compacts it at the start of its next turn, on the user's word (§11). */
  compact(scope: Scope): Promise<SessionView>;
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
  /** Whether it is held now: by the owner's pause, by all jobs held, or by a job that asks. */
  held: boolean;
}

/** Which runs to follow: a user's, one chat's, or one run. */
export interface LiveFilter {
  user: string;
  chat?: string;
  run?: string;
}

/**
 * What the live view is sent: every event, and the text of model calls as it streams; and, last, to
 * a listener cut off for falling behind (C29), how many items it had not taken. A listener is sent
 * its items in turn, the next once a promise it returns settles; one that has not taken more of a
 * run's items than that run's setting `live.backlog` allows is cut off, so no run waits on it.
 */
export type LiveItem = { type: "event"; record: TraceRecord } | { type: "delta"; scope: Scope; delta: TraceDelta } | { type: "cut"; behind: number };

export interface LiveApi {
  /** The user's runs going on now. */
  running(user: string): RunView[];
  /** Sends every item of the runs that match, as it happens. The returned function stops it. */
  subscribe(filter: LiveFilter, listener: (item: LiveItem) => void): () => void;
  /** Holds the user's run, every agent of it at its next call (C-19). False: he has no such run going on, or it was held already by his pause. Owner's presses only (C-24). */
  pause(user: string, run: string): boolean;
  /** Lets his pause of the run go; false where there was none. Owner's presses only (C-24). */
  letGo(user: string, run: string): boolean;
  /** Says something to the run's main agent, which hears it at its next call as the owner's words and the trace shows it (C-19); false: he has no such run, or the words are empty. Owner's presses only (C-24). */
  say(user: string, run: string, words: string): boolean;
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
  /** A run's calls and tokens, to the user whose run it is: asked by another user, or for a run that was never one, it answers undefined (§16: one user never reaches another's). */
  run(user: string, run: string): Promise<RunUsage | undefined>;
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
  /** How its tools are offered, as its header says (`tools_as:`); absent: auto. */
  toolsAs?: ToolsAs;
  /** Its fixed tools, the instruction files it reads, and what it is given at the start of a run. */
  tools: string[];
  reads: string[];
  given: string[];
  /** The definition its `write_reply` hands the prose to, as its header names it (§10.6, C8). Absent when it names none: code names no writer of its own. */
  writer?: string;
}

/**
 * What a definition runs on, resolved among the user's connections for the scope it is listed for
 * (C28), as the Agents page shows it. A fact: thinking effort is set in definitions alone.
 */
export interface DefinitionRun {
  /** The connection its header names, by name or id; `default`, or none named, his default. Null where none is there. */
  connection: { id: string; name: string } | null;
  /** That connection's model; null where no connection resolves, or it names none. */
  model: string | null;
  /** The effort it thinks at: its definition's; where it names none, its connection's own; null for its provider's own default. */
  effort: Effort | null;
}

/** A definition in force for a scope, as `definitions.list` gives it: with what it runs on. */
export interface ListedDefinition extends DefinitionView {
  runsOn: DefinitionRun;
}

/**
 * What an agent definition's body may name (§5.4). Its instructions are a template, and a sub-agent's
 * run (one `delegate` starts, a job's agent, the writer `write_reply` starts) fills it with these
 * fields and no others when it starts: `agent`, its handle this run (`gm-1`); `definition`, its
 * definition's name; `plays`, the character it plays as the agent that started it named it
 * (`delegate`'s `plays`, absent when it plays none). A body that names anything else is reported on
 * the Files page and has it put in empty. A lead's body is filled with none of them: its opening
 * block holds for the whole session, and its handle is new each turn.
 */
export interface BodyFields {
  agent: string;
  definition: string;
  plays?: string;
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
  /** The definitions for a scope, each with what it runs on among the scope's user's connections (C28). */
  list(scope: Scope): Promise<ListedDefinition[]>;
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
  /**
   * The host: this turn is off the path (swiped away, deleted, or dropped by the host because it kept
   * nothing of it: a stop before the reply's first word, a failure). Its work is cancelled, its jobs
   * too, and a session it closed is open again (§11, §13.5). Nothing else tells RPH a turn is gone: a
   * turn's own end, stopped or failed, leaves its jobs running.
   */
  turnLeft(scope: Scope): Promise<void>;
  /**
   * The host: this turn, an earlier attempt, is shown again (a swipe flipped back, on an earlier
   * reply too). It is on the path again in the place of the other attempts at its place, which are
   * off it, and the turns that followed them follow it: later turns carry it where they carried the
   * attempt it replaces (§6.3, §11).
   */
  turnShown(scope: Scope): Promise<void>;
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
