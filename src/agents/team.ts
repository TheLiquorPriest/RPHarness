// A turn's sub-agents (§13.4, §10.5). `delegate` starts an agent from its definition, with its own
// model and effort, its own tools, its own instruction stack and its own session, on the brief laid
// out by the brief's part with everything it is given in full; it runs to its end, and its last
// message is the call's answer. A sub-agent that asks (`ask_author`) ends its work with the
// question, which comes back through the call that set it going, marked as a question;
// `agent_message` continues it where it stopped, with everything it had, the message its answer.
// Several run at once. Each is an agent of the turn's run: its events carry the call that started
// or continued it, it is counted and shown under its own name, and its writes go through the gate
// the lead's do, as itself.
//
// Code holds a sub-agent to the user's limits on how deep and how many, and to nothing else. Every
// word an agent is told comes from a file: the brief's frame, the question's, and the lines of
// `.prompts/delegation.md`.
import type { AgentRef, ConsentGrant, Environment, JsonValue, LimitHit, Log, ModelLimits, ToolCtx } from "../contract";
import type { AgentDefinition, Fields, Guidance, LinesPart, PromptPart, RuleRun, TemplatePart } from "../files/api";
import { userMessage } from "../harness/prompt";
import type { AgentSettings } from "../harness/settings";
import { type AgentOutcome, AgentRunner, type Budget, type KeepRequest, type LoopToolResult, type ParentCall, type RunnerTexts, type RunTrace, type ToolGate, type Work, type WorkInput, type WorkOptions } from "../loop";
import type { AgentChoice, AgentModel, ModelSource } from "../model/source";
import { answer, type Held, type HeldTool, type Words } from "../tools";
import { attach, joined, type Wanted } from "./attachments";
import type { AskCall, ConsentArgument, DelegateCall, DropCall, MessageCall, TeamWork } from "./tools";

/** The frame every brief is laid out by (`.prompts/delegate-brief.md`). */
const BRIEF_PART = "delegate-brief";
/** How a question comes back to the agent that asked for the work (`.prompts/question.md`). */
const QUESTION_PART = "question";
/** The lines of the team's answers, and how a chat message and a lore entry are laid out in what an agent is given (`.prompts/delegation.md`). */
const LINES_PART = "delegation";
/** The mark on a result that is a sub-agent's question (§10.5), which a rule's condition can name (`marked question`). */
const QUESTION_MARK = "question";

/** What the turn gives its team. What the turn decides after making the team is asked for when it is needed. */
export interface TeamDeps {
  env: Pick<Environment, "files" | "chat" | "lore" | "events" | "log">;
  /** The turn's trace. Every agent of the turn writes through it, so each is counted and shown under its own name; its scope is where they work. */
  trace: RunTrace;
  /** The turn's guidance: definitions, stacks, parts. */
  guidance: Guidance;
  /** Fresh ids: a sub-agent's own session, a consent's record. */
  ids(): string;
  /** The models agents run on. */
  models: ModelSource;
  /** The connection a definition names, found as the lead's is: the model layer's choice, and the name the trace gives it. */
  connection(definition: AgentDefinition): Promise<{ choice: AgentChoice; label: string }>;
  /** The tools an agent whose definition lists `names` holds: the turn's registry, which holds these three tools too. */
  hold(names: readonly string[]): Held;
  /** Tools a sub-agent's definition lists that nobody registered: the turn says so, once in its session. */
  unregistered(definition: string, tools: readonly string[]): void;
  /** What runs around each of an agent's tool calls, made for that agent as the lead's is made for the lead. */
  gate(agent: AgentRef, parent: ParentCall, tools: readonly HeldTool[]): ToolGate;
  /** The texts the turn's runners send a model. */
  texts(): RunnerTexts;
  /** The turn's rules. */
  rules(): RuleRun;
  /** The turn's limits, shared by every agent of it. */
  budget(): Budget;
  /** The user's limits on how deep sub-agents may stand and how many one turn may start: the turn's settings. */
  settings(): AgentSettings;
  /** The most one call takes (the user's `tools.perCall`), which a stretch of the chat an agent is given is held to. */
  perCall(): number;
  /** A sub-agent's work began: the turn stops it with the rest, and its time reaches it. The answer forgets the work once it ends. */
  track(entry: { runner: AgentRunner; work: Work }): () => void;
  /** A sub-agent's model's room, for its window gauge. */
  gauge?(agent: AgentRef, limits: ModelLimits): void;
  /** A progress line, by its name in the progress part (`delegate`, `agents`, `question`), with its fields. */
  progress?(name: string, fields: Fields): void;
  /** A slice of the prompt by its name as written (`prompt:persona`), from the prompt map. Without it, such a name is not found. */
  slice?(ref: string, reader: AgentRef): Promise<string | undefined>;
  /** What keeps a sub-agent's requests, as the user's setting asks (`trace.requests`); none keeps nothing. */
  keep?(agent: AgentRef): KeepRequest | undefined;
}

