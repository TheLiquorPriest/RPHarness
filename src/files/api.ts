// What the rest of RPH asks of the guidance files (§5), and what it gets back. Everything an agent
// does by default is in a file the user can read, change or switch off; the code behind this API
// loads those files and holds no opinion of its own about how a turn is run.
//
// Who calls what:
// - The harness, when a session opens: `definition(name)` and `stack(name)` for the opening block,
//   whose builder (`openingOf`) takes `snapshot(agent, front)` of every part, kept with the session.
// - The harness, for each briefing (and before each later request of an agent that runs on): the
//   block made again from the files as they stand, and `changes(snapshot, front)` with `changesText`
//   for each part changed since the block was made. "Apply now" makes the block afresh.
// - The tools: `skills()` for the prompt's index, `skill(name)` for a body, `tool(name)` for a tool's
//   description.
// - The harness, wherever it sends a model text of its own: `part(name)`.
// - The runner, for the user's triggered rules: one `RuleRun` per run, from `ruleRun(options)`.
// - The pages: `definitions()`, `rules()` and `problems()`; an agent's whole opening block is the
//   harness's opening builder's (`openingOf`), over `stack(name)`. A run's start: `pins(name)`.
//
// The files, by kind (each kind's folder at each level is the host's, `Layer.folders`):
// - Instruction files: plain markdown at a level's root, named by a definition's `reads`
//   (`TURN` is `TURN.md`). No header. Never filled in.
// - Agent definitions, `<agents>/<name>.md`: a header (DEFINITION_FIELDS) and a body, a template that may name BODY_FIELDS.
// - Skills, `<skills>/<name>/SKILL.md`: a header and a body (SKILL_FIELDS).
// - Rules, `<rules>/<name>.md`: a header and a body (RULE_FIELDS). Under `<rules>/examples/` a rule is
//   listed and never in force.
// - Prompt parts, `<prompts>/<name>.md`, and tool descriptions, `<tools>/<name>.md`: an optional
//   header (any fields; `description` and `format` are read) and a body that is a template.
// - Config, the file each level names (`Layer.config`): `off:`, `layered:`, `added:`, `instructions:` and `pins:` are read (CONFIG_KEYS).
//
// Levels. Files are read through the host's `FilesPort`: shipped, then global, then character, then
// chat. A file of the same name at a nearer level replaces the farther one, of every kind, but for an
// instruction file named in any level's `layered:`, which is read at every level that has one,
// farther first, each its own entry of the stack. A name listed in any level's `off:` is off at
// every level. A file that does not parse is reported by path and line, is not used, and the farther
// file of its name is not used in its place.
//
// Rules (§5.4). `description:`; `agents:`, `all` or a list of definitions (it must be there: code
// holds no default about whom a rule is for); `needs:`, names the rule is in force only while each
// is (a rule's, an instruction file's, or `<kind>/<name>`, written as `off:` entries are); `turns:`,
// on an always-on rule, the situations it is for, which hand it over for those turns' briefings
// instead of the opening block. At most one trigger: `condition:`, a JavaScript regular expression,
// with `scope:` (`text`, `thinking`, `reply`, `arguments` or `result`, the last two as
// `arguments:<tool>` or `result:<tool>` with a glob, `*` for any), `interrupt: never` (left out, a
// match on what is being written stops the call) and `hold: true` (on a tool's arguments, the text
// comes back instead of running the tool); `question:`, with `scope:` (`text`, `thinking` or
// `reply`), `interrupt: always` (the agent waits for the answer before its next call; left out, it
// goes on) and `judge:` (the connection of the judging model, over the `rules.judge` setting and the
// agent's own); `at:` (`turn-start`, `run-end`, `before-compaction`), with or without `fact:`; `every:`,
// a number of turns, with or without `fact:`. `repeat:` is `once per turn` when left out, or
// `once per session`, `after N turns`, `always`. A pattern on a tool's result looks at its text,
// then its reports, then a line `marked <mark>` for each of its marks.
//
// Templates. `{{name.path}}` puts a field in; `{{#name}}…{{/name}}` shows its block when the field
// is present and not empty (once per item for a list, with `{{.}}` as the item; once for anything
// else, with `{{.}}` as the value); `{{^name}}…{{/name}}` shows its block when the field is absent
// or empty. Nothing else. Empty: absent, null, false, 0, "", an empty list, an object with no fields.
// A line that holds nothing but a block's opening or closing tag leaves no line behind. A list put in
// with `{{name}}` is its items joined by ", ". An object may hold its own value under the key ".":
// that value is what `{{name}}` puts in and what a block tests, while its other keys are its
// fields (a fact is such an object: `{{stage.unperceived}}` is its count and
// `{{stage.unperceived.names}}` the names it counts). A name is looked for in the innermost block's
// item first, then outwards; a prompt part's own header fields are the outermost.

