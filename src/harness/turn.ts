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
import { type Api, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import { AGENT_TOOLS, agentDrop, agentMessage, askAuthor, attach, delegate, fieldsOf, Team, type TeamWork } from "../agents";
import type { AgentRef, Environment, JsonObject, JsonValue, LimitHit, ModelsApi, Places, Release, ReleaseForm, ReplyError, ReplySink, RuleFiring, RuleThen, RunOutcome, ToolCtx, TraceRecord, TurnOutcome, TurnRequest, Writer } from "../contract";
import { changes, changesText, createFacts, loadGuidance, snapshot } from "../files";
import type { AgentDefinition, Fields, Guidance, LinesPart, OwnFactValues, PromptPart, RuleRun, TemplatePart } from "../files/api";
import { type AgentOutcome, AgentRunner, Budget, type Judged, type KeepRequest, type LoopTool, type LoopToolResult, type ParentCall, type RunnerTexts, RunTrace, type TextChannel, type Work } from "../loop";
import { DEFAULT_CHARS_PER_TOKEN, promptTokens, tokensOf } from "../model/tokens";
import type { AgentModel, ModelSource } from "../model/source";
import { heldSentences, KeepAlive, MessageReply, ReplyDesk, type ReplyTags, TagReply } from "../reply";
import { SILENCE_MOST_MS } from "../reply/progress";
import { SilentReply } from "../reply/silent";
import type { HeldFile, SessionBook, SessionFile } from "../sessions/book";
import { type CarriedInput, carriedFields, compactionAt, compactionMaterial, materialFields, nextPiece, pathTurns, recordsTokens } from "../sessions/carry";
import { answer, fileFind, fileRead, type FileToolsDeps, fileWrite, type OwnTool, Registry, REPLY_FAMILY, replyRelease, type ReplyWork, todo, TodoLists, type ToolText, type Words, writeReply } from "../tools";
import { BASE_TOOLS, baseTools, skillsIndex } from "../tools/base";
import { type AgentReach, SEARCH_TOOLS, searchTools, TOOL_USE } from "../tools/search";
import { JOB_START, jobStart, type JobsWork } from "../jobs/tool";
import { noticeLines, PROMPT_TOOLS, promptMapWrite, promptSlice, promptTool, promptTurn, promptViews, promptWords, type TurnPrompt, type ViewWrites, writeViews } from "../prompt";
import { TurnGate } from "./gate";
import { Judges } from "./judge";
import type { LiveHub } from "./live";
import { type Connection, connectionOf, lines, runnerTexts, template, toolTextOf } from "./means";
import { assistantMessage, promptMessages, promptText, systemMessage, userMessage } from "./prompt";
import { placed, requestPath, sentMessages } from "./requests";
import { keepMemory, keptOpening, memoryAt, type Opening, type Sessions, unsaid } from "./sessions";
import { DEFAULT_SETTINGS, formFor, readSettings, type Settings } from "./settings";
import type { UsageBook } from "./usage";

/** RPH's own tools, each described by its file in `.tools/`; the sub-agents', the base tools, tool search, `job_start` and the prompt map's among them. */
const OWN_TOOLS = ["file_read", "file_find", "file_write", "todo", "write_reply", "reply_release", ...AGENT_TOOLS, ...BASE_TOOLS, ...SEARCH_TOOLS, JOB_START, ...PROMPT_TOOLS] as const;

/** Where the released reply is kept, inside the turn's `output/` folder (§5.3). */
const RELEASED_FILE = "output/reply.md";

/** How what the lead is given by name beyond its own blocks is laid out (`.prompts/given.md`). */
const GIVEN_PART = "given";
/** How a chat message and a lore entry are laid out in what an agent is given (`.prompts/delegation.md`). */
const DELEGATION_PART = "delegation";

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
}

/** What a compaction at a turn's start works on: the lead's first request as it stands, and where in it the carried block is. */
interface Compacting {
  file: SessionFile;
  carry: CarriedInput;
  /** The carried block's fields as they stand. */
  carried: Fields;
  layout: TemplatePart;
  messages: AgentMessage[];
  carriedAt: number;
  model: AgentModel;
  connection: Connection;
  opening: Opening;
  definition: AgentDefinition;
  declared: LoopTool[];
  rules: RuleRun;
  settings: Settings;
  at: number;
}