interface Member {
  ref: AgentRef;
  runner: AgentRunner;
  /** How deep it stands: the lead's own at 1. */
  level: number;
  /** The call its latest work hangs under. */
  parent: ParentCall;
  /** Hears how each stretch of its work that a message set going ended. */
  ended?(outcome: AgentOutcome): void;
}

/** A sub-agent made and ready to start: itself, its first message, what it was given by name, what nobody could give, and its model's room. */
interface Made {
  member: Member;
  first: string;
  given: string[];
  missing: string[];
  limits: ModelLimits;
}

/** What the team reads once a turn, the first time it is asked to do anything. */
interface Loaded {
  brief: TemplatePart | undefined;
  question: TemplatePart | undefined;
  lines: LinesPart | undefined;
  words: Words;
}

/** A stretch of a member's work under way: the turn forgets it when it ends, and the call's stop is let go then. */
interface Begun {
  work: Work;
  untrack: () => void;
  stop: () => void;
}

function template(part: PromptPart | undefined): TemplatePart | undefined {
  return part?.format === "template" ? part : undefined;
}

/** What every text about an agent is filled from: its handle, its definition, and the character it plays. */
function fieldsOf(ref: AgentRef): Fields {
  return { agent: ref.id, definition: ref.definition, ...(ref.plays !== undefined ? { plays: ref.plays } : {}) };
}

/** An answer of one text, or of none when it is empty. */
function said(text: string, extra: Omit<LoopToolResult, "content"> = {}): LoopToolResult {
  return { content: text === "" ? [] : [{ type: "text", text }], ...extra };
}

/**
 * A question as `ask_author` gave it, in the fields the question's part names: the question, and
 * what was looked for before asking as `found`, as a tool's argument and a part's field are each
 * named for their reader (the brief is the part's `task`).
 */
function questionFields(question: JsonValue | undefined): { question: string; found: string } {
  const given = typeof question === "object" && question !== null && !Array.isArray(question) ? question : {};
  const text = given["question"];
  const searched = given["searched"];
  return { question: typeof text === "string" ? text : "", found: typeof searched === "string" ? searched : "" };
}

/**
 * An agent's instructions, made as the lead's opening block is, without the reply contract: the
 * files of its stack's opening (its definition's body filled in), then the guide of each family of
 * tools it holds that has a file of its own (`.tools/<family>.md`).
 */
async function instructionsOf(guidance: Guidance, definition: AgentDefinition, tools: readonly HeldTool[], isTool: (name: string) => boolean, fields: Fields, log: Log): Promise<string> {
  const stack = await guidance.stack(definition.name);
  for (const problem of stack.problems) log.warn("A file of a sub-agent's stack cannot be used.", { agent: definition.name, path: problem.path, problem: problem.message });
  const texts: string[] = [];
  for (const entry of stack.entries) {
    if (entry.where !== "opening" || entry.left !== undefined || entry.text === undefined) continue;
    if (entry.kind !== "definition") {
      texts.push(entry.text);
      continue;
    }
    const rendered = definition.instructions.render(fields);
    if (rendered.missing.length > 0) log.warn("An agent's definition names fields nothing fills.", { agent: definition.name, fields: rendered.missing });
    texts.push(rendered.text);
  }
  for (const family of new Set(tools.map((tool) => tool.family))) {
    if (isTool(family)) continue;
    const guide = template(await guidance.tool(family))?.render().text;
    if (guide !== undefined) texts.push(guide);
  }
  return joined(texts);
}

export class Team implements TeamWork {
  readonly #d: TeamDeps;
  /** Every sub-agent started this turn, by its handle. */
  readonly #members = new Map<string, Member>();
  /** How many of each definition were started, for their handles. */
  readonly #numbers = new Map<string, number>();
  #started = 0;
  #loaded: Promise<Loaded> | undefined;

  constructor(deps: TeamDeps) {
    this.#d = deps;
  }