import type { AgentRef, BodyFields, DefinitionView, Effort, FactDef, FactsPort, FactValue, FilesPort, JsonObject, JsonValue, Layer, LayerLevel, RuleView, Scope, StackLeft, StackPart, SwitchesPort, ToolResult, ToolsAs, UserScope } from "../contract/index";
import type { Fired, RunEndRules, StreamRules } from "../loop/rules";
import type { McpRead } from "./mcp";
import type { Rule } from "./rules";

// ---------------------------------------------------------------- where things come from

/** The file something was loaded from: its path in the agents' view, its level, and its SHA-256 when read. */
export interface Source {
  path: string;
  level: LayerLevel;
  hash: string;
}

/** A farther file of the same name that a nearer one replaces (§5.2). */
export interface Replaced {
  level: LayerLevel;
  path: string;
}

/**
 * Something wrong with a file, in words a user can act on: which file, which line where one can be
 * named, and what to change. A problem never stops a turn: the file, or the field, is left out.
 */
export interface Problem {
  path: string;
  level?: LayerLevel;
  /** The line of the file, counted from 1. */
  line?: number;
  message: string;
}

// ---------------------------------------------------------------- the owner's own tools

/**
 * One of the owner's own tools, as its manifest (`<tools>/<name>.json`, §5.4 "Tools", P15) writes it:
 * a command it runs, or an address it calls. Its description is its `<tools>/<name>.md` like any
 * tool's. Nothing it holds comes from an agent: the command line and the address are the file's.
 */
export interface ToolManifest {
  /** The file's name, which is the tool's. */
  name: string;
  /** The family it is found under. */
  family: string;
  /** What it takes, as an object schema (`takes`); none: no arguments. */
  parameters: JsonObject;
  /** A command line, run as the server's user with the arguments as JSON on stdin; or an address the arguments go to as a JSON body, with headers whose values are the secrets of the names given. */
  runs: { command: string } | { address: string; method: string; headers: Record<string, string> };
  /** Seconds it may take; absent: the user's `tools.commandTimeout` or `tools.httpTimeout`. */
  timeout?: number;
  path: string;
  level: LayerLevel;
}

/** A manifest file in force as read: its tool where it reads whole, what it runs or calls as far as it says, and why it is left out. */
export interface ManifestRead {
  name: string;
  path: string;
  level: LayerLevel;
  manifest?: ToolManifest;
  written?: { kind: "command-tool" | "http-tool"; runs: string };
  problems: string[];
}

// ---------------------------------------------------------------- templates

/** A value a template can put in: JSON, where an object may hold its own value under "." (see the head of this file). */
export type Field = JsonValue;

/** The named fields a template is filled from. An absent or undefined field is absent. */
export type Fields = { readonly [name: string]: Field | undefined };

/** A template filled in: its text, and every field it put in that had no value (by path, in order, once each). */
export interface Rendered {
  text: string;
  missing: string[];
}

/** A template as parsed from a file. */
export interface Template {
  /** The text as written. */
  readonly text: string;
  /** Every field it names, put in or tested, by path as written, in the order they first appear. */
  readonly fields: readonly string[];
  render(fields?: Fields): Rendered;
}

// ---------------------------------------------------------------- agent definitions

/** The header fields of an agent definition. Anything else in its header is reported. Frozen: a host reads a definition by this same list (`rp-harness/helpers`). */
export const DEFINITION_FIELDS = Object.freeze(["name", "description", "model", "effort", "tools_as", "tools", "out_of_reach", "reads", "given", "opening", "limits", "writer"] as const);

/** The fields a definition's body may name, each a field of the contract's `BodyFields`. Anything else it names is reported. */
export const BODY_FIELDS = ["agent", "definition", "plays"] as const satisfies readonly (keyof BodyFields)[];

