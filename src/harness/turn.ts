// One turn, answered (§10, Appendix A `Harness.answer`): the lead's context in its four blocks, its
// tools, the reply in whichever form the connection takes, the rules, the limits, the trace, and
// what the host is told. Everything here is means. No step of a turn is required and no order is
// fixed: the lead does what its files ask, and a text reaches a model only from a file or the
// request.
//
// The lead's context (§10.2):
//   1. the opening block, fixed when the session opened: its definition and instruction stack, the
//      reply contract, the tool guide (the system prompt, with its tools declared);
//   2. the assembled prompt exactly as the request carries it, introduced by the frame part;
//   3. what the session carries, as text, by the request's `carry`: what the lead did in the
//      session's earlier turns on the path, its records of them, or only what the session opened
//      with; laid out by the carried part, and never an earlier turn's thinking;
//   4. the briefing, laid out by its template from the host's parts and RPH's own.
// Blocks 2 to 4 are placed when the lead's definition is given them (`prompt:*`, `session:carry`,
// `briefing`). Anything else it is given by name is found as a sub-agent's is, and placed after the
// briefing, laid out by the given part.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { attach, fieldsOf, Team, type TeamWork } from "../agents";
import type { Wanted } from "../agents/attachments";
import type { AgentRef, Environment, JsonObject, JsonValue, KeptMessage, LimitHit, LoreEntry, ModelsApi, Places, Release, ReleaseForm, ReplyError, ReplySink, RuleFiring, RuleThen, RunOutcome, ToolCtx, TurnOutcome, TurnRequest, Usage, Writer } from "../contract";
import { CACHE, type CacheDeps, GUIDES_KEY, hostCached, keepCached, loreKey, PROMPT_MAP_KEY, readCached, standing } from "../sessions/cache";
import { createFacts, loadGuidance, partFields } from "../files";
import type { AgentDefinition, Facts, Fields, Guidance, LinesPart, OwnFactValues, PromptPart, RuleRun, TemplatePart } from "../files/api";
import { factFields, factsNamed } from "../files/facts";
import { type AgentOutcome, type AgentRecord, AgentRunner, Budget, type Judged, type KeepRequest, leftFact, type LoopTool, type LoopToolResult, type ParentCall, type RunnerOptions, type RunnerTexts, RunTrace, type TextChannel, type Work } from "../loop";
import { promptTokens, tokensOf } from "../model/tokens";
import type { AgentModel, ModelSource } from "../model/source";
import { heldSentences, KeepAlive, MessageReply, outsideTags, ReplyDesk, TagReply, ThinkingFeed } from "../reply";
import { SILENCE_MOST_MS } from "../reply/progress";
import type { ReleaseCheck } from "../reply/release";
import { SilentReply } from "../reply/silent";
import { type HeldFile, MIB, type SessionBook, type SessionFile, type Unreadable } from "../sessions/book";
import { type CarriedInput, carriedFields, compactionAt, compactionMaterial, materialFields, pathTurns, recordsTokens } from "../sessions/carry";
import { Compactor, type EarlierTurns, saveBeforeCompaction } from "../sessions/compact";
import { entryOf } from "../sessions/runs";
import { answer, type OwnTool, Registry, TodoLists, type ToolText, type Words } from "../tools";
import { changedText, DELEGATION_PART, GIVEN_PART, leadOpening, openingOf, pinsOf } from "./opening";
import { ownTexts, ownTools } from "./own";
import type { AgentReach } from "../tools/search";
import type { GuidesGiven } from "../tools/search/tools";
import type { JobsWork } from "../jobs/tool";
import type { External } from "../external";
import { noticeLines, noticeWords, type PromptView, promptSlice, promptTurn, promptViews, type SceneMap, type TurnPrompt, type ViewWrites, writeViews } from "../prompt";
import { AgentRuns } from "./agent-run";
import { Judges } from "./judge";
import { agentJson, hookSettings, Hooks, scopeJson } from "../external/hooks";
import type { LiveHub } from "./live";
import { type Connection, connectionOf, lines, runnerTexts, template } from "./means";
import { assistantMessage, promptMessages, promptText, type RoleMark, roleMark, systemMessage, userMessage } from "./prompt";
import { type PointedFile, placed, sentMessages } from "./requests";
import { keepMemory, keptOpening, memoryAt, type Opening, type Sessions, unsaid } from "./sessions";
import { agentLimits, callTerms, DEFAULT_SETTINGS, interruptFor, readSettings, type Settings } from "./settings";
import type { UsageBook } from "./usage";

/** Where the released reply is kept, inside the turn's `output/` folder (§5.3). */
export const RELEASED_FILE = "output/reply.md";
/** What the lead was told at its run's start, in the turn's folder (§5.3). */
const BRIEFING_FILE = "briefing.md";

/** The name a writer's definition gives the brief `write_reply` hands it (`given: [prompt:*, brief]`): its own block, placed as itself. */
const WRITER_BRIEF = "brief";

/** What every turn of a harness shares. */
export interface TurnCore {
  env: Environment;
  ids(): string;
  /** The models agents run on: the model layer's, or scripted ones. */
  models: ModelSource;
  /** The connections, to find the one a definition names. */
  connections: ModelsApi;
  hub: LiveHub;
  usage: UsageBook;
  sessions: Sessions;
  /** Each session's file (§11), which the turn's own entries are written to. */
  book: SessionBook;
  /** The harness's jobs, which `job_start` starts (§13.5). */
  jobs: JobsWork;
  /** His own tools and rule commands (C3). */
  external: External;
}

