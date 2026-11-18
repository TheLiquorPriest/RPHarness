// What RPH offers its host (Appendix A `Harness`): answer a turn, hear that a turn left the path,
// talk with an agent, and the pages' ways in (jobs, sessions, rules, the live view, usage,
// definitions, models). `createHarness` builds one over an environment.

import type { AgentRef, Effort, RunScope, Scope, Usage, UserScope } from "./common";
import type { Environment } from "./environment";
import type { RuleFiring } from "./events";
import type { LayerLevel } from "./files";
import type { ModelsApi, ToolsAs } from "./models";
import type { TraceDelta, TraceRecord } from "./trace";
import type { JobPage, JobQuery } from "./store";
import type { Carry, LimitHit, ReplySink, TurnOutcome, TurnRequest } from "./turn";
import type { ListedFact } from "./facts";
import type { JsonObject, JsonSchema } from "./json";
import type { PromptMapApi } from "./prompt";
import type { ExternalApi, SwitchState } from "./switches";

// ---------------------------------------------------------------- jobs

/**
 * Where a job stands (§13.5): waiting for a place, held by the owner while it waits, running, held
 * at the point its start named to ask him whether to go on, ended with its report, failed,
 * cancelled, cut off because its turn left the path, or found running after a restart.
 */
export type JobState = "queued" | "held" | "running" | "asking" | "done" | "failed" | "cancelled" | "off-path" | "interrupted";

/**
 * Who ended a job before its agent was done (§13.5): an agent, by its `job_cancel`, with the run it
 * worked in; the person, by his own press; or RPH itself, and why: a limit of his reached (the job's
 * `limit` says which), the turn that started it left the path, the host stopping RPH, or a restart
 * that found it cut off.
 */
export type JobStopper = { by: "agent"; agent: AgentRef; run: string } | { by: "user" } | { by: "engine"; reason: "limit" | "off-path" | "stopping" | "restart" };

/** A job as the Jobs page lists it. */
export interface JobView {
  id: string;
  /** The definition its agent runs as. */
  agent: string;
  /** What it was asked to do. */
  brief: string;
  state: JobState;
  /** Its chat, its own session, and the turn that started it, where one did (§13.5: tied to the turn). */
  scope: RunScope;
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
  /** For a job that was ended before its agent was done (cancelled, at a limit, off the path, interrupted): who ended it. */
  stoppedBy?: JobStopper;
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
  /** What the owner gave it beyond its limits by carrying it on, each added up over every time he did: each adds to the limit it names, its run counting on from what it had spent (`time`: seconds of the run that goes on). */
  more?: JobLimits;
  /** For a tag check (C-20): the connection it measures, by id. Its `agent` is `tag-check`, the part whose turns it plays. */
  check?: { connection: string };
}

/**
 * A tag check's record for one of his connections (§10.7 l.1285, §14 l.1563; C-20): the simple turns
 * it played on the connection under the shipped reply contract, how many came back with the reply and
 * the intent record each in its tags, against the count the tag form needs (`reply.check.kept`), and
 * the form that set for the connection (`connections.<connection>.reply.form` in his global config, his to
 * change after; `set` false where the file could not be written). The newest check of each stands.
 */
