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
// Code holds a sub-agent to the user's limits on how deep, how many and how many at once (one past
// it waits for a place), and to its definition's count of messages after its first answer, and to
// nothing else. Every word an agent is told comes from a file: the brief's frame, the question's,
// the lines of `.prompts/delegation.md`, and a message past its count in `.prompts/tool-notices.md`.
import type { AgentRef, BodyFields, ConsentGrant, Environment, JsonValue, LimitHit, Log, ModelLimits, ToolCtx } from "../contract";
import { loadGuidance } from "../files";
import type { AgentDefinition, Fields, Guidance, LinesPart, PromptPart, RuleRun, TemplatePart } from "../files/api";
import { userMessage } from "../harness/prompt";
import { placed } from "../harness/requests";
import type { AgentSettings } from "../harness/settings";
import { type AgentOutcome, AgentRunner, type Budget, type CallTerms, type KeepRequest, type LoopToolResult, type ParentCall, type QuestionRules, type RunnerOptions, type RunnerTexts, type RunTrace, type ToolGate, type Work, type WorkInput, type WorkOptions } from "../loop";
import { PlaceLine } from "../loop/line";
import { type CompactFacts, Compactor, saveBeforeCompaction } from "../sessions/compact";
import { tokensOf } from "../model/tokens";
import type { AgentModel, ModelSource, UserChoice } from "../model/source";
import { answer, type Held, type HeldTool, type Words } from "../tools";
import { changedText, openingOf, pinsOf } from "../harness/opening";
import { attach, joined, type Wanted } from "./attachments";
import type { AskCall, ConsentArgument, DelegateCall, DropCall, MessageCall, TeamWork } from "./tools";

/** The frame every brief is laid out by (`.prompts/delegate-brief.md`). */
const BRIEF_PART = "delegate-brief";
/** The frame of the brief of a job the user started, whose agent works for nobody above it, in no turn (`.prompts/job-brief.md`). */
const JOB_BRIEF_PART = "job-brief";
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
  connection(definition: AgentDefinition): Promise<{ choice: UserChoice; label: string }>;
  /** The tools an agent whose definition lists `names` holds: the turn's registry, which holds these three tools too. */
  hold(names: readonly string[]): Held;
  /** Tools a sub-agent's definition lists that nobody registered: the turn says so, once in its session. */
  unregistered(definition: string, tools: readonly string[]): void;
  /** What runs around each of an agent's tool calls, made for that agent as the lead's is made for the lead; `parent` is the call its work hangs under, none for the first agent of a run the user started. */
  gate(agent: AgentRef, parent: ParentCall | undefined, tools: readonly HeldTool[]): ToolGate;
  /** The texts the turn's runners send a model. */
  texts(): RunnerTexts;
  /** The turn's rules. */
  rules(): RuleRun;
  /** The `question:` rules' judging model, which every agent of the run is asked about; none asks nothing. */
  questions?(): QuestionRules | undefined;
  /** The turn's limits, shared by every agent of it. */
  budget(): Budget;
  /** The user's limits on how deep sub-agents may stand, how many the run may start and how many may work at once: the turn's settings, or the job's (`job`), whose count is its own. */
  settings(): AgentSettings;
  /** The most one call takes (the user's `tools.perCall`), which a stretch of the chat an agent is given is held to. */
  perCall(): number;
  /** What every model call of an agent of that definition is made on: the estimate's ratio, the answer's floor, its own sampling. */
  terms(definition: string): CallTerms;
  /** A sub-agent's work began: the turn stops it with the rest, and its time reaches it. The answer forgets the work once it ends. */
  track(entry: { runner: AgentRunner; work: Work }): () => void;
  /** A sub-agent's model's room, for its window gauge. */
  gauge?(agent: AgentRef, limits: ModelLimits): void;
  /** A progress line, by its name in the progress part (`delegate`, `agents`, `question`), with its fields. */
  progress?(name: string, fields: Fields): void;
  /** A slice of the prompt by its name as written (`prompt:persona`), from the prompt map. Without it, such a name is not found. */
  slice?(ref: string, reader: AgentRef): Promise<string | undefined>;
  /** What keeps a sub-agent's requests, as the user's setting asks (`trace.requests`); `save`, its save call's at the moment before compaction; none keeps nothing. */
  keep?(agent: AgentRef, kind?: "call" | "save"): KeepRequest | undefined;
  /** The run's compaction settings (§11): each agent the team makes is compacted at any call that would not fit, as the lead is. None: its requests go out as set. */
  compaction?(): { reserve: number; overflowTries: number; keepRecent: number; saveCalls: number };
  /** An agent the team made is a session of its own (§13.4): a sub-agent (`agent`), or a job's first agent (`job`); `by` the call that started it, none for a job the owner started. None: no file is kept. */
  session?(agent: AgentRef, kind: "agent" | "job", by: ParentCall | undefined): void;
  /** A summary of such an agent's own older calls (§11), kept in its session's file as its run's compaction. */
  compacted?(agent: AgentRef, summary: string, facts: CompactFacts): void;
  /** The job this team's run is, when it is one: every agent the team makes carries it (`AgentRef.job`), so the host keeps their writes as the job's. */
  job?: string;
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
  /** Its definition's count of messages after its first answer (`limits.messages`); absent, none. */
  most?: number;
  /** The messages it was sent after its first answer. */
  messages: number;
  /** A message to it waits for a place: another is answered as one to an agent at work. */
  waiting: boolean;
}

