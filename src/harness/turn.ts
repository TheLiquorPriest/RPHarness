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
// `briefing`).
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AGENT_TOOLS, agentDrop, agentMessage, askAuthor, delegate, Team, type TeamWork } from "../agents";
import type { AgentRef, Environment, JsonValue, ModelsApi, Places, PromptNotice, Release, ReleaseForm, ReplyError, ReplySink, RuleFiring, RuleThen, RunOutcome, ToolCtx, TraceRecord, TurnOutcome, TurnRequest } from "../contract";
import { changes, changesText, createFacts, loadGuidance, snapshot } from "../files";
import type { AgentDefinition, Fields, Guidance, LinesPart, OwnFactValues, PromptPart, RuleRun, TemplatePart } from "../files/api";
import { type AgentOutcome, AgentRunner, Budget, type KeepRequest, type LoopTool, type LoopToolResult, type ParentCall, type RunnerTexts, RunTrace, type TextChannel, type Work } from "../loop";
import type { AgentChoice, AgentModel, ModelSource } from "../model/source";
import { heldSentences, KeepAlive, MessageReply, ReplyDesk, type ReplyTags, TagReply } from "../reply";
import { SilentReply } from "../reply/silent";
import type { SessionBook, SessionFile } from "../sessions/book";
import { carriedFields, pathTurns } from "../sessions/carry";
import { answer, fileFind, fileRead, type FileToolsDeps, fileWrite, type OwnTool, Registry, REPLY_FAMILY, replyRelease, type ReplyWork, todo, TodoLists, type ToolText, type Words, writeReply } from "../tools";
import { BASE_TOOLS, baseTools } from "../tools/base";
import { type AgentReach, SEARCH_TOOLS, searchTools, TOOL_USE } from "../tools/search";
import { TurnGate } from "./gate";
import type { LiveHub } from "./live";
import { assistantMessage, promptMessages, promptText, systemMessage, userMessage } from "./prompt";
import { HeldSink, IntentWait } from "./intents";
import { requestPath, sentMessages } from "./requests";
import { memoryAt, type Opening, type Sessions, turnAt, unsaid } from "./sessions";
import { DEFAULT_SETTINGS, effortFor, formFor, readSettings, type Settings } from "./settings";
import type { UsageBook } from "./usage";

/** RPH's own tools, each described by its file in `.tools/`; the sub-agents', the base tools and tool search among them. */
const OWN_TOOLS = ["file_read", "file_find", "file_write", "todo", "write_reply", "reply_release", ...AGENT_TOOLS, ...BASE_TOOLS, ...SEARCH_TOOLS] as const;

/** Where the released reply is kept, inside the turn's `output/` folder (§5.3). */
const RELEASED_FILE = "output/reply.md";

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
}

/** A definition's connection, as its header names it: the choice for the model layer, and the connection's id and name where they are known. */
interface Connection {
  choice: AgentChoice;
  id: string | null;
  name: string | null;
  /** How the trace names it. */
  label: string;
}