export interface TagCheck {
  /** The connection's id, and its name when the check ran. */
  connection: string;
  name: string;
  /** The model that answered. */
  model: string;
  tried: number;
  kept: number;
  needed: number;
  form: "tags" | "two-step";
  set: boolean;
  /** When it ended. */
  at: number;
  /** The job that ran it. */
  job: string;
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
  /** Seconds of the job's run, as `jobs.run.seconds` is written. */
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
  | { refused: "state"; id: string; state: JobState; applies: JobState[] }
  /** The job did not stop at one of its own limits, so more of one would not let it go on. */
  | { refused: "not-at-limit"; id: string }
  /** His job-start hook kept the job from starting (§5.4 "Hooks"): the hook, and its reason in its own words. */
  | { refused: "hook"; hook: string; reason: string }
  /** A tag check named none of his connections. */
  | { refused: "connection"; connection: string }
  /** A tag check's part is missing, switched off or not as it needs: `tag-check` holds no turn, or `reply-contract` names no tags. */
  | { refused: "part"; part: "tag-check" | "reply-contract" };

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
   * from the owner's own presses (C-5, C-24). A scope with a chat starts a job of that chat; one that
   * names only the user starts a job of no chat (C-23: the Build page's model jobs), whose files are
   * the shipped and global levels and whose session sits at the user's level.
   */
  start(scope: Scope | UserScope, start: JobStart): Promise<JobView | JobRefusal>;
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
  /**
   * A job that stopped at one of its own limits goes on from its own session, where it stood, with
   * more of each limit `more` names, added to what it had. Owner's presses only (C-24).
   */
  carryOn(user: string, id: string, more: JobLimits): Promise<JobView | JobRefusal>;
  /** An interrupted job goes on from the last call its own session holds, with what it had done and spent. Owner's presses only (C-24). */
  resume(user: string, id: string): Promise<JobView | JobRefusal>;
  /** The owner's answer to a job that asks: it goes on in its own session, or ends with what it has. Owner's presses only (C-24). */
  answer(user: string, id: string, answer: JobAnswer): Promise<JobView | JobRefusal>;
  /**
   * Starts a tag check of one of his connections, by id or name (C-20): a job that plays the turns of
   * `.prompts/tag-check.md` on it, each a fresh simple turn under the shipped reply contract in its tag
   * form, counts those whose reply and intent record came back in their tags, keeps the record, and
   * sets the connection's form from it. Owner's presses only (C-24).
   */
  tagCheck(user: string, connection: string): Promise<JobView | JobRefusal>;
  /** The newest tag check of each of his connections that had one, for the Connections page. */
  tagChecks(user: string): Promise<TagCheck[]>;
}

// ---------------------------------------------------------------- sessions

/**
 * Who started a run that is a session of its own (S-5, §13.4): the agent and tool call that started
 * it, in the session and turn they worked in; or the owner, for a job he started.
 */
export type SessionParent = { session?: string; turn?: string; agent: string; call: string } | { owner: true };

/**
 * A session (§11): one scene of the story, or one agent's run (§13.4: each sub-agent, job and talk
 * thread is a session of its own), as a file of entries in a tree.
 */
export interface SessionView {
  id: string;
  user: string;
  chat: string;
  /** What it is (S-5): a scene's, a sub-agent's run, a job's run, or a talk thread. */
  kind: "scene" | "agent" | "job" | "talk";
  /** For an agent's, a job's or a talk's: what started it (S-5). */
  parent?: SessionParent;
  /** For an agent's, a job's or a talk's: the agent's definition. */
  agent?: string;
  /** An agent's run whose turn has left the path (a swipe, a delete): its file is kept, and a branch reads it where it was played. */
  offPath?: true;
  state: "open" | "closed";
  opened: number;
  /** The turn that closed it; closing belongs to that turn (§11). For the owner's own close, the chat's newest turn when he closed it, after which the closing hangs. */
  closedBy?: string;
  /** The closing that stands was the owner's own (S-3): his `reopen` takes it back. */
  by?: "user";
  /** The session and turn it was forked from, for a branch (§10.10). */
  from?: { chat: string; session: string; turn: string };
  /** Turns played in it. */
  turns: number;
  /** A compaction the host asked for (`compact`), waiting for the session's next turn. */
  compactAsked?: true;
  /** On `close`'s answer alone: his session-close hook kept it open (§5.4 "Hooks"), the hook and its reason in its own words, which the page that closed it shows. */
  held?: { hook: string; reason: string };
  /** On `close`'s answer alone: what his session-close hooks added, which the host puts after the scene summary the next session opens with. */
  hooked?: string;
}

export interface SessionsApi {
  /**
   * Opens the session `scope.session` (a scene opens, §11), starting from `summary`: the summary
   * the previous scene's session closed with.
   */
  open(scope: Scope, opening?: { summary?: string }): Promise<SessionView>;
  /**
   * The host's word on the summary an open session opens with from then on (S-6, §11), given after it
   * opened: a scene before's summary written or corrected later. The newest given stands, in every
   * mode and beside a compaction's summary, from the next turn that starts; the summary it already
   * opens with writes nothing; an empty one, none.
   */
  opensWith(scope: Scope, summary: string): Promise<SessionView>;
  /**
   * Closes it, as the work of `scope.turn` (§11: if that turn is swiped or deleted, the session is
   * open again). With `by: "user"`, the owner's own close (S-3): hung after `scope.turn`, the chat's
   * newest turn on the path, so a swipe or delete of that turn takes it back; owner's presses only
   * (C-24). Without a turn, the host's own close, which holds on every path.
   */
  close(scope: Scope, how?: { by: "user" }): Promise<SessionView>;
  /** Takes back the owner's own closing that stands (S-4, his Undo, §10.10); a turn's closing stands until its turn leaves the path. Owner's presses only (C-24). */
  reopen(scope: Scope): Promise<SessionView>;
  /** A branch (§10.10): `to` starts as `from` stood at `from.turn`. */
  fork(from: Scope & { turn: string }, to: Scope): Promise<SessionView>;
  /** Compacts it at the start of its next turn, on the user's word (§11). */
  compact(scope: Scope): Promise<SessionView>;
  get(scope: Scope): Promise<SessionView | undefined>;
  /**
   * A page of the chat's sessions, in the order opened (S-7): `sessions.page` of them unless `limit`
   * asks for fewer or more, from after the session `after` names; `next`, where the next page starts,
   * while more are left. Listed from the chat's index of its sessions: no session file is read.
   */
  list(user: string, chat: string, page?: { after?: string; limit?: number }): Promise<{ sessions: SessionView[]; next?: string }>;
  /** What the session's next turn would carry in mode `carry` (S-8, §14 Sessions): block 3 as it would go, laid out by the carried part; empty where it would carry nothing. */
  carried(scope: Scope, carry: Carry): Promise<string>;
  /** Each compaction of the session, in the order written (S-8): its summary, the turn that wrote it, what it stands for, why, its sizes, and whether it still stands. */
  compactions(scope: Scope): Promise<CompactionView[]>;
  /** Undoes a summary (S-8, R-38's "Undo the summary"): from the next turn the turns it stood for are carried whole again, until a later compaction; the file keeps both. Owner's presses only (C-24). */
  uncompact(scope: Scope, id: string): Promise<CompactionView[]>;
}

/** A compaction as the Sessions page shows it (S-8). */
export interface CompactionView {
  /** Its entry's id in the session file: what `uncompact` names. */
  id: string;
  /** The turn whose work it was. */
  turn: string;
  summary: string;
  at: number;
  /** What it summarized: the session's earlier turns, or a run's own older calls. */
  of: "turns" | "run";
  /** The turns it stands for (of earlier turns), oldest first; empty where the entry was written before they were kept. */
  turns: string[];
  reason?: "would-not-fit" | "refused" | "asked" | "fold";
  /** The request's size as counted, before and after, in tokens. */
  before?: number;
  after?: number;
  /** Whether it still stands on the session's path: on it, not undone, and no turn it stood for left since. A run's own summary stands for nothing a later turn carries. */
  stands: boolean;
  /** The owner undid it. */
  undone?: true;
}

// ---------------------------------------------------------------- rules

/** How a rule is triggered (§5.4): always on; a pattern; a question to a judging model; a moment, alone or with a fact; a moment whose command answers yes or no (C5); an interval. */
export type RuleTrigger = "always" | "pattern" | "question" | "moment" | "command" | "interval";

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
  /** A `command` rule's command line, as written, and where it stands as the host's switches say (C5): one that waits does nothing. */
  command?: { runs: string; state: SwitchState };
  /** In force now. */
  inForce: boolean;
  /**
   * Why not: switched off; a file its `needs:` names is not in force (§5.4); it is one of the
   * examples under `examples/`, where nothing is in force (§5.4); its header or text does not
   * parse; or, for a question rule, its question cannot be put (`judge` says what is missing).
   */
  why?: "off" | "needs" | "example" | "broken" | "judge";
  /** For a question rule that cannot be asked (§5.4, §17.2): the judging model's part is missing or switched off (`part`), names no `yes:` (`yes`), or the connection that judges is none of his (`connection`). */
  judge?: "part" | "yes" | "connection";
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
  /**
   * Switches a rule on or off at the chat's or the global level (C-10, Appendix A): the `stack.off` list of
   * that level's config file, written through the file port on the owner's word (his own press: it
   * is on `OWNER_ONLY`). A rule switched off at a farther level stays off whatever a nearer one says.
   * The rule as it then stands; undefined when no rule has the name.
   */
  switch(scope: Scope, rule: string, on: boolean, level: "chat" | "global"): Promise<RuleView | undefined>;
  /**
   * Runs one rule, as it reads now, against a past turn's record (§5.4: "the Rules page can run any
   * rule against a past turn"), and writes nothing (C-10): a pattern against each message, thinking,
   * tool call and result of the agents it names in that turn and against its reply; a moment's fact
   * as of that turn; an interval by the turn's count in its session; a question put to the judging
   * model about each recorded message, shown in the live view. Whether it would have fired, and each
   * firing with what matched. A rule of no such name rejects in words.
   */
  test(scope: Scope, rule: string, turn: string): Promise<RuleTest>;
  /** Every fact a rule can name (§5.4 "Facts"), RPH's own and the host's, each with what it counts, its groups and its fields; a host fact named like one of RPH's is marked, and told to the log. */
  facts(scope: Scope): Promise<ListedFact[]>;
}