/** A sub-agent made and ready to start, its brief its runner's fixed context: itself, what it was given by name, what nobody could give, and its model's room. */
interface Made {
  ref: AgentRef;
  runner: AgentRunner;
  given: string[];
  missing: string[];
  /** Its definition's count of messages after its first answer. */
  most?: number;
  limits: ModelLimits;
}

/** Who an agent is made for: the agent whose call starts it, and the call its work hangs under; neither for a job the user started. */
interface Origin {
  agent?: string;
  parent?: ParentCall;
}

/** The first agent of a run of its own, made and ready to start (`Team.first`), its brief its runner's fixed context. */
export interface FirstAgent {
  ref: AgentRef;
  runner: AgentRunner;
  /** What it was given by name, and what of it nobody could give. */
  given: string[];
  missing: string[];
}

/** What the team reads once a turn, the first time it is asked to do anything. */
interface Loaded {
  brief: TemplatePart | undefined;
  jobBrief: TemplatePart | undefined;
  question: TemplatePart | undefined;
  lines: LinesPart | undefined;
  words: Words;
}

/** A stretch of a member's work under way: the turn forgets it when it ends, and the call's stop is let go then. */
interface Begun {
  work: Work;
  untrack: () => void;
  stop: () => void;
  /** Gives its place back (`limits.turn.agentsAtOnce`). */
  free: () => void;
}

function template(part: PromptPart | undefined): TemplatePart | undefined {
  return part?.format === "template" ? part : undefined;
}

/** What every text about an agent is filled from, its body among them: the contract's `BodyFields`, its handle, its definition, and the character it plays. */
export function fieldsOf(ref: AgentRef): Fields {
  const fields: BodyFields = { agent: ref.id, definition: ref.definition, ...(ref.plays !== undefined ? { plays: ref.plays } : {}) };
  return { ...fields };
}

/** An answer of one text, or of none when it is empty. */
function said(text: string, extra: Omit<LoopToolResult, "content"> = {}): LoopToolResult {
  return { content: text === "" ? [] : [{ type: "text", text }], ...extra };
}

/**
 * A question as `ask_author` gave it, in the fields the question's part names: the question, and
 * what was looked for before asking as `searched`, under the name the tool's argument has (the brief
 * is the part's `task`).
 */
function questionFields(question: JsonValue | undefined): { question: string; searched: string } {
  const given = typeof question === "object" && question !== null && !Array.isArray(question) ? question : {};
  const text = given["question"];
  const searched = given["searched"];
  return { question: typeof text === "string" ? text : "", searched: typeof searched === "string" ? searched : "" };
}

export class Team implements TeamWork {
  readonly #d: TeamDeps;
  /** Every sub-agent started this turn, by its handle. */
  readonly #members = new Map<string, Member>();
  /** How many of each definition were started, for their handles. */
  readonly #numbers = new Map<string, number>();
  #started = 0;
  #loaded: Promise<Loaded> | undefined;
  /** Where a sub-agent's work waits for a place past the sub-agents at once, made at its first use. */
  #line: PlaceLine | undefined;

  constructor(deps: TeamDeps) {
    this.#d = deps;
  }