  async delegate(call: DelegateCall, ctx: ToolCtx): Promise<LoopToolResult> {
    const d = this.#d;
    const loaded = await this.#load();
    const { words } = loaded;
    const level = (this.#members.get(ctx.agent.id)?.level ?? 0) + 1;
    const { depth, agents } = d.settings();
    if (level > depth) return this.#limited(ctx, { limit: "depth", per: "turn", max: depth, value: level }, words("depth", { agent: call.agent, max: depth, value: level }));
    if (agents !== undefined && this.#started >= agents) return this.#limited(ctx, { limit: "agents", per: "turn", max: agents, value: this.#started }, words("agents", { agent: call.agent, max: agents, value: this.#started }));
    // Its place is taken before anything is awaited, so the calls of one step cannot pass the limit
    // together; a call that starts nobody gives it back.
    this.#started += 1;
    let made: Made | LoopToolResult;
    try {
      made = await this.#make(call, ctx, loaded, level);
    } catch (error) {
      this.#started -= 1;
      throw error;
    }
    if (!("member" in made) || ctx.signal.aborted) {
      this.#started -= 1;
      return "member" in made ? said("") : made;
    }
    const { member } = made;
    const fields = fieldsOf(member.ref);
    this.#members.set(member.ref.id, member);
    d.gauge?.(member.ref, made.limits);
    d.progress?.("delegate", fields);
    const working = [...this.#members.values()].filter((other) => other.runner.working).length + 1;
    if (working > 1) d.progress?.("agents", { count: working });
    const work = this.#begin(member, { messages: [userMessage(made.first, d.trace.clock.now())] }, { parent: member.parent, given: made.given }, ctx);
    return this.#end(member, work, ctx, made.missing, loaded);
  }

  /** A sub-agent made from its definition and ready to start, or the answer that says why none can be. */
  async #make(call: DelegateCall, ctx: ToolCtx, loaded: Loaded, level: number): Promise<Made | LoopToolResult> {
    const d = this.#d;
    const definition = await d.guidance.definition(call.agent);
    if (definition === undefined) return answer(loaded.words("no_agent", { agent: call.agent }), true);
    const connection = await d.connection(definition);
    let model: AgentModel;
    try {
      model = await d.models.agentModel(connection.choice);
    } catch (error) {
      // The model layer's words are for whoever runs the host, not for a model.
      d.env.log.warn("A sub-agent has no model to run on.", { agent: definition.name, error: error instanceof Error ? error.message : String(error) });
      return answer(loaded.words("no_model", { agent: definition.name, definition: definition.name }), true);
    }
    const number = (this.#numbers.get(definition.name) ?? 0) + 1;
    this.#numbers.set(definition.name, number);
    const ref: AgentRef = { id: `${definition.name}-${number}`, definition: definition.name, parent: ctx.agent.id, ...(call.plays !== undefined ? { plays: call.plays } : {}) };
    const parent: ParentCall = { agent: ctx.agent.id, run: ctx.run, call: ctx.callId };
    const fields = fieldsOf(ref);
    const held = d.hold(definition.tools);
    if (held.missing.length > 0) d.unregistered(definition.name, held.missing);
    const instructions = await instructionsOf(d.guidance, definition, held.tools, (name) => d.hold([name]).tools.length > 0, fields, d.env.log);
    const wanted: Wanted[] = [...definition.given.map((name) => ({ ref: name, from: "definition" as const })), ...call.attach.map((name) => ({ ref: name, from: "delegate" as const }))];
    const slice = d.slice?.bind(d);
    const given = await attach({ env: d.env, scope: d.trace.scope, lines: loaded.lines, most: d.perCall(), ...(slice !== undefined ? { slice } : {}) }, ref, wanted);
    const attachments = given.blocks.map((block) => ({ name: block.name, text: block.text }));
    // Without the frame, the brief and what it is given go as they are, one after another.
    const brief = loaded.brief?.render({ ...fields, task: call.brief, attachments, ...(call.returns !== undefined ? { returns: call.returns } : {}) }).text ?? joined([call.brief, ...given.blocks.map((block) => block.text)]);
    const rules = d.rules();
    const keep = d.keep?.(ref);
    const runner = new AgentRunner({
      agent: ref,
      trace: d.trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session: d.ids(),
      thinkingLevel: model.thinkingLevel,
      ...(instructions !== "" ? { instructions } : {}),
      tools: held.tools,
      texts: d.texts(),
      limits: definition.limits,
      turn: d.budget(),
      stream: rules.stream(ref),
      runEnd: rules.runEnd,
      gate: d.gate(ref, parent, held.tools),
      ...(keep !== undefined ? { keep } : {}),
    });
    if (runner.leftOut.length > 0) d.env.log.warn("Tools that take an argument named closing, which RPH adds to every tool, are left out.", { agent: definition.name, tools: runner.leftOut });
    return { member: { ref, runner, level, parent }, first: joined([brief]), given: wanted.map((item) => item.ref), missing: given.missing, limits: model.limits };
  }

  async ask(call: AskCall, ctx: ToolCtx): Promise<LoopToolResult> {
    // The run's own first agent has nobody to put a question to: asking would end its run unheard.
    if (!this.#members.has(ctx.agent.id)) return answer((await this.#load()).words("nobody_to_ask", fieldsOf(ctx.agent)), true);
    return { content: [], ask: { question: call.question, searched: call.searched } };
  }

  async message(call: MessageCall, ctx: ToolCtx): Promise<LoopToolResult> {
    const loaded = await this.#load();
    const member = this.#members.get(call.agent);
    // A handle is held by the agent that started it (§10.5, §13.4): no other answers, continues or grants it consent.
    if (member === undefined || member.ref.parent !== ctx.agent.id) return answer(loaded.words("no_handle", { agent: call.agent }), true);
    // Nothing is awaited between this and the start, so two messages to one agent cannot both begin.
    if (member.runner.working) return answer(loaded.words("busy", fieldsOf(member.ref)), true);
    if (ctx.signal.aborted) return said("");
    const work = this.#begin(member, { message: call.message }, { parent: { agent: ctx.agent.id, run: ctx.run, call: ctx.callId } }, ctx);
    if (call.consent !== undefined) await this.#consent(member, call.consent, ctx);
    return this.#end(member, work, ctx, [], loaded);
  }

  /** Drops what an agent the caller started wrote this turn, which the host staged under the turn (§13.4); the host says what that undoes. */
  async drop(call: DropCall, ctx: ToolCtx): Promise<LoopToolResult> {
    const d = this.#d;
    const { words } = await this.#load();
    const member = this.#members.get(call.agent);
    if (member === undefined || member.ref.parent !== ctx.agent.id) return answer(words("no_handle", { agent: call.agent }), true);
    // What it writes while it works would come after the drop.
    if (member.runner.working) return answer(words("busy", fieldsOf(member.ref)), true);
    try {
      await d.env.events.dropStaged(d.trace.scope, member.ref);
    } catch (error) {
      d.env.log.error("The host could not drop a sub-agent's writes.", { agent: member.ref.id, error: error instanceof Error ? error.message : String(error) });
      return answer(words("not_dropped", fieldsOf(member.ref)), true);
    }
    return answer(words("dropped", fieldsOf(member.ref)));
  }

  #load(): Promise<Loaded> {
    this.#loaded ??= (async (): Promise<Loaded> => {
      const { guidance } = this.#d;
      const [brief, question, lines] = await Promise.all([guidance.part(BRIEF_PART), guidance.part(QUESTION_PART), guidance.part(LINES_PART)]);
      const wordLines = lines?.format === "lines" ? lines : undefined;
      return { brief: template(brief), question: template(question), lines: wordLines, words: (name, fields) => wordLines?.line(name, fields) };
    })().catch((error: unknown) => {
      // A read that failed is tried again by the next call.
      this.#loaded = undefined;
      throw error;
    });
    return this.#loaded;
  }

  /** Starts a stretch of a member's work under `parent`'s call: the turn tracks it, and the call's own stop stops it. */
  #begin(member: Member, input: WorkInput, options: WorkOptions & { parent: ParentCall }, ctx: ToolCtx): Begun {
    member.parent = options.parent;
    const work = member.runner.start(input, options);
    const untrack = this.#d.track({ runner: member.runner, work });
    const stop = (): void => work.stop();
    ctx.signal.addEventListener("abort", stop, { once: true });
    return { work, untrack, stop };
  }