// ---------------------------------------------------------------- the chat's own parts

/** Which of the chat's own layered files `parts` reads (C17): a prompt part (`.prompts/`), a tool's description (`.tools/<name>.md`), or a skill. Definitions, rules and notes have members of their own. */
export type PartFileKind = "prompt" | "tool" | "skill";

/** A layered file as the chat's levels give it: the nearest level's. */
export interface PartRead {
  kind: PartFileKind;
  name: string;
  /** The file's whole text, header and body. */
  text: string;
  path: string;
  level: LayerLevel;
  /** In force: not switched off (`stack.off`), and it reads whole. */
  inForce: boolean;
  /** Why not, where it is not. */
  why?: "off" | "broken";
}

/** A part rendered (C17, C-12): the fields it takes, its text with the values given, and what keeps it from reading. */
export interface PartPreview {
  /** Every field it names, put in or tested, in the order first named; of a part of lines, every line's. */
  fields: string[];
  /** Its render; absent where the text does not parse. A part of lines renders as its lines, `name: text`, one a line. */
  text?: string;
  /** The fields it put in that had no value. */
  missing: string[];
  /** Why the text does not read, or what of it is shown as written, each with its line. */
  problems: { line?: number; message: string }[];
}

/**
 * The chat's own layered parts (C17, C-12): read as the levels give them, rendered, previewed from a
 * draft, and the values each was last rendered with for an agent of the chat. Reads only: nothing
 * here changes which level wins. A skill is read and never rendered (it has no fields).
 */