  async delegate(call: DelegateCall, ctx: ToolCtx): Promise<LoopToolResult> {
    const d = this.#d;
    const loaded = await this.#load();
    const { words } = loaded;
    const level = (this.#members.get(ctx.agent.id)?.level ?? 0) + 1;
    const { depth, agents } = d.settings();
    const per = d.job !== undefined ? "job" : "turn";
    if (level > depth) return this.#limited(ctx, { limit: "depth", per, max: depth, value: level }, words("depth", { agent: call.agent, max: depth, value: level }));
    if (agents !== undefined && this.#started >= agents) return this.#limited(ctx, { limit: "agents", per, max: agents, value: this.#started }, words("agents", { agent: call.agent, max: agents, value: this.#started }));
    // Its place is taken before anything is awaited, so the calls of one step cannot pass the limit
    // together; a call that starts nobody gives it back.
    this.#started += 1;
    let made: Made | LoopToolResult;
    const parent: ParentCall = { agent: ctx.agent.id, run: ctx.run, call: ctx.callId };
    try {
      made = await this.#make(call, { agent: ctx.agent.id, parent }, loaded);
    } catch (error) {
      this.#started -= 1;
      throw error;
    }
    // One past the sub-agents at once waits for a place; stopped in line, it starts nobody.
    const free = "runner" in made ? await this.#place(ctx, "delegate") : undefined;
    if (!("runner" in made) || free === undefined || ctx.signal.aborted) {
      free?.();
      this.#started -= 1;
      return "runner" in made ? said("") : made;
    }
    const member: Member = { ref: made.ref, runner: made.runner, level, parent, messages: 0, waiting: false, ...(made.most !== undefined ? { most: made.most } : {}) };
    const fields = fieldsOf(member.ref);
    this.#members.set(member.ref.id, member);
    d.session?.(member.ref, "agent", parent);
    d.gauge?.(member.ref, made.limits);
    d.progress?.("delegate", fields);
    const working = [...this.#members.values()].filter((other) => other.runner.working).length + 1;
    if (working > 1) d.progress?.("agents", { count: working });
    const work = this.#begin(member, { messages: [] }, { parent: member.parent, given: made.given }, ctx, free);
    return this.#end(member, work, ctx, made.missing, loaded);
  }

  /**
   * The first agent of a run of its own (a job, §13.5), made from a definition and a brief as
   * `delegate` makes a sub-agent. It stands where a turn's lead does: the user's limits on how deep
   * and how many hold for the agents it starts and not for it, and it has nobody above it to ask.
   * `by` is the agent whose call starts it and `parent` that call; neither when the user starts it.
   * Gives it ready to start, or the answer that says why none can be made.
   */
  async first(call: DelegateCall, by: AgentRef | undefined, parent: ParentCall | undefined): Promise<FirstAgent | LoopToolResult> {
    const made = await this.#make(call, { ...(by !== undefined ? { agent: by.id } : {}), ...(parent !== undefined ? { parent } : {}) }, await this.#load());
    if (!("runner" in made)) return made;
    this.#d.gauge?.(made.ref, made.limits);
    this.#d.session?.(made.ref, "job", parent);
    return { ref: made.ref, runner: made.runner, given: made.given, missing: made.missing };
  }

  /** An agent made from its definition and ready to start, or the answer that says why none can be. */
  async #make(call: DelegateCall, origin: Origin, loaded: Loaded): Promise<Made | LoopToolResult> {
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
    const ref: AgentRef = { id: `${definition.name}-${number}`, definition: definition.name, ...(origin.agent !== undefined ? { parent: origin.agent } : {}), ...(d.job !== undefined ? { job: d.job } : {}), ...(call.plays !== undefined ? { plays: call.plays } : {}) };
    const fields = fieldsOf(ref);
    const held = d.hold(definition.tools);
    if (held.missing.length > 0) d.unregistered(definition.name, held.missing);
    // Its opening block, made as every agent's is (§5.2), by the one builder.
    const block = await openingOf({ guidance: d.guidance, agent: definition.name, definition, tools: held.tools, isTool: (name) => d.hold([name]).tools.length > 0, fields, log: d.env.log });
    const instructions = block.text;
    // What its definition names, what the call that starts it attaches, and each file pinned for it, read whole now (R-174).
    const wanted: Wanted[] = [...definition.given.map((name) => ({ ref: name, from: "definition" as const })), ...call.attach.map((name) => ({ ref: name, from: "delegate" as const })), ...(await pinsOf(d.guidance, definition.name, d.env.log))];
    const slice = d.slice?.bind(d);
    const given = await attach({ env: d.env, scope: d.trace.scope, lines: loaded.lines, most: d.perCall(), ...(slice !== undefined ? { slice } : {}) }, ref, wanted);
    const attachments = given.blocks.map((block) => ({ name: block.name, text: block.text }));
    // A job the user started has nobody above its agent: its brief has a frame of its own. Without the frame, the brief and what it is given go as they are, one after another.
    const frame = origin.agent === undefined ? loaded.jobBrief : loaded.brief;
    const brief = frame?.render({ ...fields, task: call.brief, attachments, ...(call.returns !== undefined ? { returns: call.returns } : {}) }).text ?? joined([call.brief, ...given.blocks.map((block) => block.text)]);
    const rules = d.rules();
    const keep = d.keep?.(ref);
    const questions = d.questions?.();
    const session = d.ids();
    const options: RunnerOptions = {
      agent: ref,
      trace: d.trace,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session,
      thinkingLevel: model.thinkingLevel,
      terms: d.terms(definition.name),
      ...(instructions !== "" ? { instructions } : {}),
      // Its brief and what it was given go with each of its requests from pi's request hook, after its opening block (§10.2).
      context: [placed(userMessage(joined([brief]), d.trace.clock.now()), "brief")],
      tools: held.tools,
      texts: d.texts(),
      limits: definition.limits,
      turn: d.budget(),
      stream: rules.stream(ref),
      runEnd: rules.runEnd,
      ...(questions !== undefined ? { questions } : {}),
      gate: d.gate(ref, origin.parent, held.tools),
      ...(keep !== undefined ? { keep } : {}),
      // A run that goes on past an edit (a job's agent; one continued) is told what of its block no
      // longer stands, against its block made again from the files as they stand (R-128).
      changed: async () => {
        const now = loadGuidance(d.env.files, d.trace.scope);
        const [current, notices] = await Promise.all([now.definition(definition.name), now.part("notices")]);
        return changedText(block, await openingOf({ guidance: now, agent: definition.name, definition: current, tools: held.tools, isTool: (name) => d.hold([name]).tools.length > 0, fields }), notices);
      },
    };
    // Compacted at any call that would not fit, as the lead is (§11, §13.3): its own older calls, after the moment before compaction where a rule names its definition.
    const compaction = d.compaction?.();
    // Never cut, never silent (§10.5): what it starts with (its block, its brief and all it is given, its tools) is counted against its model's window less the reserve for its reply; past it, nothing starts and the lead is told the sizes, to decide.
    const window = model.limits.contextWindow?.tokens;
    if (window !== undefined && window > 0) {
      const ratio = options.terms.charsPerToken;
      const size = tokensOf(instructions, ratio) + tokensOf(joined([brief]), ratio) + tokensOf(JSON.stringify(held.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))), ratio);
      const room = window - (compaction?.reserve ?? 0);
      if (size > room) {
        d.env.log.info("A sub-agent was not started: what it starts with would not fit its model.", { agent: ref.id, size, room });
        return answer(loaded.words("too_large", { agent: definition.name, size, room, attachments: given.blocks.map((block) => ({ name: block.name, tokens: tokensOf(block.text, ratio) })) }), true);
      }
    }
    const compactor =
      compaction === undefined
        ? undefined
        : new Compactor({
            agent: ref,
            trace: d.trace,
            model,
            connection: connection.label,
            session,
            terms: options.terms,
            texts: options.texts,
            budget: d.budget(),
            settings: compaction,
            parts: async () => {
              const [compacting, carried] = await Promise.all([d.guidance.part("compaction"), d.guidance.part("carried")]);
              return { compaction: template(compacting), carried: template(carried) };
            },
            ids: () => d.ids(),
            log: d.env.log,
            ended: (summary) => d.models.ended?.(d.trace.scope.user, summary),
            keep: (agent) => d.keep?.(agent),
            track: (entry) => d.track(entry),
            stopped: () => false,
            written: (summary, facts) => d.compacted?.(ref, summary, facts),
            before: (request) => {
              const saving = d.keep?.(ref, "save");
              return saveBeforeCompaction(request, { options, rules, saveCalls: compaction.saveCalls, ...(saving !== undefined ? { keep: saving } : {}), track: (entry) => d.track(entry), stopped: () => request.signal.aborted });
            },
          });
    const runner = new AgentRunner({ ...options, ...(compactor !== undefined ? { point: compactor.point(model.limits.contextWindow?.tokens) } : {}) });
    if (runner.leftOut.length > 0) d.env.log.warn("Tools that take an argument named closing, which RPH adds to every tool, are left out.", { agent: definition.name, tools: runner.leftOut });
    // Its start record names only what it was handed.
    return { ref, runner, given: given.blocks.map((block) => block.name), missing: given.missing, limits: model.limits, ...(definition.limits?.messages !== undefined ? { most: definition.limits.messages } : {}) };
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
    // Nothing is awaited between this and its place in line, so two messages to one agent cannot both begin.
    if (member.runner.working || member.waiting) return answer(loaded.words("busy", fieldsOf(member.ref)), true);
    if (ctx.signal.aborted) return said("");
    // A message past its definition's count after its first answer is answered, and the agent is not run.
    if (member.most !== undefined && member.messages >= member.most) return answer(this.#d.texts().pastMessageCount?.({ agent: member.ref.definition, max: member.most }), true);
    member.messages += 1;
    member.waiting = true;
    const free = await this.#place(ctx, "agent_message");
    member.waiting = false;
    if (free === undefined) {
      member.messages -= 1;
      return said("");
    }
    const work = this.#begin(member, { message: call.message }, { parent: { agent: ctx.agent.id, run: ctx.run, call: ctx.callId } }, ctx, free);
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
      const [brief, jobBrief, question, lines] = await Promise.all([guidance.part(BRIEF_PART), guidance.part(JOB_BRIEF_PART), guidance.part(QUESTION_PART), guidance.part(LINES_PART)]);
      const wordLines = lines?.format === "lines" ? lines : undefined;
      return { brief: template(brief), jobBrief: template(jobBrief), question: template(question), lines: wordLines, words: (name, fields) => wordLines?.line(name, fields) };
    })().catch((error: unknown) => {
      // A read that failed is tried again by the next call.
      this.#loaded = undefined;
      throw error;
    });
    return this.#loaded;
  }

  /**
   * A place for a sub-agent's work (`limits.turn.agentsAtOnce`), the run's: at once, or after a wait
   * the trace of the agent that called is told of as it begins and ends; undefined where its call's
   * stop took it out of the line.
   */
  async #place(ctx: ToolCtx, tool: string): Promise<(() => void) | undefined> {
    const d = this.#d;
    const line = (this.#line ??= new PlaceLine(d.settings().agentsAtOnce));
    const parent = this.#members.get(ctx.agent.id)?.parent;
    const from = d.trace.clock.now();
    let waited = false;
    const free = await line.take(ctx.signal, () => {
      waited = true;
      d.trace.event(ctx.agent, parent, { kind: "waiting", for: "agent", callId: ctx.callId, tool });
    });
    if (free !== undefined && waited) d.trace.event(ctx.agent, parent, { kind: "waiting", for: "agent", callId: ctx.callId, tool, ms: d.trace.clock.now() - from });
    return free;
  }

  /** Starts a stretch of a member's work under `parent`'s call, in the place it took: the turn tracks it, and the call's own stop stops it. */
  #begin(member: Member, input: WorkInput, options: WorkOptions & { parent: ParentCall }, ctx: ToolCtx, free: () => void): Begun {
    member.parent = options.parent;
    const work = member.runner.start(input, options);
    const untrack = this.#d.track({ runner: member.runner, work });
    const stop = (): void => work.stop();
    ctx.signal.addEventListener("abort", stop, { once: true });
    return { work, untrack, stop, free };
  }

  /** Waits for the stretch of work to end, gives its place back, and gives the call its answer. */
  async #end(member: Member, begun: Begun, ctx: ToolCtx, missing: readonly string[], loaded: Loaded): Promise<LoopToolResult> {
    let outcome: AgentOutcome;
    try {
      outcome = await begun.work.done;
    } finally {
      begun.free();
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
    const per = this.#d.job !== undefined ? "job" : "turn";
    // Its place is taken before anything is awaited, as a delegate's is.
    const hit: LimitHit | undefined = level > depth ? { limit: "depth", per, max: depth, value: level } : agents !== undefined && this.#started >= agents ? { limit: "agents", per, max: agents, value: this.#started } : undefined;
    if (hit === undefined) {
      this.#started += 1;
      this.#members.set(ref.id, { ref, runner, level, parent, messages: 0, waiting: false, ...(ended !== undefined ? { ended } : {}) });
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
        const text = loaded.question?.render({ ...fields, ...asked }).text ?? joined([asked.question, asked.searched]);
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