/** An agent's own limits from its definition (§10.11). Each absent is no limit of the definition's. */
export interface DefinitionLimits {
  calls?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Wall time, in milliseconds. The header gives it in seconds (`time: 90`). */
  time?: number;
  /** The prompt of one call, as estimated before it is sent. */
  callTokensIn?: number;
  /** The answer of one call. */
  callTokensOut?: number;
  /** One call's wall time, in milliseconds, apart from the model layer's silent wait. The header gives it in seconds. */
  callTime?: number;
  /** Its answers that call tools (today's tool rounds). */
  toolRounds?: number;
  /** The tool calls one answer may make; the calls past it are answered and not run. */
  toolsPerAnswer?: number;
  /** An answer's tool calls that run at once, in place of the setting `limits.toolsAtOnce`. */
  toolsAtOnce?: number;
  /** For a sub-agent: the messages it may be sent after its first answer (§13.4); one past it is answered and it is not run. */
  messages?: number;
}

/** An agent definition (§5.4): the nearest file of its name. */
export interface AgentDefinition {
  /** Its file's name, without `.md`: what `AgentRef.definition` names. */
  name: string;
  description: string;
  /** The connection profile it runs on, as the header names it (`default`). */
  model?: string;
  effort?: Effort;
  /** How its tools are offered to its model (`tools_as:`); absent: auto. */
  toolsAs?: ToolsAs;
  /** The tools it holds, by name, as written. */
  tools: string[];
  /** Families of tools it does not reach by searching (`out_of_reach:`, §6.8); a tool of one that `tools` names it still holds. */
  outOfReach: string[];
  /** The instruction files of its stack; `rules` stands for the always-on rules it is named in. They choose the stack's parts and §5.2 orders them; a file that is none of §5.2's numbered parts goes with the `instructions:` files, in the order written here. */
  reads: string[];
  /** What it is handed at the start of a run, by name, as written (`chat:history[scene]`). */
  given: string[];
  /**
   * What it is given once, when its session opens, in its opening block (`opening:`, §8.2, R-163):
   * each found as a `given:` name is, asked of the host again only when the block is made afresh.
   */
  opening: string[];
  limits: DefinitionLimits;
  /** The definition `write_reply` hands the prose to when this agent calls it (§10.6), by name as its header writes it. Absent when its header names none: code names no writer of its own. */
  writer?: string;
  /** Its body: the agent's instructions, a template a sub-agent's run fills with `BODY_FIELDS` (`You are {{plays}}.`). */
  instructions: Template;
  source: Source;
  replaces: Replaced[];
}

// ---------------------------------------------------------------- skills

/** The header fields of a skill. Anything else in its header is reported. */
export const SKILL_FIELDS = ["name", "description"] as const;

/** A skill as the prompt's index shows it (§5.4): its folder's name and what it is for. */
export interface SkillEntry {
  name: string;
  description: string;
  source: Source;
  replaces: Replaced[];
}

/** A skill with its body, for an agent that asked for it. */
export interface Skill extends SkillEntry {
  body: string;
}

// ---------------------------------------------------------------- prompt parts and tool descriptions

/** Where a part lives: `.prompts/` for prompt parts, `.tools/` for tool descriptions (each level's own folder of that kind). */
export type PartKind = "prompts" | "tools";

interface PartBase {
  /** Its file's name, without `.md`. */
  name: string;
  kind: PartKind;
  /** What it is, from its header, for the pages. */
  description?: string;
  /** Every field of its header, as written: `tags` of the reply contract, for one. */
  header: JsonObject;
  source: Source;
  replaces: Replaced[];
}

/** A part whose body is one template. */
export interface TemplatePart extends PartBase {
  format: "template";
  template: Template;
  /** The body filled in; the part's header fields are the outermost fields, and `fields` stand over them. */
  render(fields?: Fields): Rendered;
}

/** A part whose header says `format: lines`: one `name: text` template per line (`notices`, `progress`). */
export interface LinesPart extends PartBase {
  format: "lines";
  /** The lines' names, in the file's order. */
  names: string[];
  lines: ReadonlyMap<string, Template>;
  /** One line filled in; undefined when the file holds no line of that name, which means it is not shown. */
  line(name: string, fields?: Fields): string | undefined;
}

export type PromptPart = TemplatePart | LinesPart;

// ---------------------------------------------------------------- the instruction stack