export interface PartsApi {
  /** The file of that kind and name as the chat's levels give it; undefined when no level has one. */
  read(scope: Scope, kind: PartFileKind, name: string): Promise<PartRead | undefined>;
  /** A part in force rendered with the values given; undefined when none is in force. */
  render(scope: Scope, kind: "prompt" | "tool", name: string, fields: JsonObject): Promise<PartPreview | undefined>;
  /** A part's text, as saved (no `text`) or as drafted, rendered with `fields`, else with the values it was last rendered with for an agent of this chat. */
  preview(scope: Scope, kind: "prompt" | "tool", name: string, text?: string, fields?: JsonObject): Promise<PartPreview>;
  /** The values the part was last rendered with for an agent of this chat (a part of lines: each line's, by its name); undefined before it ever was. */
  lastFields(scope: Scope, kind: "prompt" | "tool", name: string): Promise<JsonObject | undefined>;
  /** Keeps `fields` as a part's last values in this chat, for a part the host renders itself (RPE's world-state layout), where `lastFields` reads them. */
  keep(scope: Scope, kind: "prompt" | "tool", name: string, fields: JsonObject): Promise<void>;
}

// ---------------------------------------------------------------- the live view

/** A run going on now. */
export interface RunView {
  run: string;
  scope: RunScope;
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
 * its items in turn, the next once a promise it returns settles; one that has left more of a run's
 * items untaken than that run's setting `live.backlog` allows is cut off, so no run waits on it.
 */
export type LiveItem = { type: "event"; record: TraceRecord } | { type: "delta"; scope: RunScope; delta: TraceDelta } | { type: "cut"; behind: number };

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
  /**
   * What the user's agents spent over the last 24 hours, turns and jobs alike: what the daily cap of
   * every agent counts (§10.11). Asked for `"jobs"`, his jobs' agents' alone: what the jobs' daily
   * cap (`jobs.tokensPerDay`) counts.
   */
  day(user: string, of?: "jobs"): Promise<Usage>;
  /** An agent's gauge, by its handle, while its run lasts. */
  window(scope: Scope, agent: string): Promise<WindowGauge | undefined>;
}

// ---------------------------------------------------------------- definitions

/**
 * An agent's limits as a definition's header and the settings write them (§5.4; §2.1 point 5):
 * `time` and `callTime` in seconds. Each absent is no limit of its own.
 */