function errorWords(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a run ended on its first call, which the provider refused as longer than its model takes:
 * pi-ai's reading of each provider's words for that, on the error the call ended with.
 */
function refusedAsTooLong(outcome: AgentOutcome, model: Model<Api>): boolean {
  if (outcome.status !== "failed" || outcome.failure !== "model" || outcome.usage.calls !== 1 || outcome.error === undefined) return false;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return isContextOverflow({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "error", errorMessage: outcome.error, timestamp: 0 });
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

/** The tag names a reply contract's header gives, when it gives both. */
function tagsOf(header: Readonly<Record<string, unknown>>): ReplyTags | undefined {
  const tags = header["tags"];
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) return undefined;
  const { reply, intent } = tags as Record<string, unknown>;
  return typeof reply === "string" && typeof intent === "string" ? { reply, intent } : undefined;
}

/** What the sink is told when the run ends without a reply released; where it ended with no reply, at a limit or stopped, the lead's last plain text, where it wrote any. */
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
  #settings: Settings = DEFAULT_SETTINGS;
  #keep: KeepAlive | undefined;
  #progress: LinesPart | undefined;
  #words: Words = () => undefined;
  #texts: RunnerTexts = { continueAfterRule: () => "" };
  #guidance: Guidance | undefined;
  #rules: RuleRun | undefined;
  #registry: Registry | undefined;
  /** The turn's sub-agents, the writer among them once `write_reply` starts it. */
  #team: Team | undefined;
  #places: Places | undefined;
  #opening: Opening | undefined;
  /** The turn's prompt, its parts named (§4.8): what `prompt`, a `prompt:` name and the views read. */
  #prompt: TurnPrompt | undefined;
  /** The views of the prompt being written in the turn's folder, alongside the lead's run (§10.1). */
  #views: ViewWrites | undefined;
  /** What the turn's agents reach: the host's, with a files port whose read of a view still being written waits for that write. */
  readonly #env: Environment;
  /** The session's file, once the turn has its entry in it. */
  #file: SessionFile | undefined;
  /** The session's file, held for the turn: let go once the turn's lines are written. */
  #holding: Promise<HeldFile> | undefined;
  /** The session's turns on this turn's path, this one with them: the fact `session.turns`. */
  #sessionTurns = 0;
  #draft: { text: string; by: AgentRef } | undefined;
  #released: { text: string; form: ReleaseForm } | undefined;
  /** The judging model of the `question:` rules, once the turn's rules are loaded. */
  #judges: Judges | undefined;
  #intentWritten = false;
  /** The text of the lead's last message that ended whole with any: what a run with no reply hands the host. */
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
    this.#lead = { id: core.ids(), definition: req.lead };
    const files = core.env.files;
    this.#env = {
      ...core.env,
      files: {
        layers: (scope) => files.layers(scope),
        places: (scope) => files.places(scope),
        find: (scope, query) => files.find(scope, query),
        write: (scope, path, op, by) => {
          this.#writing(path, by);
          return files.write(scope, path, op, by);
        },
        read: async (scope, path, range) => {
          await this.#views?.written(path);
          return files.read(scope, path, range);
        },
      },
    };
  }

  /** Runs the turn to the end of the lead's run. The reply goes to the sink at release, or the sink is told why there is none. */
  async answer(signal: AbortSignal): Promise<TurnOutcome> {
    const { env, hub, usage } = this.#c;
    this.#startedAt = env.clock.now();
    hub.started({ run: this.run, scope: this.scope, what: "turn", agents: [], started: this.#startedAt });
    usage.begin(this.run);
    this.#trace.event(this.#lead, undefined, { kind: "run_started", run: "turn", turn: this.#req.kind, lead: this.#req.lead });
    const onAbort = (): void => this.stop();
    if (signal.aborted) this.#stopped = true;
    else signal.addEventListener("abort", onAbort, { once: true });
    let outcome: RunOutcome;
    try {
      outcome = await this.#play();
    } catch (error) {
      env.log.error("A turn failed in the harness.", { turn: this.scope.turn, run: this.run, error: errorWords(error) });
      outcome = this.#outcome({ status: "failed", error: { code: "failed", detail: errorWords(error) } });
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.#timer !== undefined) env.clock.clearTimeout(this.#timer);
    }
    this.#keep?.stop();
    if (!this.#desk.released) this.#sink.error(replyError(outcome, this.#lastText));
    await this.#settled();
    this.#trace.event(this.#lead, undefined, { kind: "run_ended", outcome });
    await this.#tell(env.events.ended(this.scope, outcome));
    usage.end(this.run);
    hub.ended(this.run);
    return { ...outcome, reply: this.#released?.text ?? "", ...(this.#released !== undefined ? { form: this.#released.form } : {}) };
  }

  /** Stops every agent of the turn where it stands (the signal, or the turn left the path). */
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
    const guidance = loadGuidance(env.files, scope);
    this.#guidance = guidance;
    const [settings, places, definition, progress, notices, toolNotices, frame, contract, briefing, carried, goOn, closing, file] = await Promise.all([
      readSettings(guidance, env.files, scope, env.log),
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
      guidance.tool("closing"),
      (this.#holding = this.#c.book.hold(scope)).then((held) => held.file),
    ]);
    this.#settings = settings;
    this.#places = places;
    // The turn's first entry in the session file: after the session's latest turn when the request names no parent, after no turn when it names none (null), and a swipe after the entry before the turn it replaces (§11).
    // A continue is the same turn, extended (§10.10): a turn the file holds already is not begun again, and its work goes on from the turn's newest entry.
    this.#file = file;
    const continued = req.kind === "continue" ? file.log.turn(scope.turn) : undefined;
    const begun = continued ?? file.add({ type: "turn", parent: file.log.anchor(req.parent), turn: scope.turn, kind: req.kind, lead: req.lead, ...(typeof req.parent === "string" ? { follows: req.parent } : {}) });
    // Where this run's work starts on the path: before the turn, or after what a continued turn did already. What the session carries and what the rules remembered are read there.
    const from = continued === undefined ? begun.parent : (file.log.tip(scope.turn) ?? continued.id);
    this.#sessionTurns = pathTurns(file.log, file.log.tip(scope.turn) ?? begun.id).length;
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
    });
    this.#keep.start();
    this.#say("started");
    this.#budget = new Budget("turn", counted);
    if (time !== undefined) this.#timer = env.clock.setTimeout(() => this.#outOfTime(time), time);
    if (definition === undefined) return this.#outcome({ status: "failed", error: { code: "failed", detail: `No agent definition named "${req.lead}" is in force for this chat.` } });

    const session = this.#c.sessions.of(scope);
    const facts = createFacts(env.facts, (_scope, agent) => this.#ownFacts(agent));
    // The rules go on from what they remembered where this run starts in the session file, or at the turn it follows in the scene before, so a swipe starts where the attempt it replaces did, and a continue where its turn left off.
    const memory = await memoryAt(session, env, scope, file.log, from, req.parent);
    const rules = await guidance.ruleRun({ facts, window: settings.ruleWindow, ...(memory !== undefined ? { memory } : {}) });
    this.#rules = rules;
    for (const problem of rules.problems) env.log.warn("A rule cannot be used.", { path: problem.path, problem: problem.message });

    const ownTexts = new Map<string, ToolText>();
    const ownParts = await Promise.all(OWN_TOOLS.map(async (name) => [name, await guidance.tool(name)] as const));
    for (const [name, part] of ownParts) {
      const text = toolTextOf(part);
      if (text !== undefined) ownTexts.set(name, text);
    }
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
      unregistered: (name, tools) => this.#unregistered("Tools a sub-agent's definition lists are registered by nobody; it holds the rest.", name, tools),
      gate: (agent, parent) => this.#gate(agent, parent),
      texts: () => this.#texts,
      rules: () => this.#rulesRun(),
      questions: () => this.#judges,
      budget: () => this.#budget,
      settings: () => this.#settings.subAgents,
      perCall: () => this.#settings.perCall,
      track: (entry) => {
        this.#working.add(entry);
        return () => this.#working.delete(entry);
      },
      gauge: (agent, limits) => this.#c.usage.gauge(scope, this.run, agent.id, limits.contextWindow?.tokens ?? 0, limits.maxTokens?.tokens ?? 0),
      progress: (name, fields) => this.#say(name, fields),
      keep: (agent) => this.#keeper(agent).keep,
      slice,
    });
    this.#team = team;
    const registry = new Registry(this.#ownTools(ownTexts, team, guidance), await env.tools.all(scope));
    this.#registry = registry;
    if (registry.shadowed.length > 0) env.log.warn("Host tools that take the name of one of RPH's own are left out.", { tools: registry.shadowed });

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
      own: async (agent) => {
        if (agent.id === this.#lead.id) return connection;
        const own = await guidance.definition(agent.definition);
        return own === undefined ? connection : this.#connection(own);
      },
      track: (entry) => {
        this.#working.add(entry);
        return () => this.#working.delete(entry);
      },
      late: (agent, judged) => this.#late(agent, judged),
    });
    this.#judges = judges;
    // The block the session opened with: as memory holds it, or, after a restart or once the session is open again after a close, as its file keeps it. Made afresh, it is kept in the file.
    let opening = session.openings.get(req.lead) ?? keptOpening(file.log, req.lead);
    if (opening === undefined) {
      const opened = await this.#open(guidance, definition, registry, settings, connection, template(contract), template(closing));
      if (typeof opened === "string") return this.#outcome({ status: "failed", error: { code: "failed", detail: opened } });
      opening = opened;
      file.add({ type: "opening", parent: begun.id, lead: req.lead, opening: opening as unknown as JsonObject });
    }
    session.openings.set(req.lead, opening);
    this.#opening = opening;
    this.#texts = runnerTexts(this.#words, template(goOn), opening.closing, settings.schemaShown);

    let model: AgentModel;
    try {
      model = await this.#c.models.agentModel(connection.choice);
    } catch (error) {
      return this.#outcome({ status: "failed", error: { code: "failed", detail: errorWords(error) } });
    }
    this.#c.usage.gauge(scope, this.run, this.#lead.id, model.limits.contextWindow?.tokens ?? 0, model.limits.maxTokens?.tokens ?? 0);
    // The tools as the session declared them when it opened: a tool's file changed since waits for the next session (§6.8).
    const held = registry.hold(opening.tools);
    this.#unregistered("Tools the lead's definition lists are registered by nobody; it holds the rest.", req.lead, held.missing);
    const declared = held.tools.flatMap((tool) => {
      const kept = opening.declared[tool.name];
      return kept === undefined ? [] : [{ ...tool, description: kept.description, parameters: kept.parameters }];
    });

    const due = await rules.turnStart(this.#lead);
    for (const fired of due) if (fired.carried !== true) this.#trace.event(this.#lead, undefined, { kind: "rule_fired", firing: { ...fired.firing, agent: this.#lead, action: "briefing" } });
    // A request that carries no prompt (a run asked for to settle a turn's records, say) leaves the prompt's record as it was: nothing of it is compared, kept or saved, no view of it is written over the turn's, and its prompt tools find none.
    if (req.prompt.length > 0) {
      const { prompt, located } = await promptTurn({ env, scope, messages: req.prompt, parent: req.parent, keep: settings.promptKept });
      this.#prompt = prompt;
      this.#notices = located.notices.length;
      if (located.notices.length > 0) this.#trace.event(this.#lead, undefined, { kind: "prompt_notices", notices: located.notices });
      // The views are written alongside the lead's run, not before its first call; a read of one waits for its write, and the turn's end for them all.
      if (places.turn !== undefined) {
        this.#views = writeViews(env.files, scope, places.turn, promptViews(prompt, guidance, this.#lead, req.leftOut ?? []), env.log);
        this.#tell(this.#views.done);
      }
    }

    const at = env.clock.now();
    const messages: AgentMessage[] = [];
    // A request that carries no prompt (a run that writes nothing into the chat) is given no frame introducing one.
    if (opening.given.some((ref) => ref.startsWith("prompt:*")) && req.prompt.length > 0) {
      const framing = joined([template(frame)?.render().text ?? ""]);
      if (framing !== "") messages.push(placed(systemMessage(framing, at), "frame"));
      const prompt = promptMessages(req.prompt, model.model, at);
      this.#picturesLeft(this.#lead, undefined, prompt.pictures);
      messages.push(...prompt.messages.map((message) => placed(message, "prompt")));
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
      if (text !== "") carriedAt = messages.push(placed(systemMessage(text, at), "session:carry")) - 1;
    }
    if (opening.given.includes("briefing")) {
      const text = await this.#briefing(guidance, template(briefing), notices, opening, due.map((fired) => fired.text), places);
      if (text !== undefined) messages.push(placed(systemMessage(joined([text]), at), "briefing"));
    }
    // Every other name the lead is given, found as a sub-agent's is, after the briefing.
    const named = opening.given.filter((ref) => !ref.startsWith("prompt:*") && ref !== "session:carry" && ref !== "briefing");
    if (named.length > 0) {
      const text = await this.#given(guidance, named, slice);
      if (text !== "") messages.push(placed(systemMessage(text, at), named.join(", ")));
    }
    const compacting: Compacting | undefined = carriedAt !== undefined && carriedNow !== undefined && layout !== undefined ? { file, carry, carried: carriedNow, layout, messages, carriedAt, model, connection, opening, definition, declared, rules, settings, at } : undefined;
    if (compacting !== undefined) await this.#compact(compacting, false);

    const streamRules = rules.stream(this.#lead);
    const holdBack = heldSentences(streamRules, settings.heldSentences);
    const second = this.#words("second_reply");
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
          })
        : new MessageReply({
            sink: this.#keep.sink,
            stream: opening.stream,
            heldSentences: holdBack,
            tailSentences: settings.tailSentences,
            claim: () => this.#desk.claim("message"),
            ...(second !== undefined ? { second } : {}),
            onBegin: () => this.#say("writing"),
            onReleased: (text) => this.#release(text, "message", this.#lead),
          });
    const leadRunner = (): AgentRunner =>
      new AgentRunner({
        agent: this.#lead,
        trace: this.#trace,
        model: model.model,
        streamFn: model.streamFn,
        connection: connection.label,
        session: scope.session,
        thinkingLevel: model.thinkingLevel,
        instructions: opening.text,
        context: messages,
        tools: declared,
        texts: this.#texts,
        settings: () => (settings.leadSampling === "preset" && req.presetSampling !== undefined ? { sampling: req.presetSampling } : undefined),
        limits: definition.limits,
        turn: this.#budget,
        stream: streamRules,
        runEnd: rules.runEnd,
        questions: judges,
        gate: this.#gate(this.#lead, undefined),
        channel,
        ...this.#keeper(this.#lead),
      });
    const leadWork = async (runner: AgentRunner): Promise<AgentOutcome | undefined> => {
      if (this.#ended()) return undefined;
      const work = runner.start({ messages: [] }, { given: opening.given });
      const entry = { runner, work };
      this.#working.add(entry);
      const done = await work.done;
      this.#working.delete(entry);
      return done;
    };
    const runner = leadRunner();
    if (runner.leftOut.length > 0) env.log.warn("Tools that take an argument named closing, which RPH adds to every tool, are left out.", { agent: req.lead, tools: runner.leftOut });
    let outcome = await leadWork(runner);
    // The provider refused the first call as longer than its model takes: that call would not fit after all (§11), so the session is compacted as for one that would not, and the call is made again, once, on what it then carries.
    if (outcome !== undefined && compacting !== undefined && refusedAsTooLong(outcome, model.model) && (await this.#compact(compacting, true))) outcome = await leadWork(leadRunner());
    // Nothing more started: the turn was stopped, or its own time ran out on the way (during a compaction, say), and it ends at that limit.
    if (outcome === undefined) return this.#timeUp !== undefined ? this.#outcome({ status: "limit", limit: this.#timeUp }) : this.#outcome({ status: "stopped" });
    // What the rules remembered is kept once every judgment still running has come in: through the host's store, and in memory only for the turns a later turn can still follow.
    await judges.settled();
    await keepMemory(session, env, scope, rules.memory(), new Set(pathTurns(file.log, file.log.tip(scope.turn) ?? null).map((turn) => turn.entry.turn)));
    return this.#outcomeOf(outcome);
  }

  /**
   * Compacts the session where this run's work starts, before the lead's first call (§11): when that
   * call would not fit its model's window less the reserve, or its provider refused it as too long
   * (`refused`), when the records the records mode carries pass their set size (the fold), or when
   * the host asked. The moment before compaction comes first, when a summary can follow: its rules
   * give the lead a call with their text, on its context as it stands, so it can save what it wants
   * kept. Then a call on the lead's model, written from the compaction part, summarizes the turns the
   * session carries but the newest it keeps: one call, or one a piece where they are more than the
   * model takes. The summary is an entry of the session file, as this turn's work; the turns it
   * stands for stay there. The carried block becomes the summary and the turns after it. Whether a
   * summary was written.
   */
  async #compact(c: Compacting, refused: boolean): Promise<boolean> {
    const { env } = this.#c;
    const { file, carry, messages, model, opening, declared, settings } = c;
    const window = model.limits.contextWindow?.tokens ?? 0;
    // The model layer's own estimate of a request, before a provider has counted it.
    const sent = (): number => tokensOf(opening.text, DEFAULT_CHARS_PER_TOKEN) + tokensOf(JSON.stringify(declared.map(({ name, description, parameters }) => ({ name, description, parameters }))), DEFAULT_CHARS_PER_TOKEN) + promptTokens(messages, DEFAULT_CHARS_PER_TOKEN);
    const before = sent();
    const asked = file.log.asked !== undefined;
    const tight = refused || (window > 0 && before > window - settings.compaction.reserve);
    const folding = recordsTokens(c.carried, DEFAULT_CHARS_PER_TOKEN) > settings.compaction.records;
    if (this.#ended() || (!asked && !tight && !folding)) return false;
    const current = file.log.turn(this.scope.turn);
    // The mode "nothing" carries only what the session opened with, which no summary makes smaller.
    const plan = current === undefined || carry.carry === "nothing" ? undefined : compactionAt(file.log, carry.from, current, settings.compaction.keepTurns, carry.compacted);
    if (current === undefined || plan === undefined) {
      if (refused) env.log.warn("The provider refused the lead's first call as too long, and its session has no earlier turn left to summarize.", { turn: this.scope.turn, run: this.run, tokens: before, window });
      else if (tight) env.log.warn("The lead's first call would not fit its model's window less the reserve, and its session has no earlier turn left to summarize; the call goes out as it is.", { turn: this.scope.turn, run: this.run, tokens: before, window, reserve: settings.compaction.reserve });
      return false;
    }

    // What the summary is written from, first: with no instructions or nothing to summarize, no summary can follow, and the moment before compaction does not come.
    const part = template(await this.#guidance?.part("compaction"));
    const instructions = joined([part?.render().text ?? ""]);
    const material = await compactionMaterial(carry, plan.turns);
    if (instructions === "" || material.turns.length === 0) {
      env.log.warn("The session's earlier turns cannot be summarized: the compaction part, or what it would summarize, is empty. They are carried as they were.", { turn: this.scope.turn, run: this.run });
      return false;
    }

    const due = await c.rules.beforeCompaction(this.#lead);
    if (due.length > 0) {
      for (const fired of due) this.#trace.event(this.#lead, undefined, { kind: "rule_fired", firing: { ...fired.firing, agent: this.#lead, action: "call" } });
      const saver = new AgentRunner({
        agent: this.#lead,
        trace: this.#trace,
        model: model.model,
        streamFn: model.streamFn,
        connection: c.connection.label,
        session: this.scope.session,
        thinkingLevel: model.thinkingLevel,
        instructions: opening.text,
        context: messages,
        tools: declared,
        texts: this.#texts,
        settings: () => (settings.leadSampling === "preset" && this.#req.presetSampling !== undefined ? { sampling: this.#req.presetSampling } : undefined),
        // The call the rule gives (§11), bounded by the user's setting, and by the definition's own where that is less: its last call's tools run, and nothing after them.
        limits: { ...c.definition.limits, calls: Math.min(settings.compaction.saveCalls, c.definition.limits?.calls ?? settings.compaction.saveCalls) },
        turn: this.#budget,
        stream: c.rules.stream(this.#lead),
        gate: this.#gate(this.#lead, undefined),
      });
      if (this.#ended()) return false;
      const work = saver.start({ messages: [userMessage(joined(due.map((fired) => fired.text)), c.at)] }, { given: opening.given });
      const entry = { runner: saver, work };
      this.#working.add(entry);
      await work.done;
      this.#working.delete(entry);
      if (this.#ended()) return false;
    }

    // Each summary call is sent no more than the model's window less the room for its answer: what is
    // more than that goes in pieces, oldest first, each piece's summary handed to the next as the
    // summary its turns follow.
    const room = window > settings.compaction.reserve ? window - settings.compaction.reserve : Number.POSITIVE_INFINITY;
    const laid = (summary: string | undefined, turns: readonly JsonObject[]): string => {
      const fields = materialFields(carry.carry, summary, turns);
      return fields === undefined ? "" : joined([c.layout.render(fields).text]);
    };
    let summary = material.summary;
    let left = material.turns;
    while (left.length > 0) {
      const { piece, rest } = nextPiece(left, room, (turns) => tokensOf(instructions, DEFAULT_CHARS_PER_TOKEN) + tokensOf(laid(summary, turns), DEFAULT_CHARS_PER_TOKEN));
      const written = await this.#summarize(c, instructions, laid(summary, piece));
      if (written === undefined) return false;
      summary = written;
      left = rest;
    }
    if (summary === undefined) return false;
    const compacted = file.add({ type: "compacted", parent: file.log.tip(this.scope.turn) ?? current.id, turn: this.scope.turn, summary, kept: plan.kept ?? current.id });
    // What the turn carries from here: a second compaction in the turn starts after this one.
    c.carry = { ...carry, compacted };
    const after = await carriedFields(c.carry);
    c.carried = after ?? {};
    messages[c.carriedAt] = placed(systemMessage(joined([after === undefined ? "" : c.layout.render(after).text]), c.at), "session:carry");
    this.#trace.event(this.#lead, undefined, { kind: "compacted", session: this.scope.session, before, after: sent(), keptTurns: plan.keptTurns });
    return true;
  }

  /**
   * One summary call (§11): the compaction part's instructions, and one piece of what is summarized,
   * in a session of its own for the call, let go when it ends, so it never takes the lead's cached
   * front or thread (§10.2). Its summary, or undefined when the turn stopped or the call gave none,
   * which the log is told.
   */
  async #summarize(c: Compacting, instructions: string, material: string): Promise<string | undefined> {
    if (this.#ended()) return undefined;
    const { model } = c;
    const session = this.#c.ids();
    const summarizer = new AgentRunner({
      agent: { id: this.#c.ids(), definition: this.#req.lead },
      trace: this.#trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: c.connection.label,
      session,
      thinkingLevel: model.thinkingLevel,
      instructions,
      texts: this.#texts,
      turn: this.#budget,
    });
    const work = summarizer.start({ messages: [userMessage(material, c.at)] });
    const entry = { runner: summarizer, work };
    this.#working.add(entry);
    let outcome: AgentOutcome;
    try {
      outcome = await work.done;
    } finally {
      this.#working.delete(entry);
      this.#c.models.ended?.(this.scope.user, session);
    }
    if (this.#ended()) return undefined;
    const summary = outcome.status === "done" ? outcome.text.trim() : "";
    if (summary !== "") return summary;
    this.#c.env.log.warn("The session's earlier turns could not be summarized; they are carried as they were.", { turn: this.scope.turn, run: this.run, status: outcome.status, ...(outcome.error !== undefined ? { error: outcome.error } : {}) });
    return undefined;
  }

  /** Opens the session for its lead: the opening block, which holds still for the session (§5.2, §10.2), or why it cannot be made. */
  async #open(guidance: Guidance, definition: AgentDefinition, registry: Registry, settings: Settings, connection: Connection, contract: TemplatePart | undefined, closing: TemplatePart | undefined): Promise<Opening | string> {
    const { env } = this.#c;
    const stack = await guidance.stack(definition.name);
    for (const problem of stack.problems) env.log.warn("A file of the lead's stack cannot be used.", { path: problem.path, problem: problem.message });
    const texts: string[] = [];
    for (const entry of stack.entries) {
      if (entry.where !== "opening" || entry.left !== undefined || entry.text === undefined) continue;
      texts.push(entry.kind === "definition" ? this.#instructions(definition) : entry.text);
    }
    const { form, stream } = formFor(settings, connection);
    let tags: ReplyTags | undefined;
    let intentFile: string | undefined;
    let contractText = "";
    if (contract !== undefined) {
      tags = tagsOf(contract.header);
      const file = contract.header["intent_file"];
      intentFile = typeof file === "string" && file !== "" ? file : undefined;
      contractText = joined([contract.render({ form: form === "tags" ? { tags: true } : { two_step: true } }).text]);
      texts.push(contractText);
    }
    if (form === "tags" && tags === undefined) return "This connection's replies are marked by tags, and no reply contract in force names them.";
    // The tool guide: the guide of each family of the tools the lead holds, where its file is (`.tools/<family>.md`).
    const held = registry.hold(definition.tools);
    for (const family of new Set(held.tools.map((tool) => tool.family))) {
      if (registry.has(family)) continue;
      const guide = template(await guidance.tool(family))?.render().text;
      if (guide !== undefined) texts.push(guide);
    }
    // The skills in force, for a lead that holds `skill_load`: the list stands as the session opened it, and the briefing says when it no longer does.
    const skills = await skillsIndex(guidance, held.tools);
    if (skills !== "") texts.push(skills);
    const closingText = joined([closing?.render().text ?? ""]);
    return {
      text: joined(texts),
      snapshot: snapshot(stack),
      ...(skills !== "" ? { skills } : {}),
      tools: [...definition.tools],
      given: [...definition.given],
      outOfReach: [...definition.outOfReach],
      declared: Object.fromEntries(held.tools.map((tool) => [tool.name, { description: tool.description, parameters: tool.parameters }])),
      ...(closingText !== undefined && closingText !== "" ? { closing: closingText } : {}),
      form,
      stream,
      ...(tags !== undefined ? { tags } : {}),
      ...(intentFile !== undefined ? { intentFile } : {}),
      ...(contractText !== "" ? { contract: contractText } : {}),
    };
  }

  /** The list of skills as it stands, when it is no longer what the opening block holds: the notices' line for that, then the list. */
  async #skillsChanged(guidance: Guidance, notices: PromptPart | undefined, opening: Opening): Promise<string> {
    const now = await skillsIndex(guidance, this.#registry?.hold(opening.tools).tools ?? []);
    if (now === (opening.skills ?? "")) return "";
    const line = notices?.format === "lines" ? notices.line("skills_changed", now !== "" ? { listed: true } : {}) : undefined;
    return joined([line ?? "", now]);
  }

  /** A definition's body, filled in: with a sub-agent's fields (`fieldsOf`), or with none for the lead, whose opening block holds for the session. A field nothing fills is put in empty, and the log says which. */
  #instructions(definition: AgentDefinition, fields?: Fields): string {
    const rendered = definition.instructions.render(fields);
    if (rendered.missing.length > 0) this.#c.env.log.warn("An agent's definition names fields nothing fills.", { agent: definition.name, fields: rendered.missing });
    return rendered.text;
  }

  /** The briefing (§10.2 block 4), laid out by its template, or undefined when it holds nothing. */
  async #briefing(guidance: Guidance, layout: TemplatePart | undefined, notices: PromptPart | undefined, opening: Opening, due: string[], places: Places): Promise<string | undefined> {
    if (layout === undefined) return undefined;
    const req = this.#req;
    const situations = [...new Set([req.kind, ...req.since.map((item) => item.kind)])];
    const now = await guidance.stack(req.lead, { situations });
    const added = joined(now.entries.flatMap((entry) => (entry.where === "briefing" && entry.left === undefined && entry.text !== undefined ? [entry.text] : [])));
    const changed = joined([changesText(changes(opening.snapshot, now), notices), await this.#skillsChanged(guidance, notices, opening)]);
    const rulesDue = joined(due);
    const noticesText = this.#prompt === undefined ? [] : noticeLines(this.#prompt, await promptWords(guidance));
    // The host's parts by name, and by the same name with "-" as "_", as a template names a field.
    const hostParts: Record<string, string> = {};
    for (const part of req.briefing) {
      hostParts[part.name] = part.text;
      hostParts[part.name.replaceAll("-", "_")] = part.text;
    }
    const fields: Fields = {
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
      // The reply contract again, exactly as the opening block holds it: the template decides whether and where.
      ...(opening.contract !== undefined ? { reply_contract: opening.contract } : {}),
    };
    const text = layout.render(fields).text;
    return text.trim() === "" ? undefined : text;
  }

  /**
   * What the lead's definition names in `given:` beyond the blocks of its own (§5.4, §10.2): files,
   * stretches of the chat, lore, parts of the prompt and the host's views, found as a sub-agent's are
   * and the whole list given to the host to keep; laid out by the given part, with each name nobody
   * could give. Without the part, what was found goes as it is, one after another.
   */
  async #given(guidance: Guidance, refs: readonly string[], slice: (ref: string, reader: AgentRef) => Promise<string | undefined>): Promise<string> {
    const [layout, delegation] = await Promise.all([guidance.part(GIVEN_PART), guidance.part(DELEGATION_PART)]);
    const given = await attach({ env: this.#env, scope: this.scope, lines: lines(delegation), most: this.#settings.perCall, slice }, this.#lead, refs.map((ref) => ({ ref, from: "definition" as const })));
    const part = template(layout);
    if (part === undefined) return joined(given.blocks.map((block) => block.text));
    return joined([part.render({ ...(given.blocks.length > 0 ? { attachments: given.blocks.map((block) => ({ name: block.name, text: block.text })) } : {}), ...(given.missing.length > 0 ? { missing: given.missing } : {}) }).text]);
  }

  /** The connection a definition names: `default` (or none) is the default connection; any other name is a connection's name or id. The effort is the definition's alone. */
  #connection(definition: AgentDefinition): Promise<Connection> {
    return connectionOf(this.#c.connections, this.scope, definition, this.#c.env.log);
  }

  #ownTools(texts: ReadonlyMap<string, ToolText>, team: TeamWork, guidance: Guidance): OwnTool[] {
    // The agents' tools read through the turn's files, so a view still being written is waited for.
    const env = this.#env;
    const fileDeps: FileToolsDeps = { files: env.files, words: (name, fields) => this.#words(name, fields), texts, most: this.#settings.perCall, written: (_scope, by, done) => this.#written(by, done.path) };
    const work: ReplyWork = { write: (brief, live, ctx) => this.#write(brief, live, ctx), release: (path, ctx) => this.#releaseReply(path, ctx) };
    return [
      fileRead(fileDeps),
      fileFind(fileDeps),
      fileWrite(fileDeps),
      todo({ lists: this.#todos, words: (name, fields) => this.#words(name, fields), text: texts.get("todo"), changed: (agent, items) => this.#trace.event(agent, this.#parents.get(agent.id), { kind: "todo", items: [...items] }) }),
      writeReply(work, texts.get("write_reply")),
      replyRelease(work, texts.get("reply_release")),
      delegate(team, texts.get("delegate")),
      askAuthor(team, texts.get("ask_author")),
      agentMessage(team, texts.get("agent_message")),
      agentDrop(team, texts.get("agent_drop")),
      jobStart(this.#c.jobs, texts.get(JOB_START), this.#settings.jobs.perRun),
      ...baseTools({ env, guidance, texts, ids: () => this.#c.ids(), gapHits: this.#settings.gapHits, perCall: this.#settings.perCall, ...(env.web !== undefined ? { web: env.web } : {}) }),
      promptTool({ prompt: async () => this.#prompt, guidance, texts, env }),
      promptMapWrite({ prompt: async () => this.#prompt, guidance, texts, env, signatureHead: this.#settings.signatureHead }),
      ...searchTools({
        reach: { of: (agent) => this.#reach(agent), run: (tool, args, ctx) => this.#runAs(tool, args, ctx) },
        ...(env.switches !== undefined ? { switches: env.switches } : {}),
        guidance,
        schemaShown: this.#settings.schemaShown,
        notices: (name, fields) => this.#words(name, fields),
        texts,
        hits: this.#settings.searchHits,
        // `tool_use` carries the call of the tool it found, which the agent's runner runs as itself.
      }).map((tool) => (tool.name === TOOL_USE ? { ...tool, carrier: true } : tool)),
    ];
  }

  /**
   * What an agent may reach by searching (§6.8): every tool registered but RPH's reply tools, the
   * tools its requests carry, and the families its definition keeps out of reach; the lead's as its
   * opening block fixed them for the session. A reply tool is reached only through an agent's own
   * list: who may release the turn's one reply is the definitions' to say (§10.6, Appendix C).
   */
  async #reach(agent: AgentRef): Promise<AgentReach> {
    const opening = this.#opening;
    const lead = agent.id === this.#lead.id ? opening : undefined;
    const definition = lead === undefined ? await this.#guidance?.definition(agent.definition) : undefined;
    const fixed = lead?.tools ?? definition?.tools ?? [];
    const outOfReach = lead?.outOfReach ?? definition?.outOfReach ?? [];
    const tools = (this.#registry?.all() ?? []).filter((tool) => tool.from !== "rph" || tool.family !== REPLY_FAMILY || fixed.includes(tool.name));
    return { tools, fixed, outOfReach };
  }

  /** A tool found by `tool_use`, run as itself by the runner of the agent whose call carries it. */
  #runAs(tool: LoopTool, args: JsonValue, ctx: ToolCtx): Promise<LoopToolResult> {
    for (const { runner } of this.#working) if (runner.agent.id === ctx.agent.id) return runner.runAs(tool, args, ctx);
    // Every agent's work is tracked from its start, before it can call anything: a call from any other runs nothing.
    this.#c.env.log.error("A tool found by tool_use was called by an agent the turn has no work of.", { agent: ctx.agent.id, tool: tool.name });
    return Promise.resolve({ content: [], error: true });
  }

  #gate(agent: AgentRef, parent: ParentCall | undefined): TurnGate {
    const { env } = this.#c;
    return new TurnGate({
      scope: this.scope,
      agent,
      ...(parent !== undefined ? { parent } : {}),
      trace: this.#trace,
      clock: env.clock,
      files: env.files,
      ...(env.approvals !== undefined ? { approvals: env.approvals } : {}),
      ...(env.switches !== undefined ? { switches: env.switches } : {}),
      places: this.#places ?? { notes: "", session: "", writable: [] },
      rules: this.#rulesRun(),
      words: (name, fields) => this.#words(name, fields),
      // Every tool the agent may reach, so a tool found by `tool_use` is permitted and ruled on by its own tier and lane.
      tools: new Map((this.#registry?.all() ?? []).map((tool) => [tool.name, tool])),
      clipChars: this.#settings.clipChars,
    });
  }

  #rulesRun(): RuleRun {
    if (this.#rules === undefined) throw new Error("The turn's rules were asked for before they were loaded.");
    return this.#rules;
  }

  /** Tools an agent's definition lists that nobody registered: the log is told once in the session, when each is first found, and not on every turn. */
  #unregistered(message: string, definition: string, missing: readonly string[]): void {
    if (missing.length === 0) return;
    const fresh = unsaid(this.#c.sessions.of(this.scope), definition, missing);
    if (fresh.length > 0) this.#c.env.log.warn(message, { agent: definition, tools: fresh });
  }

  /** Keeps what an agent's calls are sent, as `trace.requests` names them: each call's messages, in order, as role and text, in the turn's folder beside the transcripts. */
  #keeper(agent: AgentRef): { keep?: KeepRequest } {
    const which = this.#settings.requests;
    const turn = this.#places?.turn;
    if (which === "none" || turn === undefined) return {};
    const { env } = this.#c;
    const keep: KeepRequest = (call, messages, opening) => {
      if (which === "first" && call !== 1) return undefined;
      const path = requestPath(turn, agent, call);
      const written = env.files.write(this.scope, path, { op: "write", text: JSON.stringify({ messages: sentMessages(messages, opening) }) }, "harness").then((done) => {
        if (done.status !== "written") env.log.warn("What a model call was sent could not be kept.", { agent: agent.id, call, path, status: done.status });
      });
      this.#tell(written);
      return path;
    };
    return { keep };
  }

  /** RPH's own facts for an agent, now (§5.4 "Facts"). */
  #ownFacts(agent: AgentRef): OwnFactValues {
    const open = this.#todos.get(agent.id).filter((item) => !item.done);
    return {
      "reply.released": { count: this.#desk.released ? 1 : 0 },
      // What the request says (§10.7) less what was released: a fact for the rules, which changes nothing of how a run ends.
      "reply.owed": { count: this.#req.owesReply !== false && !this.#desk.released ? 1 : 0 },
      "todo.open": { count: open.length, names: open.map((item) => item.text) },
      "prompt.notices": { count: this.#notices },
      "session.turns": { count: this.#sessionTurns },
    };
  }

  /**
   * Pictures of the prompt an agent's request cannot carry: pi's system and assistant messages hold
   * text alone (§10.2). Which message held them and how many are the host's to hear, by the trace,
   * and to word for the agent if it will; RPH says nothing of them to any agent.
   */
  #picturesLeft(agent: AgentRef, parent: ParentCall | undefined, pictures: readonly { message: number; count: number }[]): void {
    if (pictures.length === 0) return;
    this.#trace.event(agent, parent, { kind: "prompt_notices", notices: [], pictures: [...pictures] });
    this.#c.env.log.warn("Pictures in the prompt's system or assistant messages cannot be carried; they were left out.", { turn: this.scope.turn, run: this.run, agent: agent.id, pictures: pictures.reduce((sum, left) => sum + left.count, 0) });
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
    const stack = await guidance.stack(writer);
    const held = this.#registry?.hold(definition.tools) ?? { tools: [], missing: [] };
    const instructions = joined([...stack.entries.flatMap((entry) => (entry.where !== "opening" || entry.left !== undefined || entry.text === undefined ? [] : [entry.kind === "definition" ? this.#instructions(definition, fieldsOf(ref)) : entry.text])), await skillsIndex(guidance, held.tools)]);
    const connection = await this.#connection(definition);
    const model = await this.#c.models.agentModel(connection.choice);
    const parent: ParentCall = { agent: ctx.agent.id, run: this.run, call: ctx.callId };
    this.#parents.set(ref.id, parent);
    this.#c.usage.gauge(this.scope, this.run, ref.id, model.limits.contextWindow?.tokens ?? 0, model.limits.maxTokens?.tokens ?? 0);
    const at = env.clock.now();
    const messages: AgentMessage[] = [];
    const givesPrompt = definition.given.some((given) => given.startsWith("prompt:*"));
    if (givesPrompt) {
      // A prefilled start is the prompt's last message; it is kept for the very end, where the writer goes on from it.
      const last = req.prompt.at(-1);
      const prompt = req.prefill !== undefined && last?.role === "assistant" && promptText(last) === req.prefill ? req.prompt.slice(0, -1) : req.prompt;
      const converted = promptMessages(prompt, model.model, at);
      this.#picturesLeft(ref, parent, converted.pictures);
      messages.push(...converted.messages.map((message) => placed(message, "prompt")));
    }
    if (instructions !== "") messages.push(placed(systemMessage(instructions, at), "opening"));
    messages.push(placed(userMessage(brief, at), "brief"));
    if (givesPrompt && req.prefill !== undefined && req.prefill !== "") messages.push(placed(assistantMessage(req.prefill, model.model, at), "prompt"));
    const rules = this.#rulesRun();
    const streamRules = rules.stream(ref);
    const second = words("second_reply");
    const shown = live
      ? new MessageReply({
          sink: this.#keep?.sink ?? this.#sink,
          stream: true,
          heldSentences: heldSentences(streamRules, this.#settings.heldSentences),
          tailSentences: this.#settings.tailSentences,
          claim: () => this.#desk.claim("narrator-live"),
          ...(second !== undefined ? { second } : {}),
          onBegin: () => this.#say("writing"),
          onReleased: (text) => this.#release(text, "narrator-live", ref),
        })
      : undefined;
    // A draft shows nothing, and the rules on the reply look at it as it is written all the same.
    const channel: TextChannel = shown ?? new SilentReply();
    if (!live) this.#say("writing");
    this.#unregistered("Tools the writer's definition lists are registered by nobody; it holds the rest.", writer, held.missing);
    const runner = new AgentRunner({
      agent: ref,
      trace: this.#trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session,
      thinkingLevel: model.thinkingLevel,
      tools: held.tools,
      texts: this.#texts,
      settings: () => ({ ...(req.presetSampling !== undefined ? { sampling: req.presetSampling } : {}), ...(req.replyMaxTokens !== undefined ? { maxTokens: req.replyMaxTokens } : {}) }),
      limits: definition.limits,
      turn: this.#budget,
      stream: streamRules,
      runEnd: rules.runEnd,
      ...(this.#judges !== undefined ? { questions: this.#judges } : {}),
      gate: this.#gate(ref, parent),
      channel,
      ...this.#keeper(ref),
    });
    if (runner.leftOut.length > 0) env.log.warn("Tools that take an argument named closing, which RPH adds to every tool, are left out.", { agent: writer, tools: runner.leftOut });
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
    const work = runner.start({ messages }, { parent, given: definition.given });
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
    const failedWords = { writer, ...(outcome.status === "failed" || outcome.status === "limit" || outcome.status === "stopped" ? { [outcome.status]: true } : {}) };
    if (shown !== undefined) return shown.released ? { content: [{ type: "text", text: shown.shown }] } : answer(words("not_written", failedWords), true);
    if (outcome.status !== "done" || outcome.text.trim() === "") return answer(words("not_written", failedWords), true);
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
      if (!this.#desk.claim("file")) return answer(words("second_reply"), true);
      this.#keep?.sink.content(read.text);
      this.#release(read.text, "file", ctx.agent, read.path);
      return answer(words("released"));
    }
    const draft = this.#draft;
    if (draft === undefined) return answer(words("no_draft"), true);
    if (!this.#desk.claim("narrator")) return answer(words("second_reply"), true);
    this.#keep?.sink.content(draft.text);
    this.#release(draft.text, "narrator", draft.by);
    return answer(words("released"));
  }

  /** A progress line (§10.7), from the progress part, while the reply is still to come; the setting may keep all but the silence line back. */
  #say(name: string, fields?: Fields): void {
    if (this.#desk.released || this.#keep === undefined || this.#settings.progress === "least") return;
    const line = this.#progress?.line(name, fields);
    if (line !== undefined) this.#keep.sink.progress(line);
  }

  /** The turn's own time ran out: every agent ends where it stands, at that limit. */
  #outOfTime(max: number): void {
    const hit = { limit: "time" as const, per: "turn" as const, max, value: this.#c.env.clock.now() - this.#startedAt };
    this.#timeUp = hit;
    for (const { runner } of this.#working) runner.limit(hit);
  }

  /** Every record of the run: the usage, the lead's entries in the session file, progress lines, and what each fired rule's agent did next. */
  #watch(record: TraceRecord): void {
    this.#c.usage.record(record);
    this.#record(record);
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
      case "call_ended": {
        if (event.stop === "cut") return;
        if (agent === this.#lead.id && event.error === undefined && event.text.trim() !== "") this.#lastText = event.text;
        const then: RuleThen | undefined = event.toolCalls.length > 0 ? { did: "called", tools: event.toolCalls.map((call) => call.name) } : event.text !== "" ? { did: "wrote" } : undefined;
        if (then !== undefined) this.#then(agent, (firing) => event.call > firing.call, then);
        return;
      }
      case "released":
        this.#then(agent, (firing) => (this.#calls.get(agent) ?? 0) > firing.call, { did: "released" });
        return;
      case "agent_ended":
        this.#then(agent, () => true, { did: "ended" });
        return;
      default:
        return;
    }
  }

  /** The lead's work, into the session file as it happens (§11): its intent records, what it wrote in each call, its calls and what came back. Never its thinking. */
  #record(record: TraceRecord): void {
    const file = this.#file;
    if (file === undefined || record.agent.id !== this.#lead.id) return;
    const turn = this.scope.turn;
    const parent = file.log.tip(turn) ?? null;
    const { event } = record;
    switch (event.kind) {
      case "intent":
        file.add({ type: "intent", parent, turn, text: event.text });
        return;
      case "call_ended":
        file.add({ type: "message", parent, turn, call: event.call, text: event.text, stop: event.stop, ...(event.error !== undefined ? { error: event.error } : {}) });
        return;
      case "tool_started":
        file.add({ type: "call", parent, turn, callId: event.callId, tool: event.tool, args: event.args, ...(event.closing ? { closing: true as const } : {}), ...(event.via !== undefined ? { via: event.via } : {}) });
        return;
      case "tool_ended": {
        const { result } = event;
        const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
        file.add({ type: "result", parent, turn, callId: event.callId, tool: event.tool, text, ...(result.reports !== undefined && result.reports.length > 0 ? { reports: result.reports } : {}), ...(result.error === true ? { error: true as const } : {}) });
        return;
      }
      default:
        return;
    }
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

  async #settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    await this.#file?.settled();
    (await this.#holding?.catch(() => undefined))?.release();
  }

  #outcome(ended: Pick<RunOutcome, "status"> & Partial<RunOutcome>): RunOutcome {
    return { released: this.#desk.released, usage: { ...this.#budget.used }, ...ended };
  }

  #outcomeOf(outcome: AgentOutcome): RunOutcome {
    if (outcome.status === "limit") return this.#outcome({ status: "limit", ...(outcome.limit !== undefined ? { limit: outcome.limit } : {}) });
    if (outcome.status === "stopped") return this.#outcome({ status: "stopped" });
    if (outcome.status === "failed") return this.#outcome({ status: "failed", error: { code: outcome.failure === "model" ? "provider" : "failed", ...(outcome.error !== undefined && outcome.error !== "" ? { detail: outcome.error } : {}) } });
    return this.#outcome({ status: this.#desk.released ? "released" : "no-reply" });
  }
}