/**
 * One part of an agent's stack (§5.2). `part` names it the way `off:` lists name it: the definition
 * as `agents/<name>`, an instruction file by its name (`TURN`), a rule as `rules/<name>`. A part left
 * out has `left`, and its `path` and `level` say which file is not given, or for `missing` where it
 * would be. Its `text` is its whole text as written (the definition's body unfilled).
 */
export interface StackEntry extends StackPart {
  kind: "definition" | "instruction" | "rule";
  replaces: Replaced[];
  /** For an instruction file named in `layered:`: this is one level's file of several; its part is told apart from the others' by its level. */
  layered?: true;
}

/**
 * An agent's stack, in §5.2's order whatever order its `reads` names the parts in: 1 `ALL-AGENTS`;
 * 2 the always-on rules it is named in (`rules`: the shipped level's first, then global, character,
 * chat, by name within a level); 3 `AGENTS`; 4 `WORLD`, `SIMULATION`, `WRITING`; then the files the
 * levels' `instructions:` add to it, and each instruction file its `reads` names that §5.2 does not
 * number, in its order; 5 its definition; 6 `TURN`, `PRESET`. Of the numbered parts only those its
 * `reads` names are there; a `layered:` instruction file is one entry per level that has it, farther
 * first; a file is given once however often it is named, and the definition only as part 5. Then
 * what the briefing is handed, when its definition is given `briefing`: the files the config's
 * `added:` table names for the situations at hand, and the always-on rules whose `turns:` name one
 * of them. Every entry its definition or a config names is here, given or left out. `problems`: those
 * of its entries' files, of the `instructions:` entries that reach it, and of the pins for its agent.
 */
export interface Stack {
  agent: string;
  entries: StackEntry[];
  problems: Problem[];
}

/**
 * What an opening block held when it was made, kept with the session (JSON): each part that stood,
 * by its name, its file, and the SHA-256 of its text as the agent got it (a definition filled in, the
 * reply contract rendered for the session's form, a tool's description as declared).
 */
export interface StackSnapshot {
  agent: string;
  parts: { part: string; path: string; level: LayerLevel; hash: string; layered?: true }[];
}

/**
 * A part of an opening block as it is compared across a session (§5.2, §10.2): every part but the
 * skills' index (`Opening.skills`) and what `opening:` names (resolved once). `layered`: one level's
 * file of a layered name. A part that stands has its `text`; one left out, why.
 */
export interface FrontPart {
  part: string;
  path: string;
  level: LayerLevel;
  layered?: true;
  text?: string;
  left?: StackLeft;
}

/**
 * A part of the opening block that no longer stands (§5.2, §10.2): its file was edited or replaced
 * (`changed`), a file now given that was not (`added`), or one no longer given (`off`, with why).
 * `text` is the whole current text, for `changed` and `added`.
 */
export interface FileChange {
  part: string;
  change: "changed" | "added" | "off";
  /** The file now in force; for `off`, the file the opening block held. */
  path: string;
  level: LayerLevel;
  text?: string;
  why?: StackLeft;
}

// ---------------------------------------------------------------- rules

/** The header fields of a rule. Anything else in its header is reported. */
export const RULE_FIELDS = ["description", "agents", "needs", "turns", "condition", "case", "scope", "question", "judge", "at", "fact", "command", "every", "repeat", "interrupt", "hold"] as const;

// ---------------------------------------------------------------- facts

/** RPH's own facts. */
export type OwnFactName = "todo.open" | "reply.released" | "reply.owed" | "prompt.notices" | "session.turns" | "limits.left";

/** RPH's own facts' values at a moment, given by whoever keeps them (the todo list, the reply, the prompt's notices). Absent: unknown, and a rule that tests it does not fire. */
export type OwnFactValues = Partial<Record<OwnFactName, FactValue>>;

/** Reads RPH's own facts for an agent at a moment. */
export type OwnFactsReader = (scope: Scope, agent: AgentRef) => OwnFactValues | Promise<OwnFactValues>;

/** Every fact a rule can test: RPH's own and the host's (through `FactsPort`). */
export interface Facts {
  /** RPH's own first, then the host's. A host's fact of an own fact's name is left out. */
  defs(): FactDef[];
  /** The values of the facts named that have one now. */
  read(scope: Scope, agent: AgentRef, names: readonly string[]): Promise<Record<string, FactValue>>;
}

// ---------------------------------------------------------------- the rule engine

/**
 * What the rules remember across a chat's turns (JSON): the caller keeps it with each turn, through
 * the host's store, and hands the memory of the turn a run follows back to that run, across a
 * scene's end and a restart. A chat's first turn starts with none.
 */