export interface DefinitionLimitsView {
  calls?: number;
  tokensIn?: number;
  tokensOut?: number;
  time?: number;
  callTokensIn?: number;
  callTokensOut?: number;
  callTime?: number;
  toolRounds?: number;
  toolsPerAnswer?: number;
  toolsAtOnce?: number;
  messages?: number;
}

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
  /** Its limits, as its header's `limits:` sets them; absent where it sets none. */
  limits?: DefinitionLimitsView;
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
 * (C28), as the Agents page shows it, with what the settings at that scope set for it
 * (`agents.<definition>`, `connections.<connection>.effort`) standing over its header.
 */
export interface DefinitionRun {
  /** The connection its header names, by name or id; `default`, or none named, his default. Null where none is there. */
  connection: { id: string; name: string } | null;
  /** That connection's model; null where no connection resolves, or it names none. */
  model: string | null;
  /** The effort it thinks at: the settings' for its definition, else the settings' for its connection (`connections.<connection>.effort`), else its definition's, else its connection's own; null for its provider's own default. */
  effort: Effort | null;
  /** The level its model is sent for `effort`: the same, or the nearest the model has where it has none so high (a model with no `max` is sent `high`); null where the provider's own default stands, or no connection resolves. */
  sent: Effort | null;
  /** The limits it is held to: its header's, each one the settings set for it standing over it (`~` lifting it); absent where none holds. */
  limits?: DefinitionLimitsView;
}

/** A definition in force for a scope, as `definitions.list` gives it: with what it runs on. */
export interface ListedDefinition extends DefinitionView {
  runsOn: DefinitionRun;
}

/**
 * What an agent's requests carry as its fixed list (§6.8, Appendix D.1), as `definitions.declared`
 * gives it: each tool's name, description and schema exactly as declared, and the whole's size in
 * tokens as the model layer counts a call's tools; `most` is the
 * user's `tools.fixedTokens`, and a list over it is marked where it shows (nothing is refused).
 */
export interface DeclaredTools {
  tools: { name: string; description: string; parameters: JsonSchema }[];
  tokens: number;
  most: number;
}