function errorWords(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Texts placed one after another in a message: each without the line break its file ends on, the empty ones left out. */
function joined(texts: readonly string[]): string {
  return texts
    .map((text) => text.trimEnd())
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/** A path of the agents' tree by its parts, as a host finds it: empty parts and `.` left out, `..` taking the part before. */
function plainPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** What the sink is told when the run ends without a reply released; where it ended with no reply, at a limit or stopped, the lead's last plain text outside any mark, where it wrote any. */
function replyError(outcome: RunOutcome, lastText: string | undefined): ReplyError {
  if (outcome.status === "failed") return outcome.error ?? { code: "failed" };
  const text = lastText !== undefined ? { text: lastText } : {};
  if (outcome.status === "limit") return { code: "limit", ...(outcome.limit !== undefined ? { limit: outcome.limit } : {}), ...text };
  if (outcome.status === "stopped") return { code: "stopped", ...text };
  return { code: "no-reply", ...text };
}

export class Turn {
  readonly run: string;
  readonly scope: TurnRequest["scope"];
  readonly #c: TurnCore;
  readonly #req: TurnRequest;
  readonly #sink: ReplySink;
  readonly #trace: RunTrace;
  readonly #lead: AgentRef;
  readonly #desk = new ReplyDesk();
  /** The families whose guide a tool search gave each agent of the turn but the lead (the lead's are the session's, in its cache). */
  readonly #guides = new Map<string, Set<string>>();
  readonly #todos = new TodoLists();
  /** Every agent's work in flight, with its runner, so a stop or the turn's time reaches each. */
  readonly #working = new Set<{ runner: AgentRunner; work: Work }>();
  /** What the host is being told, and what is being written for the turn, until it settles. */
  readonly #pending = new Set<Promise<unknown>>();
  /** The call each writer's work hangs under. */
  readonly #parents = new Map<string, ParentCall>();
  /** Each agent's call under way, by its handle. */
  readonly #calls = new Map<string, number>();
  /** Rules that fired, waiting to be told with what the agent did next. */
  #firings: { firing: RuleFiring; call: number }[] = [];
  #budget = new Budget("turn", {});
  /** What the turn's earlier runs spent (N-22): this run counts on from it, its time too. */
  #earlier: { usage: Usage; ms: number } | undefined;
  #settings: Settings = DEFAULT_SETTINGS;
  #keep: KeepAlive | undefined;
  /** The agents' thinking on its way to the chat's thinking block, where the sink takes it (`progress.thinking`). */
  #thinking: ThinkingFeed | undefined;
  #progress: LinesPart | undefined;
  #words: Words = () => undefined;
  #texts: RunnerTexts = { continueAfterRule: () => "" };
  #guidance: Guidance | undefined;
  /** The note a prompt message whose role no model's API places goes as (`.prompts/role-note.md`), read as the turn starts. */
  #roleMark: RoleMark | undefined;
  #rules: RuleRun | undefined;
  #registry: Registry | undefined;
  /** The turn's sub-agents, the writer among them once `write_reply` starts it. */
  #team: Team | undefined;
  #places: Places | undefined;
  /** How each agent of the turn is made: its gate, its kept requests, its transcript. */
  #runs: AgentRuns | undefined;
  #opening: Opening | undefined;
  /** The turn's prompt, its parts named (§4.8): what `prompt`, a `prompt:` name and the views read. */
  #prompt: TurnPrompt | undefined;
  /** The views of the prompt being written in the turn's folder, alongside the lead's run (§10.1). */
  #views: ViewWrites | undefined;
  /** The views' texts as they are written: what a kept request points into. */
  #viewTexts: Promise<PromptView[]> | undefined;
  /** This run's briefing file in the turn's folder and its text, as the Author was told it. */
  #briefed: PointedFile | undefined;
  /** What the turn's agents reach: the host's, with a files port whose read of a view still being written waits for that write. */
  readonly #env: Environment;
  /** The session's file, once the turn has its entry in it. */
  #file: SessionFile | undefined;
  /** The session's file, held for the turn: let go once the turn's lines are written. */
  #holding: Promise<HeldFile> | undefined;
  /** The session's turns on this turn's path, this one with them: the fact `session.turns`. */
  #sessionTurns = 0;
  /** Why the session's file could not be read at this turn's start, where it could not (§17.2): the briefing says so. */
  #unreadable: Unreadable | undefined;
  /** Why the session's file could not be written when the lines held passed `sessions.maxUnwrittenMiB` and the turn was stopped, where they did. */
  #full: string | undefined;
  #draft: { text: string; by: AgentRef } | undefined;
  #released: { text: string; form: ReleaseForm } | undefined;
  /** The judging model of the `question:` rules, once the turn's rules are loaded. */
  #judges: Judges | undefined;
  /** The facts the turn's rules test, which the briefing names too. */
  #facts: Facts | undefined;
  /** His hooks for the turn's run (§5.4 "Hooks"), once its settings are read. */
  #hooks: Hooks | undefined;
  /** What his turn-start hooks added, for the briefing. */
  #hooked = "";
  /** The lead's runner, once made: what his after-release hooks add goes in with its next call. */
  #leadRunner: AgentRunner | undefined;
  #intentWritten = false;
  /** The lead's last message that ended whole with any text outside every mark, that text, trimmed: what a run with no reply hands the host. */
  #lastText: string | undefined;
  #notices = 0;
  #stopped = false;
  #timer: unknown;
  /** The turn's own time ran out, at this limit: nothing of the turn starts after it (§10.11). */
  #timeUp: LimitHit | undefined;
  #startedAt = 0;

  constructor(core: TurnCore, req: TurnRequest, sink: ReplySink) {
    this.#c = core;
    this.#req = req;
    this.#sink = sink;
    // Each run of the turn (its first, a continue, a "Settle now") has an id of its own, so its records are told apart by this id; the turn stays in their scope.
    this.run = core.ids();
    this.scope = req.scope;
    this.#trace = new RunTrace(core.hub.tee(core.env.trace, req.scope, () => this.#settings.liveBacklog), req.scope, this.run, core.env.clock, core.hub.hold(this.run));
    this.#trace.watch((record) => this.#watch(record));
    this.#trace.watchThinking((agent, call, thinking) => this.#thinking?.piece(agent, call, thinking));
    this.#lead = { id: core.ids(), definition: req.lead };
    const files = core.env.files;
    this.#env = {
      ...core.env,
      files: {
        layers: (scope) => files.layers(scope),
        places: (scope) => files.places(scope),
        find: (scope, query) => files.find(scope, query),
        write: (scope, path, op, by) => {
          if (by !== "owner") this.#writing(path, by);
          return files.write(scope, path, op, by);
        },
        read: async (scope, path, range) => {
          await this.#views?.written(path);
          return files.read(scope, path, range);
        },
      },
    };
  }

  /**
   * Runs the turn: the lead's run, then the host told the run ended; resolves once every agent of the
   * turn has ended. The reply goes to the sink at release, or the sink is told why there is none.
   */
  async answer(signal: AbortSignal): Promise<TurnOutcome> {
    const { env, hub, usage } = this.#c;
    this.#startedAt = env.clock.now();
    hub.started({ run: this.run, scope: this.scope, what: "turn", agents: [], started: this.#startedAt });
    usage.begin(this.run);
    this.#trace.event(this.#lead, undefined, { kind: "run_started", run: "turn", turn: this.#req.kind, lead: this.#req.lead });
    const onAbort = (): void => this.stop();
    if (signal.aborted) this.stop();
    else signal.addEventListener("abort", onAbort, { once: true });
    let outcome: RunOutcome;
    try {
      outcome = await this.#play();
    } catch (error) {
      env.log.error("A turn failed in the harness.", { turn: this.scope.turn, run: this.run, error: errorWords(error) });
      outcome = this.#outcome({ status: "failed", error: { code: "failed", detail: errorWords(error) } });
    }
    this.#keep?.stop();
    // A run with no reply whose session's lines could not be written says so to the chat: they are tried once more first.
    if (!this.#desk.released) {
      await this.#file?.flush();
      outcome = this.#unkept(outcome);
      this.#sink.error(replyError(outcome, this.#lastText));
    }
    // Every sub-agent ends with the turn's work, once what of it is still going has ended: its session closes.
    await this.#team?.over();
    signal.removeEventListener("abort", onAbort);
    if (this.#timer !== undefined) env.clock.clearTimeout(this.#timer);
    // What the turn's runs have spent, this run's added: a later run of the turn counts on from it (N-22).
    const begun = this.#file?.log.turn(this.scope.turn);
    if (begun !== undefined) this.#file?.add({ type: "spent", parent: begun.id, turn: begun.turn, usage: { ...this.#budget.used }, rounds: this.#budget.rounds, ms: (this.#earlier?.ms ?? 0) + env.clock.now() - this.#startedAt });
    await this.#runs?.close();
    // Its own version of each scratch file the session carries becomes the standing one, as its work.
    await this.#keepScratch().catch((error: unknown) => env.log.error("The session's cache could not keep the turn's scratch files.", { turn: this.scope.turn, run: this.run, error: errorWords(error) }));
    await this.#settled();
    // Its reply, released, stands in the chat: a run whose session's lines are still not written ends failed after it, as a run that broke after its reply does.
    outcome = this.#unkept(outcome);
    this.#trace.event(this.#lead, undefined, { kind: "run_ended", outcome });
    await this.#tell(env.events.ended(this.scope, outcome));
    usage.end(this.run);
    hub.ended(this.run);
    return { ...outcome, reply: this.#released?.text ?? "", ...(this.#released !== undefined ? { form: this.#released.form } : {}) };
  }

  /** Stops every agent of the turn where it stands (the signal, or the turn left the path), and nothing more of it starts. */
  stop(): void {
    this.#stopped = true;
    for (const { work } of this.#working) work.stop();
  }

  /** Whether the turn was stopped, or its own time ran out: nothing more of it starts. */
  #ended(): boolean {
    return this.#stopped || this.#timeUp !== undefined;
  }

  async #play(): Promise<RunOutcome> {
    const { env } = this.#c;
    const req = this.#req;
    const scope = this.scope;
    const guidance = loadGuidance(env.files, scope, { rendered: partFields(env.store, scope, env.log) });
    this.#guidance = guidance;
    const [settings, places, definition, progress, notices, toolNotices, frame, contract, briefing, carried, goOn, broke, roleNote, file] = await Promise.all([
      readSettings(guidance, env, scope),
      env.files.places(scope),
      guidance.definition(req.lead),
      guidance.part("progress"),
      guidance.part("notices"),
      guidance.part("tool-notices"),
      guidance.part("prompt-frame"),
      guidance.part("reply-contract"),
      guidance.part("briefing"),
      guidance.part("carried"),
      guidance.part("continue-after-rule"),
      guidance.part("continue-after-break"),
      guidance.part("role-note"),
      (this.#holding = this.#c.book.hold(scope)).then((held) => held.file),
    ]);
    this.#settings = settings;
    // How many sessions the harness keeps read between their turns, as this turn reads the setting.
    this.#c.book.held = settings.sessions.held;
    // The most the session files may hold unwritten, every session's, as this turn reads the setting.
    this.#c.book.heldMost = settings.sessions.unwrittenMost * MIB;
    this.#roleMark = roleMark(roleNote);
    this.#places = places;
    const hooks = new Hooks({ hooks: () => guidance.hooks(), switches: env.switches, user: scope.user, settings: hookSettings(settings), trace: this.#trace, log: env.log });
    this.#hooks = hooks;
    this.#runs = new AgentRuns({
      env,
      scope,
      trace: this.#trace,
      places,
      guidance,
      sources: () => this.#sources(),
      settings: () => this.#settings,
      rules: () => this.#rulesRun(),
      words: (name, fields) => this.#words(name, fields),
      tools: () => this.#registry?.all() ?? [],
      tell: (written) => void this.#tell(written),
      book: this.#c.book,
      hooks,
    });
    // The turn's first entry in the session file: after the session's latest turn when the request names no parent, after no turn when it names none (null), and a swipe after the entry before the turn it replaces (§11).
    // A continue is the same turn, extended (§10.10): a turn the file holds already is not begun again, and its work goes on from the turn's newest entry.
    this.#file = file;
    // A file that could not be read is told, not hidden (§17.2): the trace and the live view have it, and the briefing says so; the turn goes on from what was read.
    if (file.unreadable !== undefined) {
      this.#unreadable = file.unreadable;
      this.#trace.event(this.#lead, undefined, { kind: "session", session: scope.session, change: "unreadable", turn: scope.turn, reason: "reason" in file.unreadable ? file.unreadable.reason : `lines ${file.unreadable.lines.join(", ")}` });
    }
    const continued = req.kind === "continue" ? file.log.turn(scope.turn) : undefined;
    const begun = continued ?? file.add({ type: "turn", parent: file.log.anchor(req.parent), turn: scope.turn, kind: req.kind, lead: req.lead, ...(typeof req.parent === "string" ? { follows: req.parent } : {}) });
    // Where this run's work starts on the path: before the turn, or after what a continued turn did already. What the session carries and what the rules remembered are read there.
    const from = continued === undefined ? begun.parent : (file.log.tip(scope.turn) ?? continued.id);
    this.#sessionTurns = pathTurns(file.log, file.log.tip(scope.turn) ?? begun.id).length;
    // The scratch files the session carries, as they stand on this turn's path, put in its own scratch (R-111): a swipe starts from its parent's. A continue has its own already.
    if (continued === undefined) await this.#carryIn(file, from, places, settings.sessions.carried);
    this.#progress = lines(progress);
    const answers = lines(toolNotices);
    this.#words = (name, fields) => answers?.line(name, fields);
    const { time: setTime, ...counted } = settings.turn;
    // With no line to keep a silent turn alive, the chat application would end it after ten minutes of
    // silence: the turn's own time is held at the most the silence may be, and he is told by the trace
    // when the turn goes quiet (§10.7, READINGS R-124). Nothing is put in the file's place.
    const quiet = (this.#progress?.line("still", { elapsed: "0:00" }) ?? "").trim() === "";
    const kept = quiet ? Math.min(setTime ?? SILENCE_MOST_MS, SILENCE_MOST_MS) : undefined;
    const time = kept ?? setTime;
    this.#keep = new KeepAlive({
      sink: this.#sink,
      clock: env.clock,
      silenceMs: settings.silenceMs,
      still: (fields) => this.#progress?.line("still", fields),
      ...(kept !== undefined ? { missing: () => this.#trace.event(this.#lead, undefined, { kind: "progress_missing", time: kept }) } : {}),
      lined: () => this.#thinking?.lined(),
    });
    const shows = this.#keep.sink;
    // The agents' thinking goes to the chat as it is written, where the sink takes it, as the setting says whose; none once the reply has begun to go out.
    this.#thinking = shows.thinking === undefined ? undefined : new ThinkingFeed({ sink: { thinking: (piece) => shows.thinking?.(piece) }, shown: settings.thinking, lead: this.#lead.id, open: () => !this.#desk.released });
    this.#keep.start();
    this.#say("started");
    // A turn's counts run across its runs (N-22): a continue, or a run that settles, goes on from what
    // its earlier runs spent, and its time from theirs; a limit spent already ends it at once.
    const earlier = file.log.spent(scope.turn);
    this.#earlier = earlier;
    const day = await this.#c.usage.spend(scope.user);
    const weighed = { cachedWeight: settings.cachedWeight };
    this.#budget = new Budget("turn", counted, new Budget("day", settings.day.tokens !== undefined ? { tokens: settings.day.tokens } : {}, undefined, { spent: day.all, ...weighed }), { ...weighed, ...(earlier !== undefined ? { used: { ...earlier.usage }, rounds: earlier.rounds ?? 0 } : {}) });
    if (time !== undefined) {
      const left = time - (earlier?.ms ?? 0);
      if (left <= 0) this.#outOfTime(time);
      else this.#timer = env.clock.setTimeout(() => this.#outOfTime(time), left);
    }
    if (definition === undefined) return this.#outcome({ status: "failed", error: { code: "no-definition", agent: req.lead } });

    const session = this.#c.sessions.of(scope);
    const facts = createFacts(env.facts, (_scope, agent) => this.#ownFacts(agent));
    this.#facts = facts;
    // The rules go on from what they remembered where this run starts in the session file, or at the turn it follows in the scene before, so a swipe starts where the attempt it replaces did, and a continue where its turn left off.
    const memory = await memoryAt(session, env, scope, file.log, from, req.parent);
    const rules = await guidance.ruleRun({
      facts,
      ...(settings.ruleWindow !== undefined ? { window: settings.ruleWindow } : {}),
      patternTime: settings.patternTime,
      // A pattern that ran out of time on a text counted as no match: the trace and the log say so.
      ranOut: (agent, rule, length) => {
        this.#trace.event(agent, this.#parents.get(agent.id), { kind: "rule_failed", rule: rule.rule, path: rule.path, why: "time", length });
        env.log.warn("A rule's pattern ran out of time on a text; that check counted as no match.", { turn: scope.turn, rule: rule.rule, path: rule.path, length });
      },
      // Whether a rule that interrupts stops the agent's call, by its connection's setting (`remind` reminds instead).
      stops: async (agent) => {
        const own = agent.id === this.#lead.id ? definition : await guidance.definition(agent.definition);
        return interruptFor(settings, own === undefined ? { id: null, name: null } : await this.#connection(own)) === "stop";
      },
      command: this.#c.external.ruleCommands(scope.user, settings),
      commandFailed: (agent, rule, why) => {
        this.#trace.event(agent, this.#parents.get(agent.id), { kind: "rule_failed", rule: rule.rule, path: rule.path, why: "command", detail: why });
        env.log.warn("A rule's command could not answer; the rule did not fire.", { turn: scope.turn, rule: rule.rule, path: rule.path, why });
      },
      // A rule whose command waits to be switched on, or is off: the record says the rule would have asked, and by what name it is switched on.
      commandWaiting: (agent, rule, state) => this.#trace.event(agent, this.#parents.get(agent.id), { kind: "rule_waiting", rule: rule.rule, path: rule.path, thing: { kind: "rule-command", name: rule.rule, target: rule.command }, state }),
      ...(memory !== undefined ? { memory } : {}),
    });
    this.#rules = rules;
    for (const problem of rules.problems) env.log.warn("A rule cannot be used.", { path: problem.path, problem: problem.message });

    const texts = await ownTexts(guidance);
    // A `prompt:` name, given by `delegate` or a definition's `given:`, the lead's or a sub-agent's, read as the prompt tool reads it.
    const slice = promptSlice(async () => this.#prompt, guidance);
    const team = new Team({
      env: this.#env,
      trace: this.#trace,
      guidance,
      ids: () => this.#c.ids(),
      models: this.#c.models,
      connection: (definition) => this.#connection(definition),
      hold: (names) => this.#registry?.hold(names) ?? { tools: [], missing: [...names] },
      unregistered: (name, tools) => this.#unheld("unregistered", name, tools, "Tools a sub-agent's definition lists are registered by nobody; it holds the rest."),
      gate: (agent, parent) => this.#agentRuns().gate(agent, parent),
      texts: () => this.#texts,
      rules: () => this.#rulesRun(),
      questions: () => this.#judges,
      budget: () => this.#budget,
      settings: () => this.#settings.subAgents,
      perCall: () => this.#settings.perCall,
      terms: (definition) => callTerms(this.#settings, definition),
      limits: (definition) => agentLimits(this.#settings, definition),
      track: (entry) => {
        this.#working.add(entry);
        return () => this.#working.delete(entry);
      },
      gauge: (agent, limits) => this.#c.usage.gauge(scope, this.run, agent.id, limits.contextWindow?.tokens ?? 0, limits.maxTokens?.tokens ?? 0),
      progress: (name, fields) => this.#say(name, fields),
      keep: (agent, kind) => this.#keeper(agent, kind).keep,
      session: (agent, kind, by) => this.#agentRuns().session(agent, kind, by),
      compacted: (agent, summary, facts) => this.#agentRuns().compacted(agent, summary, facts),
      compaction: () => this.#settings.compaction,
      atRunEnd: (agent, parent) => hooks.atRunEnd(scope, { agent, ...(parent !== undefined ? { parent } : {}) }),
      hooks,
      slice,
      numbers: session.handles,
      end: (agent) => this.#agentRuns().end(agent),
    });
    this.#team = team;
    const registry = new Registry(this.#ownTools(texts, team, guidance), await env.tools.all(scope), await this.#c.external.tools(guidance, settings, this.#words));
    this.#registry = registry;
    if (registry.shadowed.length > 0) this.#unheld("shadowed", req.lead, registry.shadowed, "Host tools that take the name of one of RPH's own are left out.");

    const connection = await this.#connection(definition);
    const judges = new Judges({
      env,
      trace: this.#trace,
      guidance,
      rules,
      ids: () => this.#c.ids(),
      models: this.#c.models,
      connections: this.#c.connections,
      settings,
      budget: this.#budget,
      // The Author's connection judges where neither the rule nor `rules.judge` names one: this turn's lead's (Appendix D.1).
      author: async () => connection,
      track: (entry) => {
        this.#working.add(entry);
        return () => this.#working.delete(entry);
      },
      late: (agent, judged) => this.#late(agent, judged),
      keep: (agent) => this.#agentRuns().keep(agent),
    });
    this.#judges = judges;
    // The block the session opened with: as memory holds it, or, after a restart or once the session is open again after a close, as its file keeps it. Made afresh, it is kept in the file.
    let opening = session.openings.get(req.lead) ?? keptOpening(file.log, req.lead);
    if (opening === undefined) {
      const opened = await leadOpening({ env: this.#env, scope, lead: this.#lead, guidance, definition, registry, settings, connection, contract: template(contract), slice });
      if (typeof opened === "string") return this.#outcome({ status: "failed", error: { code: opened, agent: req.lead } });
      opening = opened;
      file.add({ type: "opening", parent: begun.id, lead: req.lead, opening: opening as unknown as JsonObject });
    }
    session.openings.set(req.lead, opening);
    this.#opening = opening;
    this.#texts = runnerTexts(this.#words, template(goOn), template(broke), settings.schemaShown);

    let model: AgentModel;
    try {
      model = await this.#c.models.agentModel(connection.choice);
    } catch (error) {
      return this.#outcome({ status: "failed", error: { code: "failed", detail: errorWords(error) } });
    }
    this.#c.usage.gauge(scope, this.run, this.#lead.id, model.limits.contextWindow?.tokens ?? 0, model.limits.maxTokens?.tokens ?? 0);
    // The tools as the session declared them when it opened, each as it was declared then: a tool's file changed since waits for the next session, and one the host has withdrawn since stays declared and answers that it is gone (§6.8).
    this.#unheld("unregistered", req.lead, opening.tools.filter((name) => !Object.hasOwn(opening.declared, name)), "Tools the lead's definition lists are registered by nobody; it holds the rest.");
    const held = registry.opened(opening.tools, opening.declared, async (tool) => answer(this.#words("withdrawn", { tool }), true));
    this.#unheld("withdrawn", req.lead, held.withdrawn, "Tools the lead's session declared as it opened are no longer offered by the host; each answers that it is gone.");
    const declared = held.tools;
    const listSize = { tokens: tokensOf(JSON.stringify(declared.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))), settings.tokens.charsPerToken), most: settings.fixedTokens };

    const due = await rules.turnStart(this.#lead);
    for (const fired of due) if (fired.carried !== true) this.#trace.event(this.#lead, undefined, { kind: "rule_fired", firing: { ...fired.firing, agent: this.#lead, action: "briefing" } });
    // His turn-start hooks, before the lead's first call (§5.4): what they add goes into the briefing; a block ends the turn with the hook's reason.
    const started = await hooks.run("turn-start", { scope: scopeJson(scope), turn: { kind: req.kind, lead: req.lead }, agent: agentJson(this.#lead) }, { agent: this.#lead });
    if (started.blocked !== undefined) return this.#outcome({ status: "failed", error: { code: "hook", hook: started.blocked.hook, detail: started.blocked.reason } });
    this.#hooked = joined(started.added);
    // A request that carries no prompt (a run asked for to settle a turn's records, say) leaves the prompt's record as it was: nothing of it is compared, kept or saved, no view of it is written over the turn's, and its prompt tools find none.
    if (req.prompt.length > 0) {
      const { prompt, located } = await promptTurn({ env, scope, messages: req.prompt, parent: req.parent, by: this.#lead, sceneMap: this.#sceneMap() });
      this.#prompt = prompt;
      this.#notices = located.notices.length;
      if (located.notices.length > 0) this.#trace.event(this.#lead, undefined, { kind: "prompt_notices", notices: located.notices });
      // The views are written alongside the lead's run, not before its first call; a read of one waits for its write, and the turn's end for them all.
      if (places.turn !== undefined) {
        const views = promptViews(prompt, guidance, this.#lead, req.leftOut ?? []);
        this.#viewTexts = views;
        this.#views = writeViews(env.files, scope, places.turn, views, env.log);
        this.#tell(this.#views.done);
      }
    }

    const at = env.clock.now();
    const messages: AgentMessage[] = [];
    // What the run is handed, by name, as its start record names it: only what its requests hold.
    const handed: string[] = [];
    // A request that carries no prompt (a run that writes nothing into the chat) is given no frame introducing one.
    if (opening.given.some((ref) => ref.startsWith("prompt:*")) && req.prompt.length > 0) {
      const framing = joined([template(frame)?.render().text ?? ""]);
      if (framing !== "") messages.push(placed(systemMessage(framing, at), "frame"));
      const prompt = promptMessages(req.prompt, model.model, at, this.#roleMark);
      this.#picturesLeft(this.#lead, undefined, prompt.pictures);
      messages.push(...prompt.messages.map((message) => placed(message, "prompt")));
      handed.push(...opening.given.filter((ref) => ref.startsWith("prompt:*")));
    }
    // What the session carries, from where this run's work starts: fixed for the turn, after the prompt, so it never moves the cached front (§10.2).
    const layout = template(carried);
    const record = layout?.header["record"];
    const carry: CarriedInput = { carry: req.carry, tree: file.log, from, scope, files: env.files, log: env.log, ...(typeof record === "string" ? { record } : {}) };
    let carriedAt: number | undefined;
    let carriedNow: Fields | undefined;
    if (opening.given.includes("session:carry") && layout !== undefined) {
      carriedNow = await carriedFields(carry);
      const text = carriedNow === undefined ? "" : joined([layout.render(carriedNow).text]);
      if (text !== "") {
        carriedAt = messages.push(placed(systemMessage(text, at), "session:carry")) - 1;
        handed.push("session:carry");
      }
    }
    if (opening.given.includes("briefing")) {
      const text = await this.#briefing(guidance, definition, template(contract), template(briefing), notices, opening, due.map((fired) => fired.text), places);
      if (text !== undefined) {
        messages.push(placed(systemMessage(joined([text]), at), "briefing"));
        handed.push("briefing");
      }
    }
    // Every other name the lead is given, found as a sub-agent's is, and each file pinned for it, read
    // whole now, at each run's start (R-174): after the briefing, outside the cached front.
    const wanted: Wanted[] = [...opening.given.filter((ref) => !ref.startsWith("prompt:*") && ref !== "session:carry" && ref !== "briefing").map((ref) => ({ ref, from: "definition" as const })), ...(await pinsOf(guidance, req.lead, env.log))];
    if (wanted.length > 0) {
      const given = await this.#given(guidance, this.#lead, wanted, slice);
      if (given.text !== "") messages.push(placed(systemMessage(given.text, at), wanted.map((item) => item.ref).join(", ")));
      handed.push(...given.handed);
    }
    // Compaction at the point before each of the lead's requests (§11): the session's earlier turns
    // first, then the run's own older calls. It is asked here first, before the first call, for the
    // reasons only a run's start has too (the host asked, the records fold), so what the Author is told
    // (`briefing.md`) is what is sent.
    let carrying = carry;
    const earlierPlan = () => {
      const current = file.log.turn(scope.turn);
      return current === undefined || carrying.carry === "nothing" ? undefined : compactionAt(file.log, carrying.from, current, settings.compaction.keepTurns, carrying.compacted);
    };
    const earlierTurns: EarlierTurns | undefined =
      carriedAt === undefined || carriedNow === undefined || layout === undefined
        ? undefined
        : {
            starting: () => (file.log.asked !== undefined ? "asked" : recordsTokens(carriedNow, settings.tokens.charsPerToken) > settings.compaction.recordsTokens ? "fold" : undefined),
            left: () => earlierPlan() !== undefined,
            compact: async (summarize, facts) => {
              const current = file.log.turn(scope.turn);
              const plan = earlierPlan();
              if (current === undefined || plan === undefined) return undefined;
              const material = await compactionMaterial(carrying, plan.turns);
              const summary = await summarize((before, turns) => materialFields(carrying.carry, before, turns), material.summary, material.turns);
              if (summary === undefined || this.#ended()) return undefined;
              // What the turn carries from here, laid out first so the entry keeps the request's size after it: a second compaction in the turn starts after this one.
              const ratio = settings.tokens.charsPerToken;
              const was = joined([layout.render(carriedNow ?? {}).text]);
              const entry = { type: "compacted" as const, parent: file.log.tip(scope.turn) ?? current.id, turn: scope.turn, summary, kept: plan.kept ?? current.id, turns: plan.turns.map((turn) => turn.entry.turn), reason: facts.reason, before: facts.before };
              const fields = (await carriedFields({ ...carrying, compacted: { ...entry, id: "", at: env.clock.now() } })) ?? {};
              const now = joined([layout.render(fields).text]);
              const compacted = file.add({ ...entry, after: facts.before - tokensOf(was, ratio) + tokensOf(now, ratio) });
              carrying = { ...carrying, compacted };
              carriedNow = fields;
              return { at: carriedAt, message: placed(systemMessage(now, env.clock.now()), "session:carry"), keptTurns: plan.keptTurns };
            },
          };
    const track = (entry: { runner: AgentRunner; work: Work }): (() => void) => {
      this.#working.add(entry);
      return () => this.#working.delete(entry);
    };
    const compactor = new Compactor({
      agent: this.#lead,
      trace: this.#trace,
      model,
      connection: connection.label,
      session: scope.session,
      terms: callTerms(settings, this.#lead.definition),
      texts: this.#texts,
      budget: this.#budget,
      settings: settings.compaction,
      parts: async () => ({ compaction: template(await guidance.part("compaction")), carried: layout }),
      ids: () => this.#c.ids(),
      log: env.log,
      ended: (session) => this.#c.models.ended?.(scope.user, session),
      keep: (agent) => this.#keeper(agent).keep,
      track,
      stopped: () => this.#ended(),
      before: (request) => saveBeforeCompaction(request, { options: leadOptions, rules, saveCalls: settings.compaction.saveCalls, ...this.#keeper(this.#lead, "save"), track, stopped: () => this.#ended(), given: handed }),
      ...(earlierTurns !== undefined ? { earlier: earlierTurns } : {}),
      // A summary of the lead's own older calls is the turn's compaction too; it stands for those entries, which the file keeps.
      written: (summary, facts) => void file.add({ type: "compacted", parent: file.log.tip(scope.turn) ?? begun.id, turn: scope.turn, summary, kept: begun.id, of: "run", ...facts }),
      hooks,
    });
    const streamRules = rules.stream(this.#lead);
    const holdBack = heldSentences(streamRules, settings.heldSentences);
    const second = this.#words("second_reply");
    const tagged = opening.form === "tags" && opening.tags !== undefined;
    const check = await this.#releaseCheck(this.#lead, tagged ? "tags" : "message");
    const channel: TextChannel =
      opening.form === "tags" && opening.tags !== undefined
        ? new TagReply({
            tags: opening.tags,
            sink: this.#keep.sink,
            heldSentences: holdBack,
            tailSentences: settings.tailSentences,
            claim: () => this.#desk.claim("tags"),
            ...(second !== undefined ? { second } : {}),
            onBegin: () => this.#say("writing"),
            onIntentBegan: () => this.#trace.event(this.#lead, undefined, { kind: "intent_began" }),
            onIntent: (text) => this.#intent(text),
            onReleased: (text) => this.#release(text, "tags", this.#lead),
            ...(check !== undefined ? { beforeRelease: check } : {}),
          })
        : new MessageReply({
            sink: this.#keep.sink,
            stream: opening.stream,
            heldSentences: holdBack,
            tailSentences: settings.tailSentences,
            claim: () => this.#desk.claim("message"),
            onBegin: () => this.#say("writing"),
            onReleased: (text) => this.#release(text, "message", this.#lead),
            ...(check !== undefined ? { beforeRelease: check } : {}),
          });
    const leadOptions: RunnerOptions = {
      agent: this.#lead,
      trace: this.#trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session: scope.session,
      thinkingLevel: model.thinkingLevel,
      ...(model.asked !== undefined ? { effortSet: model.asked } : {}),
      terms: callTerms(settings, this.#lead.definition),
      instructions: opening.text,
      context: messages,
      tools: declared,
      texts: this.#texts,
      settings: () => (settings.leadSampling === "preset" && req.presetSampling !== undefined ? { sampling: req.presetSampling } : undefined),
      limits: agentLimits(settings, definition),
      turn: this.#budget,
      stream: streamRules,
      runEnd: rules.runEnd,
      afterMessage: rules.afterMessage,
      questions: judges,
      gate: this.#agentRuns().gate(this.#lead, undefined),
      channel,
      ...this.#keeper(this.#lead),
      listSize,
      // His run-end hooks, once a stretch, at the moment its work would end.
      atRunEnd: () => hooks.atRunEnd(scope, { agent: this.#lead }),
    };
    if (earlierTurns?.left() === true) {
      const ratio = settings.tokens.charsPerToken;
      const tokens = tokensOf(opening.text, ratio) + tokensOf(JSON.stringify(declared.map(({ name, description, parameters }) => ({ name, description, parameters }))), ratio) + promptTokens(messages, ratio);
      const window = model.limits.contextWindow?.tokens;
      const spans = await compactor.check({ agent: this.#lead, call: 1, messages, context: { from: 0, to: messages.length }, window, reserve: settings.compaction.reserveTokens, tokens, signal: new AbortController().signal });
      for (const span of spans ?? []) messages.splice(span.from, span.to - span.from, ...span.messages);
    }
    // What the Author was told, as sent: what the session carried into the turn and the briefing (§5.3 l.489).
    if (places.turn !== undefined) await this.#writeBriefing(places.turn, sentMessages(messages));

    const runner = new AgentRunner({ ...leadOptions, point: compactor.point(model.limits.contextWindow?.tokens) });
    this.#leadRunner = runner;
    let outcome: AgentOutcome | undefined;
    if (!this.#ended()) {
      const work = runner.start({ messages: [] }, { given: handed });
      const entry = { runner, work };
      this.#working.add(entry);
      outcome = await work.done;
      this.#working.delete(entry);
    }
    // Nothing more started: the turn was stopped, or its own time ran out on the way (during a compaction, say), and it ends at that limit.
    if (outcome === undefined) return this.#timeUp !== undefined ? this.#outcome({ status: "limit", limit: this.#timeUp }) : this.#outcome({ status: "stopped" });
    // What the rules remembered is kept once every judgment still running has come in: through the host's store, and in memory only for the turns a later turn can still follow.
    await judges.settled();
    await keepMemory(session, env, scope, rules.memory(), new Set(pathTurns(file.log, file.log.tip(scope.turn) ?? null).map((turn) => turn.entry.turn)));
    return this.#outcomeOf(outcome);
  }

  /**
   * The briefing (§10.2 block 4), laid out by its template, or undefined when it holds nothing. What
   * of the opening block no longer stands is found against the block made now from the files as they
   * stand, its tools the session's list with their descriptions as they now read (§6.8); its reply
   * contract is the briefing's `reply_contract`, never the copy the block was made with.
   */
  async #briefing(guidance: Guidance, definition: AgentDefinition, contract: TemplatePart | undefined, layout: TemplatePart | undefined, notices: PromptPart | undefined, opening: Opening, due: string[], places: Places): Promise<string | undefined> {
    if (layout === undefined) return undefined;
    const req = this.#req;
    const situations = [...new Set([req.kind, ...req.since.map((item) => item.kind)])];
    const registry = this.#registry;
    const block = await openingOf({
      guidance,
      agent: req.lead,
      definition,
      tools: registry?.hold(opening.tools).tools ?? [],
      isTool: (name) => registry?.has(name) ?? false,
      situations,
      ...(contract !== undefined ? { contract: { part: contract, form: opening.form } } : {}),
    });
    // The briefing's own parts as the block lays them out: an instruction file without its header block.
    const added = joined(block.parts.flatMap((part) => (part.where === "briefing" && part.left === undefined && part.text !== undefined ? [part.text] : [])));
    const changed = changedText(opening, block, notices);
    const rulesDue = joined(due);
    const noticesText = this.#prompt === undefined ? [] : noticeLines(this.#prompt, await noticeWords(guidance));
    // The host's parts by name, and by the same name with "-" as "_", as a template names a field.
    const hostParts: Record<string, string> = {};
    for (const part of req.briefing) {
      hostParts[part.name] = part.text;
      hostParts[part.name.replaceAll("-", "_")] = part.text;
    }
    // The facts the briefing's template names, as a rule text names them (`{{previous.run.stopped}}` its count, `{{story.from.range}}` a field), read for the lead now; the briefing's own fields stand over them.
    const named = this.#facts === undefined ? [] : factsNamed(layout.template.fields, new Set(this.#facts.defs().map((def) => def.name)));
    const factValues = named.length > 0 && this.#facts !== undefined ? await this.#facts.read(this.scope, this.#lead, named) : {};
    const fields: Fields = {
      ...factFields(factValues),
      ...hostParts,
      turn: { kind: req.kind, ...(req.speaker !== undefined ? { speaker: req.speaker } : {}) },
      ...(req.asked !== undefined && req.asked.length > 0 ? { asked: req.asked } : {}),
      ...(req.prefill !== undefined && req.prefill !== "" ? { prefill: req.prefill } : {}),
      ...(req.since.length > 0 ? { since: { items: req.since.map((item) => item.text) } } : {}),
      ...(changed !== "" ? { files_changed: changed } : {}),
      ...(added !== "" ? { files_added: added } : {}),
      ...(rulesDue !== "" ? { rules_due: rulesDue } : {}),
      ...(noticesText.length > 0 ? { prompt_notices: noticesText.join("\n") } : {}),
      ...(req.briefing.length > 0 ? { blocks: req.briefing.map((part) => ({ name: part.name, text: part.text })) } : {}),
      ...(places.turn !== undefined ? { turn_files: places.turn } : {}),
      // Where the lead writes its intent record itself, whole: in the tag form the record goes in its tag, and this turn's file is the harness's to write.
      ...(opening.form === "two-step" && opening.intentFile !== undefined && places.turn !== undefined ? { intent_path: `${places.turn}${opening.intentFile}` } : {}),
      // The reply contract as it stands now, rendered for the session's form: the template decides whether and where.
      ...(block.contract !== undefined && block.contract !== "" ? { reply_contract: block.contract } : {}),
      // What the session's cache holds (§11 l.1361): what it has already looked up, and where each is.
      ...(await this.#cacheFields(places)),
      // The session's file could not be read, or some of its lines (§17.2): why, so the lead knows what it holds of the scene is short.
      ...(this.#unreadable !== undefined ? { session_unreadable: "reason" in this.#unreadable ? { reason: this.#unreadable.reason } : { lines: this.#unreadable.lines } } : {}),
      // What his turn-start hooks added (§5.4 "Hooks").
      ...(this.#hooked !== "" ? { hooks: this.#hooked } : {}),
    };
    const text = layout.render(fields).text;
    return text.trim() === "" ? undefined : text;
  }

  /**
   * What an agent's definition names in `given:` beyond the lead's blocks of its own (§5.4, §10.2),
   * and the files pinned for it: files, stretches of the chat, lore, parts of the prompt and the
   * host's views, found as a sub-agent's are and the whole list given to the host to keep; laid out by
   * the given part, with each name nobody could give. Without the part, what was found goes as it is,
   * one after another. With it, the names of what was handed.
   */
  async #given(guidance: Guidance, reader: AgentRef, wanted: readonly Wanted[], slice: (ref: string, reader: AgentRef) => Promise<string | undefined>): Promise<{ text: string; handed: string[] }> {
    const [layout, delegation] = await Promise.all([guidance.part(GIVEN_PART), guidance.part(DELEGATION_PART)]);
    const given = await attach({ env: this.#env, scope: this.scope, lines: lines(delegation), most: this.#settings.perCall, moment: { task: "" }, slice }, reader, wanted);
    const handed = given.blocks.map((block) => block.name);
    const part = template(layout);
    if (part === undefined) return { text: joined(given.blocks.map((block) => block.text)), handed };
    return { text: joined([part.render({ ...(given.blocks.length > 0 ? { attachments: given.blocks.map((block) => ({ name: block.name, text: block.text })) } : {}), ...(given.missing.length > 0 ? { missing: given.missing } : {}) }).text]), handed };
  }

  /** The connection a definition names: `default` (or none) is the default connection; any other name is a connection's name or id. The effort is the one the settings and its header give an agent of it. */
  #connection(definition: AgentDefinition): Promise<Connection> {
    return connectionOf(this.#c.connections, this.scope, definition, this.#c.env.log, this.#settings);
  }

  #ownTools(texts: ReadonlyMap<string, ToolText>, team: TeamWork, guidance: Guidance): OwnTool[] {
    return ownTools({
      // The agents' tools read through the turn's files, so a view still being written is waited for.
      env: this.#env,
      guidance,
      texts,
      settings: this.#settings,
      words: (name, fields) => this.#words(name, fields),
      todos: this.#todos,
      todoChanged: (agent, items) => this.#trace.event(agent, this.#parents.get(agent.id), { kind: "todo", items: [...items] }),
      written: (_scope, by, done) => this.#written(by, done.path),
      reply: { write: (brief, live, ctx) => this.#write(brief, live, ctx), release: (path, ctx) => this.#releaseReply(path, ctx) },
      team,
      jobs: this.#c.jobs,
      ids: () => this.#c.ids(),
      prompt: async () => this.#prompt,
      reach: { of: (agent) => this.#reach(agent), run: (tool, args, ctx) => this.#runAs(tool, args, ctx) },
      keepLore: (ctx, entry) => this.#keepLore(ctx, entry),
      sceneMap: this.#sceneMap(),
      guidesGiven: this.#guidesGiven(),
    });
  }

  /**
   * What an agent may reach by searching (§6.8): every tool registered, the tools its requests carry,
   * and the families its definition keeps out of reach; the lead's as its opening block fixed them for
   * the session. A definition that keeps the reply tools from its agent names their family in
   * `out_of_reach:`, as it does any family (§10.6, Appendix C).
   */
  async #reach(agent: AgentRef): Promise<AgentReach> {
    const opening = this.#opening;
    const lead = agent.id === this.#lead.id ? opening : undefined;
    const definition = lead === undefined ? await this.#guidance?.definition(agent.definition) : undefined;
    const fixed = lead?.tools ?? definition?.tools ?? [];
    const outOfReach = lead?.outOfReach ?? definition?.outOfReach ?? [];
    const tools = this.#registry?.all() ?? [];
    return { tools, fixed, outOfReach };
  }

  /** A tool found by `tool_use`, run as itself by the runner of the agent whose call carries it. */
  #runAs(tool: LoopTool, args: JsonValue, ctx: ToolCtx): Promise<LoopToolResult> {
    for (const { runner } of this.#working) if (runner.agent.id === ctx.agent.id) return runner.runAs(tool, args, ctx);
    // Every agent's work is tracked from its start, before it can call anything: a call from any other runs nothing.
    this.#c.env.log.error("A tool found by tool_use was called by an agent the turn has no work of.", { agent: ctx.agent.id, tool: tool.name });
    return Promise.resolve({ content: [], error: true });
  }

  #agentRuns(): AgentRuns {
    if (this.#runs === undefined) throw new Error("The turn's agents were made before its places were read.");
    return this.#runs;
  }

  #rulesRun(): RuleRun {
    if (this.#rules === undefined) throw new Error("The turn's rules were asked for before they were loaded.");
    return this.#rules;
  }

  /**
   * Tools an agent's list names that it does not hold (§6.8): its definition lists a name nobody
   * registered, a host's tool takes one of RPH's names, or the host withdrew one its session declared.
   * The log and the trace are told once in the session, when each is first found, and not every turn.
   */
  #unheld(reason: "unregistered" | "shadowed" | "withdrawn", definition: string, names: readonly string[], message: string): void {
    if (names.length === 0) return;
    const fresh = unsaid(this.#c.sessions.of(this.scope), `${reason} ${definition}`, names);
    if (fresh.length === 0) return;
    this.#c.env.log.warn(message, { agent: definition, tools: fresh });
    for (const tool of fresh) this.#trace.event(this.#lead, undefined, { kind: "tool_unheld", tool, definition, reason });
  }

  /** What an agent's calls are sent, kept as `trace.requests` names them (`AgentRuns.keep`), as the runner's option. */
  #keeper(agent: AgentRef, kind?: "call" | "save"): { keep?: KeepRequest } {
    const keep = this.#agentRuns().keep(agent, kind);
    return keep === undefined ? {} : { keep };
  }

  /** RPH's own facts for an agent, now (§5.4 "Facts"). */
  #ownFacts(agent: AgentRef): OwnFactValues {
    const open = this.#todos.get(agent.id).filter((item) => !item.done);
    // What is left to the agent at work under its own limits and the turn's.
    const runner = [...this.#working].find((entry) => entry.runner.agent.id === agent.id)?.runner;
    const left = leftFact(runner?.left() ?? {}, this.#budget.left());
    return {
      "reply.released": { count: this.#desk.released ? 1 : 0 },
      // What the request says (§10.7) less what was released: a fact for the rules, which changes nothing of how a run ends.
      "reply.owed": { count: this.#req.owesReply !== false && !this.#desk.released ? 1 : 0 },
      "todo.open": { count: open.length, names: open.map((item) => item.text) },
      "prompt.notices": { count: this.#notices },
      "session.turns": { count: this.#sessionTurns },
      ...(left !== undefined ? { "limits.left": left } : {}),
    };
  }

  /** Where the session's cache is, as the cache's functions take it: the session's own scope (a write there belongs to no turn) and its places. */
  #cacheDeps(places: Places): CacheDeps {
    const { env } = this.#c;
    return { files: env.files, scope: { user: this.scope.user, chat: this.scope.chat, session: this.scope.session }, places, log: env.log };
  }

  /** Each scratch file the session carries that stands on the path at `from`, written into this turn's own scratch. */
  async #carryIn(file: SessionFile, from: string | null, places: Places, carried: readonly string[]): Promise<void> {
    const at = places.turn;
    if (at === undefined || carried.length === 0) return;
    const d = this.#cacheDeps(places);
    const kept = standing(file.log, from);
    for (const path of carried) {
      const entry = kept.get(path);
      const text = entry === undefined ? undefined : await readCached(d, entry);
      if (text === undefined) continue;
      const written = await d.files.write(this.scope, `${at}${path}`, { op: "write", text }, "harness");
      if (written.status !== "written") d.log.warn("A scratch file the session carries could not be put in the turn's scratch.", { turn: this.scope.turn, path, status: written.status });
    }
  }

  /** At the turn's end: the turn's own version of each carried scratch file becomes the standing one, as its work. */
  async #keepScratch(): Promise<void> {
    const file = this.#file;
    const places = this.#places;
    if (file === undefined || places?.turn === undefined) return;
    const d = this.#cacheDeps(places);
    for (const path of this.#settings.sessions.carried) {
      const read = await d.files.read(this.scope, `${places.turn}${path}`);
      if (read.status === "read") await keepCached(file, d, this.scope.turn, path, read.text);
    }
  }

  /** A lore entry read in full by an agent that plays no character, kept in the session's cache as this turn's work. */
  #keepLore(ctx: ToolCtx, entry: LoreEntry): void {
    const file = this.#file;
    const places = this.#places;
    if (ctx.agent.plays !== undefined || file === undefined || places === undefined) return;
    void this.#tell(keepCached(file, this.#cacheDeps(places), this.scope.turn, loreKey(entry.id), entry.text, { id: entry.id, title: entry.title, source: entry.source, ...(entry.revision !== undefined ? { revision: entry.revision } : {}) }));
  }

  /** The scene's copy of the prompt map in the session's cache (§11, §4.8): read as it stands on this turn's path, and kept as this turn's work. */
  #sceneMap(): SceneMap {
    return {
      standing: async () => {
        const file = this.#file;
        const places = this.#places;
        const entry = file === undefined ? undefined : standing(file.log, file.log.tip(this.scope.turn) ?? null).get(PROMPT_MAP_KEY);
        const text = entry === undefined || places === undefined ? undefined : await readCached(this.#cacheDeps(places), entry);
        return text === undefined ? undefined : { text, ...(entry?.meta !== undefined ? { meta: entry.meta } : {}) };
      },
      keep: async (text, meta) => {
        const file = this.#file;
        const places = this.#places;
        if (file !== undefined && places !== undefined) await keepCached(file, this.#cacheDeps(places), this.scope.turn, PROMPT_MAP_KEY, text, meta);
      },
    };
  }

  /** The families whose guide a tool search gave (`tool_search`): the lead's for the whole session, read on this turn's path from the session's cache and kept there as this turn's work; any other agent's for its run. */
  #guidesGiven(): GuidesGiven {
    const lead = (agent: AgentRef): boolean => agent.id === this.#lead.id;
    const leads = async (): Promise<Set<string>> => {
      const file = this.#file;
      const places = this.#places;
      const entry = file === undefined ? undefined : standing(file.log, file.log.tip(this.scope.turn) ?? null).get(GUIDES_KEY);
      const text = entry === undefined || places === undefined ? undefined : await readCached(this.#cacheDeps(places), entry);
      let list: unknown = [];
      try {
        if (text !== undefined) list = JSON.parse(text);
      } catch {
        // A list someone spoiled is read as none: each guide is given again, once.
      }
      return new Set(Array.isArray(list) ? list.filter((family): family is string => typeof family === "string") : []);
    };
    return {
      given: async (agent) => (lead(agent) ? leads() : (this.#guides.get(agent.id) ?? new Set())),
      add: async (agent, families) => {
        if (!lead(agent)) {
          const given = this.#guides.get(agent.id) ?? new Set<string>();
          for (const family of families) given.add(family);
          this.#guides.set(agent.id, given);
          return;
        }
        const file = this.#file;
        const places = this.#places;
        if (file === undefined || places === undefined) return;
        const given = await leads();
        for (const family of families) given.add(family);
        await keepCached(file, this.#cacheDeps(places), this.scope.turn, GUIDES_KEY, JSON.stringify([...given]));
      },
    };
  }

  /** The briefing's `cache` field: the scratch files carried into this turn, the lore entries kept, the prompt map, and the host's own files there, each with where it is. */
  async #cacheFields(places: Places): Promise<Fields> {
    const file = this.#file;
    if (file === undefined) return {};
    const d = this.#cacheDeps(places);
    const folder = `${places.session}${CACHE}`;
    const kept = standing(file.log, file.log.tip(this.scope.turn) ?? null);
    const carried = places.turn === undefined ? [] : this.#settings.sessions.carried.filter((path) => kept.has(path)).map((path) => ({ path: `${places.turn}${path}` }));
    const lore = [...kept.values()].flatMap((entry) => (entry.key.startsWith("lore/") && entry.meta !== undefined ? [{ id: entry.meta["id"] ?? "", title: entry.meta["title"] ?? "", path: `${folder}${entry.file}` }] : []));
    const map = kept.get(PROMPT_MAP_KEY);
    const host = (await hostCached(d, file.log)).map((path) => ({ path }));
    if (carried.length === 0 && lore.length === 0 && map === undefined && host.length === 0) return {};
    return { cache: { folder, ...(carried.length > 0 ? { carried } : {}), ...(lore.length > 0 ? { lore } : {}), ...(map !== undefined ? { prompt_map: `${folder}${map.file}` } : {}), ...(host.length > 0 ? { host } : {}) } };
  }

  /**
   * Writes what the lead was told at this run's start, as sent (§5.3 l.489): what the session
   * carried into the turn and the briefing, to the turn folder's `briefing.md`; a later run of the
   * same turn (a continue) to a file of its own beside it, none written over.
   */
  async #writeBriefing(turn: string, sent: readonly KeptMessage[]): Promise<void> {
    const told = sent.filter((message) => message.block === "session:carry" || message.block === "briefing").map((message) => message.text);
    if (told.length === 0) return;
    const env = this.#c.env;
    const first = await env.files.read(this.scope, `${turn}${BRIEFING_FILE}`);
    const file = first.status === "read" ? `briefing.${this.run.replace(/[^A-Za-z0-9_-]/g, "-")}.md` : BRIEFING_FILE;
    const text = joined(told);
    this.#briefed = { file, text };
    this.#tell(env.files.write(this.scope, `${turn}${file}`, { op: "write", text }, "harness"));
  }

  /** The files of the turn's folder a kept request may point into: this run's briefing, and the prompt's views. */
  async #sources(): Promise<PointedFile[]> {
    return [...(this.#briefed !== undefined ? [this.#briefed] : []), ...((await this.#viewTexts) ?? [])];
  }

  /**
   * Pictures of the prompt an agent's request cannot carry: pi's system and assistant messages hold
   * text alone (§10.2). Which message held them and how many are the host's to hear, by the trace
   * alone, and to word for the agent if it will; RPH says nothing of them to any agent.
   */
  #picturesLeft(agent: AgentRef, parent: ParentCall | undefined, pictures: readonly { message: number; count: number }[]): void {
    if (pictures.length > 0) this.#trace.event(agent, parent, { kind: "prompt_notices", notices: [], pictures: [...pictures] });
  }

  /** The lead's intent record, the moment its tag closed (§10.3): to the host, to the trace, and into the turn's folder. Never read, and nothing waits for it. */
  #intent(text: string): void {
    const { env } = this.#c;
    this.#trace.event(this.#lead, undefined, { kind: "intent", text });
    this.#tell(env.events.intent(this.scope, text));
    const file = this.#opening?.intentFile;
    const turn = this.#places?.turn;
    if (file === undefined || turn === undefined) return;
    const op = this.#intentWritten ? { op: "append" as const, text: `\n\n${text}` } : { op: "write" as const, text };
    this.#intentWritten = true;
    this.#tell(env.files.write(this.scope, `${turn}${file}`, op, "harness"));
  }

  /** A write begins: where the lead writes its intent record into the turn's folder itself (§10.7), the record begins with it, as it does at its opening tag. */
  #writing(path: string, by: Writer): void {
    const file = this.#opening?.intentFile;
    const turn = this.#places?.turn;
    if (by === "harness" || by.id !== this.#lead.id || file === undefined || turn === undefined || plainPath(path) !== plainPath(`${turn}${file}`)) return;
    this.#trace.event(this.#lead, undefined, { kind: "intent_began" });
  }

  /** A write went through: on a connection without tags, the lead writes its intent record into the turn's folder itself (§10.7), and the host is told it as it would be from the tag. */
  async #written(by: { id: string }, path: string): Promise<void> {
    const file = this.#opening?.intentFile;
    const turn = this.#places?.turn;
    if (by.id !== this.#lead.id || file === undefined || turn === undefined || path !== `${turn}${file}`) return;
    const read = await this.#c.env.files.read(this.scope, path);
    if (read.status !== "read" || read.text === "") return;
    this.#trace.event(this.#lead, undefined, { kind: "intent", text: read.text });
    this.#tell(this.#c.env.events.intent(this.scope, read.text));
  }

  /**
   * The reply went out: the sink is finished, the host and the trace are told at once, the reply is
   * kept in the turn's folder, and each question rule on the reply is put now, in every form (§5.4).
   */
  #release(text: string, form: ReleaseForm, by: AgentRef, path?: string): void {
    const { env } = this.#c;
    this.#desk.out();
    this.#released = { text, form };
    this.#keep?.sink.finish({ ...this.#budget.used });
    const release: Release = { by, form, ...(path !== undefined ? { path } : {}), length: text.length };
    this.#trace.event(by, this.#parents.get(by.id), { kind: "released", release });
    this.#tell(env.events.released(this.scope, release));
    const turn = this.#places?.turn;
    if (turn !== undefined) this.#tell(env.files.write(this.scope, `${turn}${RELEASED_FILE}`, { op: "write", text }, "harness"));
    for (const answer of this.#judges?.released(by, text) ?? []) {
      void answer.then(
        (judged) => {
          if (judged !== undefined) this.#replyJudged(by, judged);
        },
        // A judgment that failed fires nothing; the judge's run says why.
        () => undefined,
      );
    }
    // Each sub-agent not kept ends with the reply (§13.4).
    this.#team?.released();
    // His after-release hooks, with the reply as released (§5.4 "Hooks"): what they add goes to the lead's run, which may go on (§10.9).
    const hooks = this.#hooks;
    if (hooks !== undefined) {
      this.#tell(
        hooks.run("after-release", { scope: scopeJson(this.scope), release: { form, text, by: agentJson(by) } }, { agent: by }).then((hooked) => {
          if (hooked.added.length > 0) this.#leadRunner?.tell(joined(hooked.added));
        }),
      );
    }
  }

  /**
   * A question about the reply fired: its text was held for the next briefing, the reply being
   * shown already. It is traced now; what its agent did next is told when it next acts, or at once
   * when its work has ended.
   */
  #replyJudged(agent: AgentRef, judged: Judged): void {
    if (![...this.#working].some(({ runner }) => runner.agent.id === agent.id)) {
      this.#late(agent, judged);
      return;
    }
    this.#trace.event(agent, this.#parents.get(agent.id), { kind: "rule_fired", firing: { ...judged.fired.firing, agent, action: "briefing" } });
  }

  /** `write_reply`: the writer's one call (§10.6), on the prompt exactly as it was sent, with the preset's sampling and prefill, and the brief. */
  async #write(brief: string, live: boolean, ctx: ToolCtx): Promise<LoopToolResult> {
    const { env } = this.#c;
    const req = this.#req;
    const words = this.#words;
    if (this.#desk.taken) return answer(words("second_reply"), true);
    const guidance = this.#guidance;
    // Who writes is in the definitions (§10.6): the writer the caller's own definition names; code names none of its own.
    const writer = guidance === undefined ? undefined : (await guidance.definition(ctx.agent.definition))?.writer;
    const definition = writer === undefined || guidance === undefined ? undefined : await guidance.definition(writer);
    if (writer === undefined || guidance === undefined || definition === undefined) {
      // Why there is none, for the file's line to say: none is named, or the one named is missing, switched off or broken.
      const left = writer === undefined || guidance === undefined ? undefined : (await guidance.stack(writer)).entries.find((entry) => entry.kind === "definition")?.left;
      return answer(words("no_writer", { ...(writer !== undefined ? { writer } : {}), ...(left !== undefined ? { [left]: true } : {}) }), true);
    }
    const ref: AgentRef = { id: this.#c.ids(), definition: writer, parent: ctx.agent.id };
    // The writer's session is its own, as a sub-agent's is: never the lead's cached front or thread (§10.2, §11). It is let go each time its run ends.
    const session = this.#c.ids();
    const held = this.#registry?.hold(definition.tools) ?? { tools: [], missing: [] };
    // Its opening block is made as any agent's is, by the one builder (§10.6: an agent like the others).
    const block = await openingOf({ guidance, agent: writer, definition, tools: held.tools, isTool: (name) => this.#registry?.has(name) ?? false, fields: fieldsOf(ref), log: env.log });
    const connection = await this.#connection(definition);
    const model = await this.#c.models.agentModel(connection.choice);
    const parent: ParentCall = { agent: ctx.agent.id, run: this.run, call: ctx.callId };
    this.#parents.set(ref.id, parent);
    this.#c.usage.gauge(this.scope, this.run, ref.id, model.limits.contextWindow?.tokens ?? 0, model.limits.maxTokens?.tokens ?? 0);
    const at = env.clock.now();
    const messages: AgentMessage[] = [];
    // What it is handed, by name, as its start record names it: only what its request holds.
    const handed: string[] = [];
    const givesPrompt = definition.given.some((given) => given.startsWith("prompt:*"));
    if (givesPrompt) {
      // A prefilled start is the prompt's last message; it is kept for the very end, where the writer goes on from it.
      const last = req.prompt.at(-1);
      const prompt = req.prefill !== undefined && last?.role === "assistant" && promptText(last) === req.prefill ? req.prompt.slice(0, -1) : req.prompt;
      const converted = promptMessages(prompt, model.model, at, this.#roleMark);
      this.#picturesLeft(ref, parent, converted.pictures);
      messages.push(...converted.messages.map((message) => placed(message, "prompt")));
      if (req.prompt.length > 0) handed.push(...definition.given.filter((given) => given.startsWith("prompt:*")));
    }
    if (block.text !== "") messages.push(placed(systemMessage(block.text, at), "opening"));
    // Everything else its definition's `given:` names but its own blocks (the prompt, the brief), and
    // each file pinned for it, read whole now, as a sub-agent's run is handed them (R-174).
    const wanted: Wanted[] = [...definition.given.filter((given) => !given.startsWith("prompt:*") && given !== WRITER_BRIEF).map((given) => ({ ref: given, from: "definition" as const })), ...(await pinsOf(guidance, writer, env.log))];
    if (wanted.length > 0) {
      const given = await this.#given(guidance, ref, wanted, promptSlice(async () => this.#prompt, guidance));
      if (given.text !== "") messages.push(placed(systemMessage(given.text, at), wanted.map((item) => item.ref).join(", ")));
      handed.push(...given.handed);
    }
    messages.push(placed(userMessage(brief, at), WRITER_BRIEF));
    if (definition.given.includes(WRITER_BRIEF)) handed.push(WRITER_BRIEF);
    if (givesPrompt && req.prefill !== undefined && req.prefill !== "") messages.push(placed(assistantMessage(req.prefill, model.model, at), "prompt"));
    const rules = this.#rulesRun();
    const streamRules = rules.stream(ref);
    const check = live ? await this.#releaseCheck(ref, "narrator-live") : undefined;
    const shown = live
      ? new MessageReply({
          sink: this.#keep?.sink ?? this.#sink,
          stream: true,
          heldSentences: heldSentences(streamRules, this.#settings.heldSentences),
          tailSentences: this.#settings.tailSentences,
          claim: () => this.#desk.claim("narrator-live"),
          onBegin: () => this.#say("writing"),
          onReleased: (text) => this.#release(text, "narrator-live", ref),
          ...(check !== undefined ? { beforeRelease: check } : {}),
        })
      : undefined;
    // A draft shows nothing, and the rules on the reply look at it as it is written all the same.
    const channel: TextChannel = shown ?? new SilentReply();
    if (!live) this.#say("writing");
    this.#unheld("unregistered", writer, held.missing, "Tools the writer's definition lists are registered by nobody; it holds the rest.");
    const runner = new AgentRunner({
      agent: ref,
      trace: this.#trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session,
      thinkingLevel: model.thinkingLevel,
      ...(model.asked !== undefined ? { effortSet: model.asked } : {}),
      // The preset's sampling comes by its settings; a writer has none of its own.
      terms: callTerms(this.#settings),
      tools: held.tools,
      texts: this.#texts,
      settings: () => ({ ...(req.presetSampling !== undefined ? { sampling: req.presetSampling } : {}), ...(req.replyMaxTokens !== undefined ? { maxTokens: req.replyMaxTokens } : {}) }),
      limits: agentLimits(this.#settings, definition),
      turn: this.#budget,
      stream: streamRules,
      runEnd: rules.runEnd,
      afterMessage: rules.afterMessage,
      ...(this.#judges !== undefined ? { questions: this.#judges } : {}),
      gate: this.#agentRuns().gate(ref, parent),
      channel,
      ...this.#keeper(ref),
      ...(this.#hooks !== undefined ? { atRunEnd: () => this.#hooks?.atRunEnd(this.scope, { agent: ref, parent }) ?? Promise.resolve(undefined) } : {}),
    });
    // Each later stretch of the writer's work, which a message sets going, ends its run as well: its draft is kept, and its session let go.
    const stretchEnded = (ended: AgentOutcome): void => {
      if (!live) this.#drafted(ref, ended);
      this.#c.models.ended?.(this.scope.user, session);
    };
    // The writer stands in the team as a sub-agent does: the user's limits hold for it and for what it
    // starts, and its question comes back as this call's answer, for the agent that called to answer.
    const refused = await this.#team?.enlist(ref, runner, parent, ctx, stretchEnded);
    if (refused !== undefined) return refused;
    // A stop that came while the writer was being made fired before any listener was on it: from here
    // on nothing is awaited until the writer's work is tracked and listening, so this is the last look.
    if (ctx.signal.aborted || this.#stopped) return { content: [] };
    const work = runner.start({ messages }, { parent, given: handed });
    const entry = { runner, work };
    this.#working.add(entry);
    const stop = (): void => work.stop();
    ctx.signal.addEventListener("abort", stop, { once: true });
    let outcome: AgentOutcome;
    try {
      outcome = await work.done;
    } finally {
      this.#working.delete(entry);
      ctx.signal.removeEventListener("abort", stop);
      this.#c.models.ended?.(this.scope.user, session);
    }
    if (outcome.status === "asked" && this.#team !== undefined) return this.#team.asked(ref, outcome);
    // Why there is no reply is the file's to say, by how the writer's work ended; the error's own words are the model layer's or the provider's, for whoever runs the host.
    if (outcome.error !== undefined && outcome.error !== "") env.log.warn("The writer's work ended in an error.", { writer, status: outcome.status, error: outcome.error });
    const hit = outcome.limit;
    const floor: JsonObject = hit?.floor !== undefined ? { floor: hit.floor, left: hit.max - hit.value } : {};
    const failedWords = { writer, ...(outcome.status === "failed" || outcome.status === "limit" || outcome.status === "stopped" ? { [outcome.status]: true } : {}), ...(hit !== undefined ? { hit: { limit: hit.limit, is: { [hit.limit]: true }, per: hit.per, max: hit.max, value: hit.value, ...floor } } : {}) };
    // Stopped by the least room for an answer, with the limit not passed: its own line says what was left, and that its call was not made for it.
    const unwritten = outcome.status === "limit" && hit?.floor !== undefined ? "not_written_floor" : "not_written";
    if (shown !== undefined) return shown.released ? { content: [{ type: "text", text: shown.shown }] } : answer(words(unwritten, failedWords), true);
    if (outcome.status !== "done" || outcome.text.trim() === "") return answer(words(unwritten, failedWords), true);
    this.#drafted(ref, outcome);
    return { content: [{ type: "text", text: outcome.text }] };
  }

  /** The writer's draft (§10.6), once a stretch of its work ended with one: what `reply_release` sends. */
  #drafted(ref: AgentRef, outcome: AgentOutcome): void {
    if (outcome.status === "done" && outcome.text.trim() !== "") this.#draft = { text: outcome.text, by: ref };
  }

  /** `reply_release`: the last draft, or a file's text, sent whole (§10.7). */
  async #releaseReply(path: string | undefined, ctx: ToolCtx): Promise<LoopToolResult> {
    const words = this.#words;
    if (this.#desk.taken) return answer(words("second_reply"), true);
    if (path !== undefined) {
      const read = await this.#c.env.files.read(this.scope, path);
      // A stop that came while the file was read: the sink has had its error, and nothing follows it.
      if (ctx.signal.aborted || this.#stopped) return { content: [] };
      if (read.status === "refused") return answer(words(`refused_${read.reason}`, { path: read.path, writable: read.writable }), true);
      if (read.status === "missing") return answer(words(read.folder === true ? "folder" : "missing", { path: read.path }), true);
      const kept = await this.#heldBack(read.text, "file", ctx.agent);
      if (ctx.signal.aborted || this.#stopped) return { content: [] };
      if (kept !== undefined) return answer(kept, true);
      if (!this.#desk.claim("file")) return answer(words("second_reply"), true);
      this.#keep?.sink.content(read.text);
      this.#release(read.text, "file", ctx.agent, read.path);
      return answer(words("released"));
    }
    const draft = this.#draft;
    if (draft === undefined) return answer(words("no_draft"), true);
    const kept = await this.#heldBack(draft.text, "narrator", draft.by);
    if (ctx.signal.aborted || this.#stopped) return { content: [] };
    if (kept !== undefined) return answer(kept, true);
    if (!this.#desk.claim("narrator")) return answer(words("second_reply"), true);
    this.#keep?.sink.content(draft.text);
    this.#release(draft.text, "narrator", draft.by);
    return answer(words("released"));
  }

  /** His before-release hooks for a reply `by` writes in `form`, when one is in force (§5.4 "Hooks"): they see it whole before it goes out, and the UI is told it waits for them. */
  async #releaseCheck(by: AgentRef, form: ReleaseForm): Promise<ReleaseCheck | undefined> {
    const hooks = this.#hooks;
    if (hooks === undefined || !(await hooks.any("before-release"))) return undefined;
    return {
      waits: () => this.#say("hook_waits"),
      check: async (text) => (await hooks.run("before-release", { scope: scopeJson(this.scope), reply: { form, text, by: agentJson(by) } }, { agent: by })).blocked?.reason,
    };
  }

  /** A reply sent whole (`reply_release`), seen first by his before-release hooks: the reason one kept it back with, or none. */
  async #heldBack(text: string, form: ReleaseForm, by: AgentRef): Promise<string | undefined> {
    const check = await this.#releaseCheck(by, form);
    if (check === undefined) return undefined;
    check.waits();
    return check.check(text);
  }

  /** A progress line (§10.7), from the progress part, while the reply is still to come; the setting may keep all but the silence line back. */
  #say(name: string, fields?: Fields): void {
    if (this.#desk.released || this.#keep === undefined || this.#settings.progress === "least") return;
    const line = this.#progress?.line(name, fields);
    if (line !== undefined) this.#keep.sink.progress(line);
  }

  /** The turn's own time ran out: every agent ends where it stands, at that limit. */
  #outOfTime(max: number): void {
    const hit = { limit: "time" as const, per: "turn" as const, max, value: (this.#earlier?.ms ?? 0) + this.#c.env.clock.now() - this.#startedAt };
    this.#timeUp = hit;
    for (const { runner } of this.#working) runner.limit(hit);
  }

  /** Every record of the run: the usage, the lead's entries in the session file, progress lines, and what each fired rule's agent did next. */
  #watch(record: AgentRecord): void {
    this.#c.usage.record(record);
    this.#record(record);
    this.#heldPast();
    const { event } = record;
    const agent = record.agent.id;
    switch (event.kind) {
      case "call_started":
        this.#calls.set(agent, event.call);
        return;
      case "tool_started":
        this.#say("tool", { tool: event.tool });
        return;
      case "rule_fired":
        this.#firings.push({ firing: event.firing, call: this.#calls.get(agent) ?? 0 });
        this.#say("rule", { rule: event.firing.rule });
        return;
      case "call_failed":
        // The failed try's thinking is over; a try made again thinks under its own heading.
        this.#thinking?.ended(record.agent, event.call);
        // A call made again: said in the progress file's words, with what broke it, the wait and the try it goes on to.
        if (event.retried) this.#say("retrying", { failure: event.failure, is: { [event.failure]: true }, seconds: Math.ceil((event.wait ?? 0) / 1000), next: event.tries + 1, most: event.retries + 1 });
        return;
      case "call_ended": {
        this.#thinking?.ended(record.agent, event.call);
        // A call cut by a rule, or broken off, did nothing a rule's firing waits to hear of: no tool runs from it.
        if (event.stop === "cut" || event.stop === "error") return;
        if (agent === this.#lead.id && event.error === undefined) {
          // In the tag form, its marked parts (the intent record, a reply) taken out: never the record into the chat.
          const tags = this.#opening?.form === "tags" ? this.#opening.tags : undefined;
          const plain = (tags !== undefined ? outsideTags(event.text, tags) : event.text).trim();
          if (plain !== "") this.#lastText = plain;
        }
        const then: RuleThen | undefined = event.toolCalls.length > 0 ? { did: "called", tools: event.toolCalls.map((call) => call.name) } : event.text !== "" ? { did: "wrote" } : undefined;
        if (then !== undefined) this.#then(agent, (firing) => event.call > firing.call, then);
        return;
      }
      case "released":
        this.#then(agent, (firing) => (this.#calls.get(agent) ?? 0) > firing.call, { did: "released" });
        return;
      case "agent_ended":
        this.#thinking?.agentEnded(record.agent);
        this.#then(agent, () => true, { did: "ended" });
        return;
      default:
        return;
    }
  }

  /** Past the lines held while session files cannot be written (`sessions.maxUnwrittenMiB`), with the turn's own among them: every agent of the turn stops, and its run ends failed. What is held stays held. */
  #heldPast(): void {
    const failure = this.#file?.failure;
    if (this.#full !== undefined || failure === undefined || !this.#c.book.over) return;
    this.#full = failure;
    this.stop();
  }

  /**
   * A run whose session file still holds lines it could not write, or that was stopped past the lines
   * held, ends failed, in the words of `session_unwritten` (`.prompts/tool-notices.md`), naming the file
   * and the host's reason. A run that failed already keeps its own failure. The lines stay with the
   * file, which the book keeps, for a later write to land.
   */
  #unkept(outcome: RunOutcome): RunOutcome {
    const file = this.#file;
    if (outcome.status === "failed" || file === undefined || (!file.unwritten && this.#full === undefined)) return outcome;
    const detail = this.#words("session_unwritten", { path: file.path, reason: file.failure ?? this.#full ?? "", ...(this.#full !== undefined ? { over: true, most: this.#settings.sessions.unwrittenMost } : {}) });
    return this.#outcome({ status: "failed", error: { code: "failed", ...(detail !== undefined ? { detail } : {}) } });
  }

  /** The lead's work, into the session file as it happens (§11): its intent records, what it wrote in each call, its calls and what came back. Never its thinking. */
  #record(record: AgentRecord): void {
    const file = this.#file;
    if (file === undefined || record.agent.id !== this.#lead.id) return;
    const entry = entryOf(record.event, this.scope.turn, file.log.tip(this.scope.turn) ?? null);
    if (entry !== undefined) file.add(entry);
  }

  /**
   * A `question:` rule the judging model's answer fired once its agent's work had ended. The lead's
   * text is held for its next briefing, as a rule on a reply already shown is; another agent's has
   * no way in front of it, and the log says so. Either is traced and told, its agent having ended.
   */
  #late(agent: AgentRef, judged: Judged): void {
    if (judged.deliver === "now" && agent.id !== this.#lead.id) {
      this.#c.env.log.info("A rule's question was answered yes after its agent's work had ended; its text went to no agent.", { agent: agent.id, rule: judged.fired.firing.rule });
      return;
    }
    if (judged.deliver === "now") this.#rulesRun().hold(agent, judged.fired);
    this.#trace.event(agent, this.#parents.get(agent.id), { kind: "rule_fired", firing: { ...judged.fired.firing, agent, action: "briefing" } });
    this.#then(agent.id, () => true, { did: "ended" });
  }

  /** Tells the host of each rule that fired for `agent` and that `which` takes, now that what the agent did next is known (§5.4). */
  #then(agent: string, which: (firing: { call: number }) => boolean, then: RuleThen): void {
    const waiting: { firing: RuleFiring; call: number }[] = [];
    for (const fired of this.#firings) {
      if (fired.firing.agent.id === agent && which(fired)) this.#tell(this.#c.env.events.ruleFired(this.scope, { ...fired.firing, then }));
      else waiting.push(fired);
    }
    this.#firings = waiting;
  }

  /** Tells the host something, or writes for the turn, without waiting: a failure is logged, and the turn's end waits for it to settle. */
  #tell(promise: Promise<unknown>): Promise<unknown> {
    const told = promise.catch((error: unknown) => this.#c.env.log.error("The host could not be told what the turn did.", { turn: this.scope.turn, run: this.run, error: errorWords(error) }));
    this.#pending.add(told);
    void told.finally(() => this.#pending.delete(told));
    return told;
  }

  /** Waits until everything the host is being told, and everything being written for the turn, has settled. */
  async #told(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  async #settled(): Promise<void> {
    await this.#told();
    await this.#file?.flush();
    (await this.#holding?.catch(() => undefined))?.release();
  }

  /** What this run spent: the turn's counts less what its earlier runs had spent (N-22). */
  #usage(): Usage {
    const used = this.#budget.used;
    const before = this.#earlier?.usage;
    return before === undefined
      ? { ...used }
      : { calls: used.calls - before.calls, input: used.input - before.input, cacheRead: used.cacheRead - before.cacheRead, cacheWrite: used.cacheWrite - before.cacheWrite, output: used.output - before.output, ...(used.reasoning !== undefined ? { reasoning: used.reasoning - (before.reasoning ?? 0) } : {}) };
  }

  #outcome(ended: Pick<RunOutcome, "status"> & Partial<RunOutcome>): RunOutcome {
    return { released: this.#desk.released, usage: this.#usage(), ...ended };
  }

  #outcomeOf(outcome: AgentOutcome): RunOutcome {
    if (outcome.status === "limit") return this.#outcome({ status: "limit", ...(outcome.limit !== undefined ? { limit: outcome.limit } : {}) });
    if (outcome.status === "stopped") return this.#outcome({ status: "stopped" });
    if (outcome.status === "failed") return this.#outcome({ status: "failed", error: { code: outcome.failure === "model" ? "provider" : "failed", ...(outcome.error !== undefined && outcome.error !== "" ? { detail: outcome.error } : {}), ...(outcome.broke !== undefined ? { broke: outcome.broke } : {}) } });
    return this.#outcome({ status: this.#desk.released ? "released" : "no-reply" });
  }
}