export interface RuleMemory {
  /** The chat's turns begun under it (`RuleRun.turnStart`): what `every:` and `repeat: after N turns` count. */
  turns: number;
  /** The turn count at which a rule last fired, by `<rule> <agent definition>`. */
  fired: Record<string, number>;
  /** Texts held for the next briefing: a question rule answered yes about a reply already shown. */
  held: { agent: string; firing: Fired["firing"]; text: string }[];
  /**
   * The session it was last run in, with the rules that fired in that session, by `<rule> <agent
   * definition>`: what `repeat: once per session` asks, so a run in another session begins the list
   * anew. Absent in a memory that has not run yet.
   */
  session?: { id: string; fired: string[] };
}

export interface RuleRunOptions {
  facts: Facts;
  /** What the rules remembered at the end of the turn the run follows; none for a chat's first turn. */
  memory?: RuleMemory;
  /**
   * How many characters a pattern looks at at a time: the newest of what is being written, and
   * stretches of a tool's arguments or result. Absent: the whole text.
   */
  window?: number;
  /** Milliseconds one pattern may run on one text (`rules.patternTime`). */
  patternTime: number;
  /** Told of a rule whose pattern ran out of time on a text, with the text's length; the run's trace and log say so. */
  ranOut?(agent: AgentRef, rule: { rule: string; path: string }, length: number): void;
  /** Whether a stream rule that interrupts may stop `agent`'s call, as its connection's setting says; asked at each model call's start. Absent: it may. */
  stops?(agent: AgentRef): Promise<boolean>;
  /** Asks a rule's command about the moment (`command:`, C5), with the moment's facts and the agent's place as JSON. Absent: every rule command is off. */
  command?(agent: AgentRef, rule: { rule: string; command: string }, input: JsonValue): Promise<RuleCommandAnswer>;
  /** Told of a rule whose command failed or ran out of time: it did not fire, and it is shown as unable to work, never as a "no". */
  commandFailed?(agent: AgentRef, rule: { rule: string; path: string }, why: string): void;
}

/** What a rule's command answered: yes or no; that it waits for its switch or is off (nothing ran); or why it could not answer. */
export type RuleCommandAnswer = "yes" | "no" | "waiting" | "off" | { failed: string };

/** A tool call as the rules see it before the tool runs. */
export interface ToolCallSeen {
  id: string;
  tool: string;
  args: JsonValue;
}

/** What rules on a tool's arguments did: one that holds the tool (its text comes back instead of running it), and those whose text comes back with the result. */
export interface ToolCallFired {
  hold?: Fired;
  remind: Fired[];
}

/** A message as written, for the `question:` rules: its text, its thinking, and the reply it wrote, if any. */
export interface MessageSeen {
  text: string;
  thinking?: string;
  reply?: string;
}

/** A `question:` rule to put to the judging model about what an agent just wrote. */
export interface Question {
  id: string;
  rule: string;
  agent: AgentRef;
  question: string;
  watched: "text" | "thinking" | "reply";
  /** What it is asked about. */
  text: string;
  /** Whether the agent waits for the answer before its next call (`interrupt: always`). */
  interrupt: boolean;
  /** The connection the rule's own header names for the judging model. */
  judge?: string;
}

/**
 * A question answered yes: the rule fired. `now`: add its text and give the agent another call.
 * `briefing`: the reply was already shown, so its text is held for the next briefing (`turnStart`).
 */
export interface Answered {
  fired: Fired;
  deliver: "now" | "briefing";
}

/** A rule due in the briefing. `carried`: it fired in an earlier turn (held for this briefing); its firing was told then. */
export interface BriefingFired extends Fired {
  carried?: true;
}

/**
 * The user's triggered rules for one run (a turn, a job, a talk): the rules in force as the files
 * stand at each moment one would fire (a turn's start, a tool call or result, a judged message, a
 * run's end, before compaction; on the stream, as read at the start of the model call), which fire
 * on the events the runner hands them, with their texts filled from the facts' fields.
 * Each method answers which rules fire and keeps to their `repeat:`; what happens next (stopping a
 * stream, another call, a held tool) is the runner's. On the stream a rule fires at most once in one model call.
 *
 * A rule's text is filled from the facts its text names (each placed by its dotted name; the fact
 * it tests counts only the groups it picks) and, for a pattern, `matched` (what it matched) and
 * `tool` (the tool's name, on a tool's arguments or result). On the stream nothing is read: a
 * pattern's text there is filled from `matched` alone.
 */