  /** Waits for the stretch of work to end, and gives the call its answer. */
  async #end(member: Member, begun: Begun, ctx: ToolCtx, missing: readonly string[], loaded: Loaded): Promise<LoopToolResult> {
    let outcome: AgentOutcome;
    try {
      outcome = await begun.work.done;
    } finally {
      begun.untrack();
      ctx.signal.removeEventListener("abort", begun.stop);
    }
    member.ended?.(outcome);
    if (outcome.status === "asked") this.#d.progress?.("question", fieldsOf(member.ref));
    if (outcome.status === "failed") this.#d.env.log.warn("A sub-agent's work failed.", { agent: member.ref.id, failure: outcome.failure ?? "harness", error: outcome.error ?? "" });
    return this.#result(member.ref, outcome, missing, loaded);
  }

  /**
   * Takes the writer `write_reply` starts into the team (§10.6), as `delegate` takes a sub-agent: one
   * deeper than the agent that called, and counted among the turn's agents, so the user's limits hold
   * for it and for whatever it starts, and it may ask the agent that called, which answers it with
   * `agent_message`. `ended` hears how each later stretch of its work ended. Gives the answer that
   * says why it cannot start, or undefined once it is a member.
   */
  async enlist(ref: AgentRef, runner: AgentRunner, parent: ParentCall, ctx: ToolCtx, ended?: (outcome: AgentOutcome) => void): Promise<LoopToolResult | undefined> {
    const level = (this.#members.get(ctx.agent.id)?.level ?? 0) + 1;
    const { depth, agents } = this.#d.settings();
    // Its place is taken before anything is awaited, as a delegate's is.
    const hit: LimitHit | undefined = level > depth ? { limit: "depth", per: "turn", max: depth, value: level } : agents !== undefined && this.#started >= agents ? { limit: "agents", per: "turn", max: agents, value: this.#started } : undefined;
    if (hit === undefined) {
      this.#started += 1;
      this.#members.set(ref.id, { ref, runner, level, parent, ...(ended !== undefined ? { ended } : {}) });
      return undefined;
    }
    const { words } = await this.#load();
    return this.#limited(ctx, hit, words(hit.limit, { agent: ref.definition, max: hit.max, value: hit.value }));
  }

  /** A member's work that ended on a question, as the answer to the call that started it: the question laid out by its part, and marked (§10.5). */
  async asked(ref: AgentRef, outcome: AgentOutcome): Promise<LoopToolResult> {
    this.#d.progress?.("question", fieldsOf(ref));
    return this.#result(ref, outcome, [], await this.#load());
  }

  /** How a stretch of a sub-agent's work came back: its answer, or its question, or why it ended without one; then each attachment nobody could give. */
  #result(ref: AgentRef, outcome: AgentOutcome, missing: readonly string[], loaded: Loaded): LoopToolResult {
    const { words } = loaded;
    const fields = fieldsOf(ref);
    const reports = missing.flatMap((name) => {
      const line = words("missing", { ...fields, ref: name });
      return line === undefined ? [] : [line];
    });
    const extra = { details: { agent: ref.id, status: outcome.status }, ...(reports.length > 0 ? { reports } : {}) };
    switch (outcome.status) {
      case "asked": {
        const asked = questionFields(outcome.question);
        // Without the question's part, the question and what was looked for go as the agent wrote them.
        const text = loaded.question?.render({ ...fields, ...asked }).text ?? joined([asked.question, asked.found]);
        return said(joined([text]), { marks: [QUESTION_MARK], ...extra });
      }
      case "done":
        return said(joined([words("answered", fields) ?? "", outcome.text]), extra);
      case "limit": {
        const hit = outcome.limit;
        const line = words("limit", { ...fields, ...(hit !== undefined ? { limit: hit.limit, per: hit.per, max: hit.max, value: hit.value } : {}) });
        return said(line ?? "", { error: true, ...extra });
      }
      case "stopped":
        return said(words("stopped", fields) ?? "", { error: true, ...extra });
      case "failed": {
        // Which failed, its model or RPH's own work under it, by name, for the line to say.
        const failure = outcome.failure ?? "harness";
        return said(words("failed", { ...fields, failure, [failure]: true }) ?? "", { error: true, ...extra });
      }
    }
  }

  /** A delegate past the user's limit on how deep or how many: the trace says which limit, and the call is answered in the file's words. */
  #limited(ctx: ToolCtx, hit: LimitHit, line: string | undefined): LoopToolResult {
    this.#d.trace.event(ctx.agent, this.#members.get(ctx.agent.id)?.parent, { kind: "limit", hit });
    return answer(line, true);
  }

  /** The consent given with a message, for the record and the Turn page (§10.5 step 6). */
  async #consent(member: Member, consent: ConsentArgument, ctx: ToolCtx): Promise<void> {
    const d = this.#d;
    const grant: ConsentGrant = {
      id: d.ids(),
      by: ctx.agent,
      to: member.ref,
      via: { kind: "answer", callId: ctx.callId },
      topic: consent.topic,
      ...(consent.bounds !== undefined ? { bounds: consent.bounds } : {}),
      ...(consent.gapCheck !== undefined ? { gapCheck: consent.gapCheck } : {}),
    };
    try {
      await d.env.events.consent(d.trace.scope, grant);
    } catch (error) {
      d.env.log.error("The host could not be told of a consent.", { agent: member.ref.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