function errorWords(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function template(part: PromptPart | undefined): TemplatePart | undefined {
  return part?.format === "template" ? part : undefined;
}

function lines(part: PromptPart | undefined): LinesPart | undefined {
  return part?.format === "lines" ? part : undefined;
}

/** Texts placed one after another in a message: each without the line break its file ends on, the empty ones left out. */
function joined(texts: readonly string[]): string {
  return texts
    .map((text) => text.trimEnd())
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/** The tag names a reply contract's header gives, when it gives both. */
function tagsOf(header: Readonly<Record<string, unknown>>): ReplyTags | undefined {
  const tags = header["tags"];
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) return undefined;
  const { reply, intent } = tags as Record<string, unknown>;
  return typeof reply === "string" && typeof intent === "string" ? { reply, intent } : undefined;
}

/** A tool's file as the tool takes it: its body for the model, and its header's `arguments`. */
function toolTextOf(part: PromptPart | undefined): ToolText | undefined {
  const body = template(part);
  if (body === undefined) return undefined;
  const given = body.header["arguments"];
  const args: Record<string, string> = {};
  if (typeof given === "object" && given !== null && !Array.isArray(given)) {
    for (const [name, text] of Object.entries(given)) if (typeof text === "string") args[name] = text;
  }
  return { description: joined([body.render().text]), arguments: args };
}

/** What the sink is told when the run ends without a reply released. */
function replyError(outcome: RunOutcome): ReplyError {
  if (outcome.status === "limit") return { code: "limit", ...(outcome.limit !== undefined ? { limit: outcome.limit } : {}) };
  if (outcome.status === "stopped") return { code: "stopped" };
  if (outcome.status === "failed") return outcome.error ?? { code: "failed" };
  return { code: "no-reply" };
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
  /** The host taking the intent records: what a tool and the reply wait for, no longer than the user's bound. */
  readonly #intentWait: IntentWait;
  /** The turn's sink, its reply held until the intent records told before it were taken. */
  readonly #held: HeldSink;
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
  /** The session's file, once the turn has its entry in it. */
  #file: SessionFile | undefined;
  /** The session's turns on this turn's path, this one with them: the fact `session.turns`. */
  #sessionTurns = 0;
  /** The definition `write_reply` hands the prose to, as its file names it. */
  #writer: string | undefined;
  #draft: { text: string; by: AgentRef } | undefined;
  #released: { text: string; form: ReleaseForm } | undefined;
  #intentWritten = false;
  #notices = 0;
  #stopped = false;
  #timer: unknown;
  #startedAt = 0;

  constructor(core: TurnCore, req: TurnRequest, sink: ReplySink) {
    this.#c = core;
    this.#req = req;
    this.#sink = sink;
    this.run = req.scope.turn;
    this.scope = req.scope;
    this.#trace = new RunTrace(core.hub.tee(core.env.trace, req.scope), req.scope, this.run, core.env.clock);
    this.#trace.watch((record) => this.#watch(record));
    this.#lead = { id: core.ids(), definition: req.lead };
    this.#intentWait = new IntentWait(core.env.clock, () => this.#settings.intentWaitMs);
    this.#held = new HeldSink(sink, this.#intentWait, (held) => this.#tell(held));
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
      env.log.error("A turn failed in the harness.", { turn: this.run, error: errorWords(error) });
      outcome = this.#outcome({ status: "failed", error: { code: "failed", detail: errorWords(error) } });
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.#timer !== undefined) env.clock.clearTimeout(this.#timer);
    }
    this.#keep?.stop();
    if (!this.#desk.released) this.#held.error(replyError(outcome));
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
      this.#c.book.of(scope),
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
    this.#keep = new KeepAlive({ sink: this.#held, clock: env.clock, silenceMs: settings.silenceMs, still: (fields) => this.#progress?.line("still", fields) });
    this.#keep.start();
    this.#say("started");
    const { time, ...counted } = settings.turn;
    this.#budget = new Budget("turn", counted);
    if (time !== undefined) this.#timer = env.clock.setTimeout(() => this.#outOfTime(time), time);
    if (definition === undefined) return this.#outcome({ status: "failed", error: { code: "failed", detail: `No agent definition named "${req.lead}" is in force for this chat.` } });

    const session = this.#c.sessions.of(scope);
    const facts = createFacts(env.facts, (_scope, agent) => this.#ownFacts(agent));
    // The rules go on from what they remembered where this run starts in the session file, so a swipe starts where the attempt it replaces did, and a continue where its turn left off.
    const memory = memoryAt(session, file.log, from);
    const rules = await guidance.ruleRun({ facts, window: settings.ruleWindow, ...(memory !== undefined ? { memory } : {}) });
    this.#rules = rules;
    for (const problem of rules.problems) env.log.warn("A rule cannot be used.", { path: problem.path, problem: problem.message });

    const ownTexts = new Map<string, ToolText>();
    const ownParts = await Promise.all(OWN_TOOLS.map(async (name) => [name, await guidance.tool(name)] as const));
    for (const [name, part] of ownParts) {
      const text = toolTextOf(part);
      if (text !== undefined) ownTexts.set(name, text);
    }
    const writerPart = template(ownParts.find(([name]) => name === "write_reply")?.[1]);
    const writer = writerPart?.header["writer"];
    this.#writer = typeof writer === "string" ? writer : undefined;
    const team = new Team({
      env,
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
    });
    this.#team = team;
    const registry = new Registry(this.#ownTools(ownTexts, team, guidance), await env.tools.all(scope));
    this.#registry = registry;
    if (registry.shadowed.length > 0) env.log.warn("Host tools that take the name of one of RPH's own are left out.", { tools: registry.shadowed });

    const connection = await this.#connection(definition);
    let opening = session.openings.get(req.lead);
    if (opening === undefined) {
      const opened = await this.#open(guidance, definition, registry, settings, connection, template(contract), template(closing));
      if (typeof opened === "string") return this.#outcome({ status: "failed", error: { code: "failed", detail: opened } });
      opening = opened;
      session.openings.set(req.lead, opening);
    }
    this.#opening = opening;
    this.#texts = {
      continueAfterRule: (fields) => joined([template(goOn)?.render(fields).text ?? ""]),
      ...(opening.closing !== undefined ? { closing: opening.closing } : {}),
      notFound: (fields) => this.#words("not_held", fields),
      invalid: (fields) => this.#words("invalid", fields),
      cutShort: (fields) => this.#words("cut_short", fields),
      failed: (fields) => this.#words("failed", fields),
      unfinished: (fields) => this.#words("unfinished", fields),
    };

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
    const promptNotices = await this.#promptNotices();
    this.#notices = promptNotices.length;
    if (promptNotices.length > 0) this.#trace.event(this.#lead, undefined, { kind: "prompt_notices", notices: promptNotices });

    const at = env.clock.now();
    const messages: AgentMessage[] = [];
    if (opening.given.some((ref) => ref.startsWith("prompt:*"))) {
      const framing = joined([template(frame)?.render().text ?? ""]);
      if (framing !== "") messages.push(systemMessage(framing, at));
      const prompt = promptMessages(req.prompt, model.model, at);
      if (prompt.picturesLeft > 0) env.log.warn("Pictures in the prompt's system or assistant messages cannot be carried; they were left out.", { turn: this.run, pictures: prompt.picturesLeft });
      messages.push(...prompt.messages);
    }
    // What the session carries, from the path before this turn: fixed for the turn, after the prompt, so it never moves the cached front (§10.2).
    const layout = template(carried);
    if (opening.given.includes("session:carry") && layout !== undefined) {
      const record = layout.header["record"];
      const fields = await carriedFields({ carry: req.carry, tree: file.log, from, scope, files: env.files, log: env.log, ...(typeof record === "string" ? { record } : {}) });
      const text = fields === undefined ? "" : joined([layout.render(fields).text]);
      if (text !== "") messages.push(systemMessage(text, at));
    }
    if (opening.given.includes("briefing")) {
      const text = await this.#briefing(guidance, template(briefing), notices, opening, due.map((fired) => fired.text), promptNotices, lines(notices), places, session.withoutIntent.has(turnAt(file.log, begun.parent) ?? ""));
      if (text !== undefined) messages.push(systemMessage(joined([text]), at));
    }
    const unplaced = opening.given.filter((ref) => !ref.startsWith("prompt:*") && ref !== "session:carry" && ref !== "briefing");
    if (unplaced.length > 0) env.log.info("Things the lead is given by name that this harness does not place; it is given none of them.", { agent: req.lead, given: unplaced });

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
    const runner = new AgentRunner({
      agent: this.#lead,
      trace: this.#trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session: scope.session,
      thinkingLevel: model.thinkingLevel,
      instructions: opening.text,
      tools: declared,
      texts: this.#texts,
      settings: () => (settings.leadSampling === "preset" && req.presetSampling !== undefined ? { sampling: req.presetSampling } : undefined),
      limits: definition.limits,
      turn: this.#budget,
      stream: streamRules,
      runEnd: rules.runEnd,
      gate: this.#gate(this.#lead, undefined),
      channel,
      ...this.#keeper(this.#lead),
    });
    if (runner.leftOut.length > 0) env.log.warn("Tools that take an argument named closing, which RPH adds to every tool, are left out.", { agent: req.lead, tools: runner.leftOut });
    if (this.#stopped) return this.#outcome({ status: "stopped" });
    const work = runner.start({ messages }, { given: opening.given });
    const entry = { runner, work };
    this.#working.add(entry);
    const outcome = await work.done;
    this.#working.delete(entry);
    session.memories.set(scope.turn, rules.memory());
    return this.#outcomeOf(outcome);
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
    const closingText = joined([closing?.render().text ?? ""]);
    return {
      text: joined(texts),
      snapshot: snapshot(stack),
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

  /** A definition's body, filled in. A lead's body names no fields; one that does gets them empty, and the log says which. */
  #instructions(definition: AgentDefinition): string {
    const rendered = definition.instructions.render();
    if (rendered.missing.length > 0) this.#c.env.log.warn("An agent's definition names fields nothing fills.", { agent: definition.name, fields: rendered.missing });
    return rendered.text;
  }

  /** The briefing (§10.2 block 4), laid out by its template, or undefined when it holds nothing. */
  async #briefing(guidance: Guidance, layout: TemplatePart | undefined, notices: PromptPart | undefined, opening: Opening, due: string[], promptNotices: PromptNotice[], noticeLines: LinesPart | undefined, places: Places, lastWithoutIntent: boolean): Promise<string | undefined> {
    if (layout === undefined) return undefined;
    const req = this.#req;
    const situations = [...new Set([req.kind, ...req.since.map((item) => item.kind)])];
    const now = await guidance.stack(req.lead, { situations });
    const added = joined(now.entries.flatMap((entry) => (entry.where === "briefing" && entry.left === undefined && entry.text !== undefined ? [entry.text] : [])));
    const changed = changesText(changes(opening.snapshot, now), notices).trimEnd();
    const rulesDue = joined(due);
    const noticesText = promptNotices.flatMap((notice) => {
      const line = notice.kind === "unmapped" ? noticeLines?.line("prompt_unmapped") : undefined;
      return line === undefined ? [] : [line];
    });
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
      // The turn this one follows released its reply with no intent record taken before it: the template decides whether to say so.
      ...(lastWithoutIntent ? { last_reply_without_intent: true } : {}),
    };
    const text = layout.render(fields).text;
    return text.trim() === "" ? undefined : text;
  }

  /** What changed in the prompt's shape that this harness can tell: no map for its preset, or text that could not be told apart (§4.8). */
  async #promptNotices(): Promise<PromptNotice[]> {
    const { env } = this.#c;
    const notices: PromptNotice[] = [];
    try {
      if ((await env.prompt.map(this.scope)) === undefined) notices.push({ kind: "unmapped" });
    } catch (error) {
      env.log.warn("The host could not give the prompt map.", { turn: this.run, error: errorWords(error) });
    }
    try {
      if (!(await env.prompt.layout(this.scope)).complete) notices.push({ kind: "incomplete" });
    } catch (error) {
      env.log.warn("The host could not give the prompt's layout.", { turn: this.run, error: errorWords(error) });
    }
    return notices;
  }

  /** The connection a definition names: `default` (or none) is the default connection; any other name is a connection's name or id. The effort is the setting's for that connection where it names one, else the definition's. */
  async #connection(definition: AgentDefinition): Promise<Connection> {
    const named = definition.model === undefined || definition.model === "default" ? null : definition.model;
    const list = await this.#c.connections.list().catch((error: unknown) => {
      this.#c.env.log.warn("The connections could not be listed.", { error: errorWords(error) });
      return undefined;
    });
    const view = named === null ? list?.connections.find((c) => c.id === list.default) : list?.connections.find((c) => c.name === named || c.id === named);
    const id = view?.id ?? named;
    const name = view?.name ?? named;
    const effort = effortFor(this.#settings, { id: id ?? null, name }) ?? definition.effort;
    return {
      choice: { connectionId: named === null ? null : id, model: null, ...(effort !== undefined ? { effort } : {}) },
      id: id ?? null,
      name,
      label: name ?? "default",
    };
  }

  #ownTools(texts: ReadonlyMap<string, ToolText>, team: TeamWork, guidance: Guidance): OwnTool[] {
    const { env } = this.#c;
    const fileDeps: FileToolsDeps = { files: env.files, words: (name, fields) => this.#words(name, fields), texts, written: (_scope, by, done) => this.#written(by, done.path) };
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
      ...baseTools({ env, guidance, texts, ids: () => this.#c.ids(), gapHits: this.#settings.gapHits, perCall: this.#settings.perCall, ...(env.web !== undefined ? { web: env.web } : {}) }),
      ...searchTools({
        reach: { of: (agent) => this.#reach(agent), run: (tool, args, ctx) => this.#runAs(tool, args, ctx) },
        ...(env.switches !== undefined ? { switches: env.switches } : {}),
        guidance,
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
      ready: async () => {
        await this.#intentWait.taken();
      },
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
    const keep: KeepRequest = (call, messages) => {
      if (which === "first" && call !== 1) return undefined;
      const path = requestPath(turn, agent, call);
      const written = env.files.write(this.scope, path, { op: "write", text: JSON.stringify({ messages: sentMessages(messages) }) }, "harness").then((done) => {
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
      "todo.open": { count: open.length, names: open.map((item) => item.text) },
      "prompt.notices": { count: this.#notices },
      "session.turns": { count: this.#sessionTurns },
    };
  }

  /** The lead's intent record, the moment its tag closed (§10.3): to the host, to the trace, and into the turn's folder. Never read. */
  #intent(text: string): void {
    const { env } = this.#c;
    this.#trace.event(this.#lead, undefined, { kind: "intent", text });
    this.#intentWait.told(this.#tell(env.events.intent(this.scope, text)));
    const file = this.#opening?.intentFile;
    const turn = this.#places?.turn;
    if (file === undefined || turn === undefined) return;
    const op = this.#intentWritten ? { op: "append" as const, text: `\n\n${text}` } : { op: "write" as const, text };
    this.#intentWritten = true;
    this.#tell(env.files.write(this.scope, `${turn}${file}`, op, "harness"));
  }

  /** A write went through: on a connection without tags, the lead writes its intent record into the turn's folder itself (§10.7), and the host is told it as it would be from the tag. */
  async #written(by: { id: string }, path: string): Promise<void> {
    const file = this.#opening?.intentFile;
    const turn = this.#places?.turn;
    if (by.id !== this.#lead.id || file === undefined || turn === undefined || path !== `${turn}${file}`) return;
    const read = await this.#c.env.files.read(this.scope, path);
    if (read.status !== "read" || read.text === "") return;
    this.#trace.event(this.#lead, undefined, { kind: "intent", text: read.text });
    this.#intentWait.told(this.#tell(this.#c.env.events.intent(this.scope, read.text)));
  }

  /**
   * The reply went out: the sink is finished, and the reply is kept in the turn's folder. The host
   * and the trace are told once the reply shows, past the wait for the intent record, with whether
   * it went out without one.
   */
  #release(text: string, form: ReleaseForm, by: AgentRef, path?: string): void {
    const { env } = this.#c;
    this.#desk.out();
    this.#released = { text, form };
    this.#keep?.sink.finish({ ...this.#budget.used });
    const parent = this.#parents.get(by.id);
    this.#tell(
      this.#held.out().then((withIntent) => {
        const release: Release = { by, form, ...(path !== undefined ? { path } : {}), length: text.length, ...(withIntent ? {} : { withoutIntent: true as const }) };
        if (!withIntent) this.#c.sessions.of(this.scope).withoutIntent.add(this.scope.turn);
        this.#trace.event(by, parent, { kind: "released", release });
        return env.events.released(this.scope, release);
      }),
    );
    const turn = this.#places?.turn;
    if (turn !== undefined) this.#tell(env.files.write(this.scope, `${turn}${RELEASED_FILE}`, { op: "write", text }, "harness"));
  }

  /** `write_reply`: the writer's one call (§10.6), on the prompt exactly as it was sent, with the preset's sampling and prefill, and the brief. */
  async #write(brief: string, live: boolean, ctx: ToolCtx): Promise<LoopToolResult> {
    const { env } = this.#c;
    const req = this.#req;
    const words = this.#words;
    if (this.#desk.taken) return answer(words("second_reply"), true);
    const writer = this.#writer;
    const guidance = this.#guidance;
    const definition = writer === undefined || guidance === undefined ? undefined : await guidance.definition(writer);
    if (writer === undefined || guidance === undefined || definition === undefined) return answer(words("no_writer", { writer: writer ?? "" }), true);
    const stack = await guidance.stack(writer);
    const instructions = joined(stack.entries.flatMap((entry) => (entry.where !== "opening" || entry.left !== undefined || entry.text === undefined ? [] : [entry.kind === "definition" ? this.#instructions(definition) : entry.text])));
    const connection = await this.#connection(definition);
    const model = await this.#c.models.agentModel(connection.choice);
    const ref: AgentRef = { id: this.#c.ids(), definition: writer, parent: ctx.agent.id };
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
      messages.push(...promptMessages(prompt, model.model, at).messages);
    }
    if (instructions !== "") messages.push(systemMessage(instructions, at));
    messages.push(userMessage(brief, at));
    if (givesPrompt && req.prefill !== undefined && req.prefill !== "") messages.push(assistantMessage(req.prefill, model.model, at));
    const rules = this.#rulesRun();
    const streamRules = rules.stream(ref);
    const second = words("second_reply");
    const shown = live
      ? new MessageReply({
          sink: this.#keep?.sink ?? this.#held,
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
    const held = this.#registry?.hold(definition.tools) ?? { tools: [], missing: [] };
    this.#unregistered("Tools the writer's definition lists are registered by nobody; it holds the rest.", writer, held.missing);
    const runner = new AgentRunner({
      agent: ref,
      trace: this.#trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session: this.scope.session,
      thinkingLevel: model.thinkingLevel,
      tools: held.tools,
      texts: this.#texts,
      settings: () => ({ ...(req.presetSampling !== undefined ? { sampling: req.presetSampling } : {}), ...(req.replyMaxTokens !== undefined ? { maxTokens: req.replyMaxTokens } : {}) }),
      limits: definition.limits,
      turn: this.#budget,
      stream: streamRules,
      runEnd: rules.runEnd,
      gate: this.#gate(ref, parent),
      channel,
      ...this.#keeper(ref),
    });
    if (runner.leftOut.length > 0) env.log.warn("Tools that take an argument named closing, which RPH adds to every tool, are left out.", { agent: writer, tools: runner.leftOut });
    // The writer stands in the team as a sub-agent does: the user's limits hold for it and for what it
    // starts, and its question comes back as this call's answer, for the agent that called to answer.
    const refused = await this.#team?.enlist(ref, runner, parent, ctx, live ? undefined : (ended) => this.#drafted(ref, ended));
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
    const told = promise.catch((error: unknown) => this.#c.env.log.error("The host could not be told what the turn did.", { turn: this.run, error: errorWords(error) }));
    this.#pending.add(told);
    void told.finally(() => this.#pending.delete(told));
    return told;
  }

  async #settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    await this.#file?.settled();
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