export interface RuleRun {
  /** Rules whose `fact:` or text names a fact, a group or a field nobody gives (each found when it is first read), and rules whose facts could not be read (as it goes; the run goes on without them). */
  readonly problems: Problem[];
  /** A turn begins: counts it, and gives what is due in the lead's briefing: rules `at: turn-start` whose fact holds, rules whose `every:` comes round, and texts held from the last turn. */
  turnStart(agent: AgentRef): Promise<BriefingFired[]>;
  /** The rules on what `agent` is writing (`text`, `thinking`, `reply`), for its runner. */
  stream(agent: AgentRef): StreamRules;
  /** Rules `at: run-end` whose fact holds, for any agent. */
  readonly runEnd: RunEndRules;
  /** Before a tool runs: rules on its arguments. */
  toolCall(agent: AgentRef, call: ToolCallSeen): Promise<ToolCallFired>;
  /** After a tool ran: rules on its result; their texts are added to it. */
  toolResult(agent: AgentRef, call: { id: string; tool: string }, result: ToolResult): Promise<Fired[]>;
  /** Before a session's earlier turns are summarized: rules `at: before-compaction`. The agent gets one call with their texts first. */
  beforeCompaction(agent: AgentRef): Promise<Fired[]>;
  /** After a message: the `question:` rules to put to the judging model. */
  questions(agent: AgentRef, message: MessageSeen): Question[];
  /** The judging model's answer to a question; undefined when the rule does not fire. */
  answered(question: Question, yes: boolean): Promise<Answered | undefined>;
  /** Holds a rule's text for `agent`'s next briefing (`turnStart`): a question answered yes once the agent's work had ended. */
  hold(agent: AgentRef, fired: Fired): void;
  /** The memory as it stands now, for the caller to keep with the session. */
  memory(): RuleMemory;
}

// ---------------------------------------------------------------- config

/** The keys of a level's config file read here. Everything else in it is other code's. */
export const CONFIG_KEYS = {
  /** Names switched off: `rules/perceptions-owed`, `TURN` (with or without `.md`, with a level's own folder name or a mount in front, as the Files page writes them). */
  off: "off",
  /** Instruction files read at every level that has one, farther first, instead of the nearest alone: `layered: [AGENTS]`. None when no level's config names any. */
  layered: "layered",
  /** Which situation adds which instruction files to the briefing: `swipe: [SWIPE]`. A nearer level's entry for a situation replaces a farther one's. */
  added: "added",
  /**
   * Files added to stacks (§5.2, as OpenCode's config adds them): a list, added to the stack of every
   * agent whose definition reads at least one instruction file; or a mapping from an agent's name to
   * a list, for that agent alone. Each entry is an instruction file's name as `reads` writes it
   * (`STYLE`, `STYLE.md`), found as `reads` finds one, or a path or glob in the agents' view to the
   * owner's own files (`house/canon.md`, `@global/house/*.md`), read in path order. An entry that
   * finds only agents' notes or generated files adds nothing. They come after part 4 and before the
   * definition, the farther level's lists first, each in its order.
   */
  instructions: "instructions",
  /**
   * Files pinned for agents (R-174): a list of `{ file, agent }`, the file by its path in the chat's
   * view (`persistent-workspace/plan.md`, `@global/persistent-workspace/x.md`), the agent by its
   * definition's name. Every level's list applies. At the start of each of its runs the agent is
   * handed each file pinned for it whole, as a `given` file after its definition's own. A pinned file
   * is data handed to an agent, not an instruction; one that is not there is a problem, not a stop.
   */
  pins: "pins",
} as const;

// ---------------------------------------------------------------- the whole

/** The guidance of one scope, read through the host's `FilesPort` as it stands now. Each answer is read once and kept: ask a new one to see later changes. */
export interface Guidance {
  /** A scope that names only the user has no chat in view: its levels are the shipped and global ones, and it has no rules to run. */
  readonly scope: Scope | UserScope;
  layers(): Promise<Layer[]>;
  /** Every problem found in every file of the tree, and in what its configs name. Loads everything. */
  problems(): Promise<Problem[]>;