/** A tool the registry holds for a scope, as `definitions.tools` lists it (C-T14): its name, its family, and whose it is: RPH's own, the host's, or his own from a manifest (C3). */
export interface RegisteredTool {
  name: string;
  family: string;
  from: "rph" | "host" | "owner";
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
 * What a part of an agent's opening block is (§5.2, §10.2): its definition; an instruction file; an
 * always-on rule; the reply contract (a lead's); the guide of a family of tools it holds; a held
 * tool's description, which its declaration carries in the cached front; the skills' index; or what
 * its definition's `opening:` names, as the host answered when the session opened.
 */
export type StackPartKind = "definition" | "instruction" | "rule" | "contract" | "guide" | "description" | "skills" | "given";

/**
 * One part of what an agent gets (§5.2): which part, the file it came from, and whether it sits in the
 * opening block or comes with the briefing. A part left out is listed too, with why, so the Files
 * page says so. Every part is listed, in the order the agent gets them: the opening's, then the
 * briefing's.
 */
export interface StackPart {
  kind: StackPartKind;
  /** Its name as `stack.off` lists name it: `agents/<name>`, an instruction file's name (`TURN`), `rules/<name>`, `prompts/reply-contract`, `tools/<family or tool>`, `prompts/skills`; for `given`, the item as `opening:` writes it. */
  part: string;
  /** The file it came from; for a part left out as `missing`, where it would be; for `given`, the definition that names it. */
  path: string;
  level: LayerLevel;
  /** SHA-256 of the file (for `given`, of its text), lower-case hex; absent for a part left out as `missing`. */
  hash?: string;
  /** Where it sits, or for a part left out, where it would. */
  where: "opening" | "briefing";
  /** Why it is left out; absent for a part in the stack. */
  left?: StackLeft;
  /** Its text as the agent gets it (a held tool's description as declared); absent when left out, and for `given` outside a session. */
  text?: string;
  /** For a part the briefing is handed: the situations that add it (`swipe`, `regenerate`; an always-on rule's `turns:`). */
  situations?: string[];
}

export interface DefinitionsApi {
  /** The definitions for a scope, each with what it runs on among the scope's user's connections (C28). */
  list(scope: Scope): Promise<ListedDefinition[]>;
  /** The exact stack an agent will get, and where each part came from (§5.2). */
  stack(scope: Scope, agent: string): Promise<StackPart[]>;
  /**
   * "Apply now" (R-119), the owner's own press (C-24): at the press, every lead's opening block of the
   * scope's session is made afresh from the files as they stand, the definition's tool list and
   * `given:` included, and kept in the session file as its newest; the first run of each that starts
   * after it takes that block, and a run already going keeps the block it started with to its end.
   * Held over a restart. A lead whose block cannot be made at the press has its old block put out of
   * force, and its next run makes it. A session with no block yet is left as it is.
   */
  apply(scope: Scope): Promise<void>;
  /**
   * What `agent`'s requests carry as its fixed list for a scope, built as a run builds it: for a lead
   * whose session is open, the list as the session opened it; else its definition's list as the
   * registry holds it now. With its size in tokens.
   */
  declared(scope: Scope, agent: string): Promise<DeclaredTools>;
  /** Every tool the registry holds for a scope, built as a run builds it (RPH's own and the host's, a host tool under one of RPH's names left out), each name once, in name order (C-T14). A read. */
  tools(scope: Scope): Promise<RegisteredTool[]>;
}

// ---------------------------------------------------------------- what a model call was sent

/** One message of a kept request, as it was sent: its role, its text, and the block RPH placed it as (`opening`, `prompt`, `briefing`, …), none for the run's own conversation. */
export interface KeptMessage {
  role: string;
  text: string;
  block?: string;
}

/** A message of a rebuilt request: as it was sent, and, where its text was kept as a place in a file of the turn's folder, that file, as a path in the agents' view. */
export interface RebuiltMessage extends KeptMessage {
  file?: string;
}

/**
 * A kept request rebuilt from the turn's folder (§5.3 l.495, §17.1 l.1764): every message as it was
 * sent, in order, each with the file its text points into where it points into one; each tool
 * declared with the file its description came from (none for a host's tool); and whether what was
 * rebuilt is what was sent (`same`, by the hash the file keeps).
 */
export interface RebuiltRequest {
  messages: RebuiltMessage[];
  tools: { name: string; file?: string }[];
  same: boolean;
}

/**
 * Something RPH finds wrong with one of the files it reads (an agent definition, a rule, a part, a
 * skill, a level's config, a tool's manifest, `mcp.json`, a level's `hooks.yml`), in words a user can
 * act on: the file as a path in the agents' view, its level, its line where one can be named, and
 * what to change. A problem never stops a turn: the file, or what of it does not read, is left out.
 */
export interface FileProblem {
  path: string;
  level?: LayerLevel;
  /** The line of the file, counted from 1. */
  line?: number;
  message: string;
}

// ---------------------------------------------------------------- the harness

export interface Harness {
  /**
   * Answers one turn. The reply goes to `sink` as it is written, ending at release with `finish`;
   * the lead's run may go on after (§10.9), and a kept sub-agent past it (§13.4). `TurnEvents.ended`
   * is told once the lead's run is over; resolves once every agent of the turn has ended. The signal
   * stops every agent of the turn.
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
   * `talk` is absent until the harness has it: a host asks whether it is there and offers what
   * depends on it only then. Nothing stands in for a missing one.
   */
  talk?(scope: Scope, agent: string, message: string, sink: ReplySink, signal?: AbortSignal): Promise<void>;
  /** Jobs and sessions are always there (Appendix A): a host offers them without asking. */
  jobs: JobsApi;
  sessions: SessionsApi;
  rules: RulesApi;
  live: LiveApi;
  usage: UsageApi;
  definitions: DefinitionsApi;
  models: ModelsApi;
  /** The prompt map as the Prompt page shows and edits it (C-9): RPH makes the owner's edits and keeps them when the map is learned again. */
  promptMap: PromptMapApi;
  /** Everything a scope's files name that runs a command or calls out, with where each stands (C3): what the pages and `rpe allow` list as waiting. */
  external: ExternalApi;
  /** The chat's own layered parts, for the Prompts page and its preview (C17). */
  parts: PartsApi;
  /**
   * An agent's kept request (the file its `call_started` names, C-17) rebuilt exactly as it was sent,
   * from the pointers into the turn's files it holds; undefined when there is no such file.
   */
  rebuildRequest(scope: Scope, file: string): Promise<RebuiltRequest | undefined>;
  /**
   * Every problem RPH finds in the files it reads for a scope (the Files page): a file that does not
   * read, a field it does not know, a name that finds no file. A file that does not parse at all,
   * whose hooks or rules are then none, is among them. With a scope of no chat, the shipped and
   * global levels' alone. A read: it changes nothing.
   */
  problems(scope: Scope | UserScope): Promise<FileProblem[]>;
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