  /** The definition in force of that name; undefined when there is none, it is off, or it is broken (see `problems`). */
  definition(name: string): Promise<AgentDefinition | undefined>;
  /**
   * The files pinned for an agent (`pins:`, both levels', the farther's first), as a run's start
   * hands them: each with what keeps it from being handed now, if anything does (not there, refused,
   * unreadable), found where the run looks for it, the turn's folder included.
   */
  pins(agent: string): Promise<{ file: string; problem?: Problem }[]>;
  /** Every definition in force, for the Files page. */
  definitions(): Promise<DefinitionView[]>;

  /**
   * An agent's stack. With `situations` (the turn's kind and what happened since the last one:
   * `swipe`, `delete`), the briefing entries are those added for them; without, every entry the
   * `added:` table could add, each with its situations, for the Files page.
   */
  stack(agent: string, options?: { situations?: readonly string[] }): Promise<Stack>;

  /** The skills' index: every skill in force, by name. */
  skills(): Promise<SkillEntry[]>;
  skill(name: string): Promise<Skill | undefined>;

  /** A prompt part in force, from the prompts folders. */
  part(name: string): Promise<PromptPart | undefined>;
  /** A tool's description in force, from the tools folders (`<tools>/<tool's name>.md`). */
  tool(name: string): Promise<PromptPart | undefined>;
  /** The owner's own tools' manifests in force (`<tools>/<name>.json`, the nearest of each name, those `off:` names left out), by name. */
  manifests(): Promise<ToolManifest[]>;
  /** Each manifest file in force, broken ones too: what the list of what runs a command or calls out shows (C3). */
  manifestFiles(): Promise<ManifestRead[]>;
  /** His MCP servers (`<tools>/mcp.json`, every level's, a nearer server replacing a farther one of its name), broken ones too. */
  mcpServers(): Promise<McpRead[]>;
  /** A prompt part's, a tool description's or a skill's file as the levels give it (`Harness.parts.read`, C17): its text, where it is, whether it is switched off, and whether it reads whole. */
  layered(kind: PartKind | "skills", name: string): Promise<{ text: string; path: string; level: LayerLevel; off: boolean; broken: boolean } | undefined>;

  /** Every rule file, examples and broken ones included, as the Rules page lists them; a rule's command with where it stands as `switches` say (none: off). */
  rules(switches?: SwitchesPort): Promise<RuleView[]>;
  /** A rule as its file reads now, in force or not, an example's too (`rules.test`); undefined when no rule of the name reads whole. */
  rule(name: string): Promise<Rule | undefined>;
  /** The triggered rules in force now, for one run. */
  ruleRun(options: RuleRunOptions): Promise<RuleRun>;
}

// ---------------------------------------------------------------- the ways in (each exported from `./index` by this name)

/** What a guidance read is given besides its files: told each time one of its parts is rendered, with the values it was rendered with (of a part of lines, the line's name too), for `Harness.parts.lastFields` (C17). */
export interface GuidanceOptions {
  rendered?(kind: PartKind, name: string, fields: Fields, line?: string): void;
}

/** `loadGuidance`: the guidance of a scope. Nothing is read until it is asked for. */
export type LoadGuidance = (files: FilesPort, scope: Scope | UserScope, options?: GuidanceOptions) => Guidance;

/** `createFacts`: RPH's own facts, read by `own` at each moment, and the host's through its port. */
export type CreateFacts = (host: FactsPort, own: OwnFactsReader) => Facts;

/** `snapshot`: what an opening block holds, from its parts, to keep with the session. */
export type TakeSnapshot = (agent: string, front: readonly FrontPart[]) => StackSnapshot;

/** `changes`: what of the opening block no longer stands, given the same agent's block made now; in the block's order, then what went. */
export type FindChanges = (opened: StackSnapshot, now: readonly FrontPart[]) => FileChange[];

/**
 * `changesText`: the briefing's text for the files changed since the session opened, from the
 * `notices` part's `file_changed` and `file_off` lines (fields `path` and `part`), each changed
 * file's line followed by its whole text. A line the user deleted is not shown; a changed file's
 * text is given all the same.
 */
export type ChangesText = (changes: readonly FileChange[], notices: PromptPart | undefined) => string;

/** `parseTemplate`: a template from text, or the problems that keep it from being one. `firstLine` is the file's line the text starts on. */
export type ParseTemplate = (text: string, at: { path: string; level?: LayerLevel; firstLine: number }) => { template?: Template; problems: Problem[] };
