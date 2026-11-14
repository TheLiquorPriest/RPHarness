// The agent runner: one agent on pi's `Agent` (§13.2, §13.3), with what RPH adds around pi's loop.
// Per request: the call's sampling and longest answer, and the user's limits. Per tool: the
// `closing` argument, the call's context, the gate around it (permissions, rules, clipping), and a
// stop that does not wait on a tool. Per message: the text to the reply as it streams, rules on what
// is written (stop the call, drop what was not shown, go on), and at the moment the work would end,
// the rules due then as follow-ups. Every event goes to the run's trace with the agent and the run it
// belongs to; after a stop, nothing but the agent's end.
//
// No text reaches a model that did not come from a file or from the request: where pi would answer a
// call in its own words (a tool it does not know, arguments that do not fit, arguments cut short by
// the length limit, a tool that threw), the call is answered with the runner's texts instead, which
// the harness reads from files. A text the file does not have leaves the answer empty.
import { Agent, type AfterToolCallContext, type AfterToolCallResult, type AgentEvent, type AgentMessage, type AgentTool, type AgentToolResult, type AgentTurnContext, type AgentTurnDecision, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TextContent, type ToolCall, type ToolResultMessage, type TranscriptContext, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentRef, JsonObject, JsonSchema, JsonValue, LimitHit, RuleAction, ToolCtx, ToolResult, TraceEvent, Usage } from "../contract";
import { DEFAULT_CHARS_PER_TOKEN, tokensOf } from "../model/tokens";
import { addUsage, Budget, emptyUsage } from "./budget";
import type { TextChannel } from "./channel";
import type { Fired, Judged, Judgment, QuestionRules, RunEndRules, StreamFired, StreamRules } from "./rules";
import { fit, type Misfit } from "./fit";
import type { ParentCall, RunTrace } from "./trace";
import type { AgentLimits, AgentOutcome, CallRequest, CallSettings, GateCall, KeepRequest, LoopClock, LoopTool, LoopToolResult, ToolGate } from "./types";

/** The argument RPH adds to every tool (§10.7, Appendix A): the agent marks a call that needs no answer. */
export const CLOSING = "closing";

/** Texts the runner sends a model. Each comes from a file; one that gives undefined leaves its answer empty. */
export interface RunnerTexts {
  /**
   * `.prompts/continue-after-rule.md`, filled with what the player was shown: the line an agent
   * goes on under after a rule stopped its call. The rule's own text comes just before it.
   */
  continueAfterRule(fields: { shown: string }): string;
  /** How the `closing` argument is described to the model, from the tool guides; absent leaves it undescribed. */
  closing?: string;
  /** The answer to a call of a tool the agent does not hold. */
  notFound?(fields: { tool: string }): string | undefined;
  /**
   * The answer to a call whose arguments do not fit what its tool takes: what was sent, and the
   * tool's parameters, both as JSON, and each argument that did not fit and why, as pi's check found
   * them (none where it lists none: arguments that did not parse).
   */
  invalid?(fields: { tool: string; arguments: string; parameters: string; misfits: Misfit[] }): string | undefined;
  /** The answer to a call in a message that hit its length limit, whose arguments may be cut short. */
  cutShort?(fields: { tool: string }): string | undefined;
  /** The answer to a call whose tool threw: the error's own words. */
  failed?(fields: { tool: string; error: string }): string | undefined;
  /** The answer to a call the work stopped before it finished (a stop, or a limit), kept so the agent can be continued: it may have done its work, or not. */
  unfinished?(fields: { tool: string }): string | undefined;
}

export interface RunnerOptions {
  agent: AgentRef;
  /** The run it works in; every agent of the run shares it. */
  trace: RunTrace;
  model: Model<Api>;
  /** The model call: the model layer's, or a scripted model's. */
  streamFn: StreamFn;
  /** The connection the model is reached through, for the trace. */
  connection: string;
  /** Its own session (§13.4), for the trace. */
  session: string;
  thinkingLevel?: ThinkingLevel;
  /** Its instructions, as its definition and the files it reads give them. */
  instructions?: string;
  /** What its session carries into its first work. */
  messages?: AgentMessage[];
  tools?: LoopTool[];
  texts: RunnerTexts;
  /** Sampling and longest answer for each model call, decided per request. */
  settings?(request: CallRequest): CallSettings | undefined;
  /** Its own limits, over all its work in the run. `time` holds for each stretch of work. */
  limits?: AgentLimits;
  /** Limits shared with the other agents of its turn. */
  turn?: Budget;
  stream?: StreamRules;
  runEnd?: RunEndRules;
  /** The `question:` rules, put to a judging model about each message it finishes. */
  questions?: QuestionRules;
  /** What runs around each of its tool calls: permissions, rules, clipping. None: each call simply runs. */
  gate?: ToolGate;
  /** Where its text goes as it streams, when it writes the reply. */
  channel?: TextChannel;
  /** Keeps what its calls are sent, where the user's setting asks for it; none keeps nothing. */
  keep?: KeepRequest;
}

export type WorkInput =
  /** Messages to start from: the first work of a run (the prompt, a brief). */
  | { messages: AgentMessage[] }
  /** A message for an agent that stopped: the answer to its question when it asked one, else a message of its own. */
  | { message: string };

export interface WorkOptions {
  /** The call that started or continued this work, for a sub-agent. */
  parent?: ParentCall;
  /** What it was given by name, for the trace. */
  given?: string[];
}

export interface Work {
  done: Promise<AgentOutcome>;
  /** Stops the work where it stands. Nothing further is emitted but the agent's end. */
  stop(): void;
}

type Halt = { status: "stopped" } | { status: "limit"; hit: LimitHit };

/** One stretch of an agent's work: from `start` until it stops, asks, or is done. */
interface Stint {
  readonly parent: ParentCall | undefined;
  /** The transcript's length when it began: its own messages come after. */
  readonly from: number;
  readonly startedAt: number;
  readonly usage: Usage;
  readonly resolve: (outcome: AgentOutcome) => void;
  halt?: Halt;
  /** A rule that stopped the call in flight. */
  cut?: StreamFired;
  callText: string;
  callThinking: string;
  callStartedAt: number;
  /** The transcript's length when the call under way began: a message a rule stops is cut back to it. */
  callFrom: number;
  /**
   * A call this runner started is open. pi also ends every message it is given to start from (an
   * earlier reply in the prompt, a prefilled start), with the same event as a model's answer; only
   * the answer to an open call is a call's end.
   */
  calling: boolean;
  /** Each tool call's own answer, by call id. */
  readonly results: Map<string, LoopToolResult>;
  /**
   * Calls that are never clean, whatever their answer now shows: a rule added its text to them or
   * answered instead of the tool, or the tool reported something the bound on what the model reads
   * left out.
   */
  readonly unclean: Set<string>;
  /** Calls whose result ended their batch. */
  readonly ended: Set<string>;
  /** Calls that finished before any stop. */
  readonly finished: Set<string>;
  /** Rules on the stream that remind after the message. */
  readonly reminders: StreamFired[];
  /** A carrier's calls (`tool_use`) as they began, by call id: its own arguments, traced only if it carries no tool. */
  readonly carried: Map<string, { args: JsonValue; closing: boolean }>;
  /** The tool each carrier's call ran as itself (`runAs`), by the carrier's call id, and its answer as the gate gave it. */
  readonly ranAs: Map<string, { tool: string; result: LoopToolResult }>;
  /** Questions put to the judging model about its messages, still unanswered. */
  readonly judging: Set<Judgment>;
  /** Rules a judging model's answer fired, to go in front of the agent at the end of the step under way. */
  readonly judged: Judged[];
  /** Settles when the work stops or reaches a limit, so nothing it waits for outlasts it. */
  readonly halted: PromiseWithResolvers<void>;
  asked?: { call: string; question: JsonValue };
  last?: AssistantMessage;
  timer?: unknown;
}

export class AgentRunner {
  readonly agent: AgentRef;
  readonly #o: RunnerOptions;
  readonly #pi: Agent;
  readonly #clock: LoopClock;
  readonly #budget: Budget;
  /** Its tools by name, as the model was told them. */
  readonly #tools = new Map<string, AgentTool<JsonSchema, JsonValue | undefined>>();
  /**
   * Tools it was given that take an argument named `closing`, which RPH adds to every tool: left out,
   * as a host's tool that takes the name of one of RPH's own is, for the host to report.
   */
  readonly leftOut: string[] = [];
  /** Its tools that carry a call of another tool (`LoopTool.carrier`). */
  readonly #carriers = new Set<string>();
  #calls = 0;
  #stint: Stint | undefined;
  /** The call its last work ended on with a question, until a message answers it. */
  #asked: string | undefined;

  constructor(options: RunnerOptions) {
    this.agent = options.agent;
    this.#o = options;
    this.#clock = options.trace.clock;
    this.#budget = new Budget("agent", options.limits ?? {});
    for (const tool of options.tools ?? []) {
      if (Object.hasOwn(argumentsOf(tool), CLOSING)) this.leftOut.push(tool.name);
      else {
        this.#tools.set(tool.name, this.#piTool(tool));
        if (tool.carrier === true) this.#carriers.add(tool.name);
      }
    }
    this.#pi = new Agent({
      initialState: {
        ...(options.instructions !== undefined ? { systemPrompt: options.instructions } : {}),
        model: options.model,
        ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
        tools: [...this.#tools.values()],
        messages: options.messages ?? [],
      },
      streamFn: (model, context, streamOptions) => this.#call(model, context, streamOptions),
      afterToolCall: (context) => this.#afterTool(context),
      finishTurn: (turn) => this.#finishTurn(turn),
      // Every rule due at one moment goes in with the same call.
      followUpMode: "all",
      steeringMode: "all",
      // pi's loop names itself to providers by default (OpenRouter's attribution headers); RPH's calls go out as the user's own.
      identity: { attribution: null },
    });
    this.#pi.subscribe((event) => this.#onEvent(event));
  }

  /** Whether it is working now. */
  get working(): boolean {
    return this.#stint !== undefined;
  }

  /** Whether its last work ended with a question that no message has answered yet. */
  get asking(): boolean {
    return this.#asked !== undefined;
  }

  /** Its transcript as it stands. */
  get transcript(): readonly AgentMessage[] {
    return this.#pi.state.messages;
  }

  /** Whether pi's loop has settled: nothing streaming, no tool running. */
  get idle(): boolean {
    return !this.#pi.state.isStreaming && this.#pi.state.pendingToolCalls.size === 0;
  }

  /** Starts a stretch of work. One at a time: an agent that is working cannot be started again. */
  start(input: WorkInput, options: WorkOptions = {}): Work {
    if (this.#stint !== undefined) throw new Error(`Agent ${this.agent.id} is already working.`);
    let first: () => Promise<void>;
    if ("message" in input) {
      const asked = this.#asked;
      if (asked !== undefined) {
        this.#answer(asked, input.message);
        first = () => this.#pi.continue();
      } else {
        first = () => this.#pi.prompt(userMessage([input.message]));
      }
    } else {
      if (this.#asked !== undefined) throw new Error(`Agent ${this.agent.id} is waiting for the answer to its question; continue it with a message.`);
      first = () => this.#pi.prompt(input.messages);
    }
    this.#asked = undefined;
    const { promise, resolve } = Promise.withResolvers<AgentOutcome>();
    const stint: Stint = {
      parent: options.parent,
      from: this.#pi.state.messages.length,
      startedAt: this.#clock.now(),
      usage: emptyUsage(),
      resolve,
      callText: "",
      callThinking: "",
      callStartedAt: 0,
      callFrom: 0,
      calling: false,
      results: new Map(),
      unclean: new Set(),
      ended: new Set(),
      finished: new Set(),
      reminders: [],
      carried: new Map(),
      ranAs: new Map(),
      judging: new Set(),
      judged: [],
      halted: Promise.withResolvers<void>(),
    };
    this.#stint = stint;
    const effort = this.#pi.state.thinkingLevel;
    this.#emit(stint, { kind: "agent_started", definition: this.agent.definition, connection: this.#o.connection, model: this.#pi.state.model.id, effort, session: this.#o.session, given: options.given ?? [] });
    const time = this.#o.limits?.time;
    if (time !== undefined) {
      stint.timer = this.#clock.setTimeout(() => {
        this.#halt(stint, { status: "limit", hit: { limit: "time", per: "agent", max: time, value: this.#clock.now() - stint.startedAt, agent: this.agent } });
      }, time);
    }
    void this.#drive(stint, first);
    return { done: promise, stop: () => this.#halt(stint, { status: "stopped" }) };
  }

  /** Ends the work in flight at a limit that is not its own (the turn's time): as a stop, with that limit. */
  limit(hit: LimitHit): void {
    const stint = this.#stint;
    if (stint !== undefined) this.#halt(stint, { status: "limit", hit });
  }

  async #drive(stint: Stint, first: () => Promise<void>): Promise<void> {
    let next: (() => Promise<void>) | undefined = first;
    let failure: string | undefined;
    while (next !== undefined) {
      try {
        await next();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      next = undefined;
      const cut = stint.cut;
      if (cut === undefined) continue;
      // The call a rule stopped leaves no trace in the transcript, whatever the provider had sent
      // before pi's loop read the match: its words, its calls, and pi's answers to them.
      stint.cut = undefined;
      this.#pi.state.messages = this.#pi.state.messages.slice(0, stint.callFrom);
      if (stint.halt !== undefined || failure !== undefined) continue;
      // The agent goes on under the rule's text and the line that says where the player's view ends (§5.4).
      const shown = this.#o.channel?.tail() ?? "";
      const goOn = this.#o.texts.continueAfterRule({ shown });
      const content = goOn === "" ? [cut.text] : [cut.text, goOn];
      next = () => this.#pi.prompt(userMessage(content));
    }
    this.#finish(stint, failure);
  }

  #finish(stint: Stint, failure: string | undefined): void {
    if (stint.timer !== undefined) this.#clock.clearTimeout(stint.timer);
    const last = stint.last;
    const failed = stint.halt === undefined && (failure !== undefined || last === undefined || last.stopReason === "error");
    if (stint.halt !== undefined || failed) this.#settle(stint);
    const base = { agent: this.agent, usage: stint.usage, text: last !== undefined && stint.halt === undefined ? textOf(last) : "" };
    let outcome: AgentOutcome;
    if (stint.halt?.status === "limit") outcome = { ...base, status: "limit", limit: stint.halt.hit };
    else if (stint.halt !== undefined) outcome = { ...base, status: "stopped" };
    else if (failed) outcome = { ...base, status: "failed", error: failure ?? last?.errorMessage ?? "", failure: failure !== undefined ? "harness" : "model" };
    else if (stint.asked !== undefined) {
      outcome = { ...base, status: "asked", question: stint.asked.question };
      this.#asked = stint.asked.call;
    } else outcome = { ...base, status: "done" };
    this.#stint = undefined;
    this.#emit(stint, { kind: "agent_ended", status: outcome.status, ...(outcome.limit !== undefined ? { limit: outcome.limit } : {}), usage: stint.usage });
    // A rule a judging model's answer fired that the work ended before taking in goes back to the run.
    for (const judged of stint.judged.splice(0)) this.#o.questions?.late(this.agent, judged);
    stint.resolve(outcome);
  }

  #halt(stint: Stint, halt: Halt): void {
    if (this.#stint !== stint || stint.halt !== undefined) return;
    stint.halt = halt;
    stint.halted.resolve();
    if (halt.status === "limit") this.#emit(stint, { kind: "limit", hit: halt.hit });
    this.#o.channel?.cut();
    this.#pi.abort();
  }

  /** The model call pi's loop makes, wrapped: limits first, then the call's own settings, then a stream that ends the moment the work stops. */
  #call(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessageEventStream {
    const out = createAssistantMessageEventStream();
    const stint = this.#stint;
    const signal = options?.signal;
    if (stint !== undefined && stint.halt === undefined) {
      const hit = this.#budget.reached(this.agent) ?? this.#o.turn?.reached(this.agent);
      if (hit !== undefined) this.#halt(stint, { status: "limit", hit });
    }
    if (stint === undefined || stint.halt !== undefined || signal?.aborted === true) {
      endAborted(out, emptyAnswer(model));
      return out;
    }
    this.#calls += 1;
    const counted: Usage = { ...emptyUsage(), calls: 1 };
    addUsage(stint.usage, counted);
    this.#budget.count(counted);
    this.#o.turn?.count(counted);
    const settings = this.#o.settings?.({ agent: this.agent, call: this.#calls, model: model.id }) ?? {};
    stint.callText = "";
    stint.callThinking = "";
    stint.callStartedAt = this.#clock.now();
    stint.callFrom = this.#pi.state.messages.length;
    stint.calling = true;
    this.#o.channel?.begin();
    const request = this.#o.keep?.(this.#calls, context.messages);
    this.#emit(stint, {
      kind: "call_started",
      call: this.#calls,
      connection: this.#o.connection,
      model: model.id,
      ...(settings.sampling !== undefined ? { sampling: settings.sampling } : {}),
      ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
      messages: context.messages.length,
      tools: this.#pi.state.tools.length,
      ...(request !== undefined ? { request } : {}),
      // The model layer's own estimate, so these weigh as its counts of a whole request do.
      toolTokens: tokensOf(JSON.stringify(getCurrentTools(context.messages)), DEFAULT_CHARS_PER_TOKEN),
      openingTokens: tokensOf(this.#o.instructions ?? "", DEFAULT_CHARS_PER_TOKEN),
    });
    let source: Promise<AssistantMessageEventStream>;
    try {
      source = Promise.resolve(this.#o.streamFn(model, context, { ...options, ...streamSettings(settings) }));
    } catch (error) {
      source = Promise.reject(error);
    }
    void pump(source, out, signal, model);
    return out;
  }

  #onEvent(event: AgentEvent): void {
    const stint = this.#stint;
    if (stint === undefined) return;
    switch (event.type) {
      case "message_update": {
        if (stint.halt !== undefined || stint.cut !== undefined) return;
        const piece = event.assistantMessageEvent;
        if (piece.type === "text_delta") this.#onText(stint, piece.delta);
        else if (piece.type === "thinking_delta") this.#onThinking(stint, piece.delta);
        return;
      }
      case "message_end": {
        const message = event.message;
        if (message.role !== "assistant" || !stint.calling) return;
        stint.calling = false;
        const used = usageOf(message);
        addUsage(stint.usage, used);
        this.#budget.count(used);
        this.#o.turn?.count(used);
        if (stint.halt !== undefined) return;
        if (stint.cut === undefined) {
          stint.last = message;
          // A message the provider failed in the middle of did not end whole: what of it was held back
          // is dropped, as at a cut, and no reply is released on it (§10.7).
          if (message.stopReason === "error" || message.stopReason === "aborted") this.#o.channel?.cut();
          else this.#o.channel?.end(message);
        }
        const thinking = thinkingOf(message);
        this.#emit(stint, {
          kind: "call_ended",
          call: this.#calls,
          model: message.model,
          text: textOf(message),
          ...(thinking !== "" ? { thinking } : {}),
          toolCalls: message.content.flatMap((part) => (part.type === "toolCall" ? [{ id: part.id, name: part.name, args: withoutClosing(part.arguments as JsonValue) }] : [])),
          stop: stint.cut !== undefined ? "cut" : message.stopReason,
          usage: { ...used, calls: 1 },
          ms: this.#clock.now() - stint.callStartedAt,
          ...(message.errorMessage !== undefined ? { error: message.errorMessage } : {}),
        });
        if (stint.cut === undefined && message.stopReason !== "error" && message.stopReason !== "aborted") this.#judge(stint, message);
        return;
      }
      case "tool_execution_start": {
        // After a cut, a call of the stopped message is never run: pi only answers it, and that answer leaves with the message.
        if (stint.halt !== undefined || stint.cut !== undefined) return;
        const args = event.args as JsonValue;
        // A carrier's call is traced as the tool it runs (`runAs`); one that runs none is traced as itself when it ends.
        if (this.#carriers.has(event.toolName)) stint.carried.set(event.toolCallId, { args: withoutClosing(args), closing: isClosing(args) });
        else this.#emit(stint, { kind: "tool_started", callId: event.toolCallId, tool: event.toolName, args: withoutClosing(args), closing: isClosing(args) });
        return;
      }
      case "tool_execution_end": {
        if (stint.halt !== undefined || stint.cut !== undefined) return;
        stint.finished.add(event.toolCallId);
        const own = stint.results.get(event.toolCallId);
        // A result pi made itself (an unknown tool, arguments that did not validate) is pi's AgentToolResult; pi types the event's field loosely.
        const made: AgentToolResult = event.result;
        if (own === undefined) this.#reword(stint, event.toolCallId, event.toolName, made);
        const ranAs = stint.ranAs.get(event.toolCallId);
        const tool = ranAs?.tool ?? event.toolName;
        // A tool run as itself is traced with its answer as the gate gave it, as a call of the agent's own list is: its reports and the rules' texts went to the model after it.
        const result: ToolResult = ranAs !== undefined ? withoutAsk(ranAs.result) : own !== undefined ? withoutAsk(own) : { content: made.content, ...(event.isError ? { error: true as const } : {}) };
        const clean = !event.isError && isClean(result) && !stint.unclean.has(event.toolCallId);
        const carried = stint.carried.get(event.toolCallId);
        if (carried !== undefined && ranAs === undefined) this.#emit(stint, { kind: "tool_started", callId: event.toolCallId, tool, args: carried.args, closing: carried.closing });
        this.#emit(stint, { kind: "tool_ended", callId: event.toolCallId, tool, result, clean, endedRun: stint.ended.has(event.toolCallId), ms: event.durationMs ?? 0 });
        return;
      }
      default:
        return;
    }
  }

  /**
   * A call pi answered itself, before any tool ran: a tool the agent does not hold, arguments cut
   * short by the length limit, or arguments that do not fit. Its answer is given the runner's text
   * for it in place of pi's words. The answer's content is the very list pi turns into the call's
   * result message right after this event, so changing it here is what the model reads.
   */
  #reword(stint: Stint, callId: string, toolName: string, made: AgentToolResult): void {
    const texts = this.#o.texts;
    const tool = this.#tools.get(toolName);
    let line: string | undefined;
    if (tool === undefined) line = texts.notFound?.({ tool: toolName });
    else if (stint.last?.stopReason === "length") line = texts.cutShort?.({ tool: toolName });
    else {
      const call = stint.last?.content.find((part) => part.type === "toolCall" && part.id === callId);
      const raw = call?.type === "toolCall" ? (call.arguments as JsonValue) : {};
      // The check pi ran, run again on what it was given, so its findings come as data a file can lay out.
      const checked = fit(tool, raw, callId);
      line = texts.invalid?.({ tool: toolName, arguments: JSON.stringify(withoutClosing(raw)), parameters: JSON.stringify(tool.parameters), misfits: "misfits" in checked ? checked.misfits : [] });
    }
    const content: TextContent[] = line === undefined ? [] : [{ type: "text", text: line }];
    made.content.splice(0, made.content.length, ...content);
  }

  #onText(stint: Stint, piece: string): void {
    stint.callText += piece;
    this.#o.trace.delta(this.agent, this.#calls, { text: piece });
    this.#o.channel?.write(piece);
    // The rules look before anything is released, so a match stops what it matched from being shown.
    if (this.#check(stint, "text")) return;
    this.#o.channel?.release();
  }

  #onThinking(stint: Stint, piece: string): void {
    stint.callThinking += piece;
    this.#o.trace.delta(this.agent, this.#calls, { thinking: piece });
    this.#check(stint, "thinking");
  }

  /** Asks the rules on the stream about what was written; true when one stopped the call. */
  #check(stint: Stint, piece: "text" | "thinking"): boolean {
    const rules = this.#o.stream;
    if (rules === undefined) return false;
    const reply = this.#o.channel?.reply;
    const fired = rules.check({ agent: this.agent, call: this.#calls, piece, text: stint.callText, thinking: stint.callThinking, ...(reply !== undefined ? { reply } : {}) });
    if (fired === undefined) return false;
    if (!fired.interrupt) {
      stint.reminders.push(fired);
      return false;
    }
    stint.cut = fired;
    const dropped = this.#o.channel !== undefined ? this.#o.channel.cut() : stint.callText;
    this.#emit(stint, { kind: "rule_fired", firing: { ...fired.firing, agent: this.agent, action: "cut", ...(dropped !== "" ? { dropped } : {}) } });
    this.#pi.abort();
    return true;
  }

  async #afterTool(context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
    const stint = this.#stint;
    if (stint === undefined || stint.halt !== undefined) return undefined;
    const id = context.toolCall.id;
    const result = stint.results.get(id);
    if (result?.ask !== undefined) {
      stint.asked ??= { call: id, question: result.ask };
      stint.ended.add(id);
      return { terminate: true };
    }
    // A closing call that comes back clean needs no further call (§10.7). Whether something is due
    // at the run's end is asked once the whole batch is in (`#finishTurn`): pi still takes a
    // follow-up after a batch that ended this way.
    if (isClosing(context.args as JsonValue) && !context.isError && result !== undefined && isClean(result) && !stint.unclean.has(id)) {
      stint.ended.add(id);
      return { terminate: true };
    }
    return undefined;
  }

  async #finishTurn(turn: AgentTurnContext): Promise<AgentTurnDecision | undefined> {
    const stint = this.#stint;
    if (stint === undefined) return undefined;
    const { message } = turn;
    // A message a rule stopped ends pi's loop as it stands, whatever end the provider gave it: no
    // call of it is answered and no run ends on it. `#drive` goes on from before it.
    if (stint.cut !== undefined) return { action: "end" };
    if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
    if (stint.halt !== undefined || stint.asked !== undefined) return { action: "end" };
    // The answers the agent waits for (`interrupt: always`) come in before its next call; a stop does not wait on them.
    const waited = [...stint.judging].filter((judgment) => judgment.wait);
    if (waited.length > 0) {
      await Promise.race([Promise.allSettled(waited.map((judgment) => judgment.answer)), stint.halted.promise]);
      if (stint.halt !== undefined) return { action: "end" };
    }
    const reminders = stint.reminders.splice(0);
    const answers = this.#o.channel?.answers?.() ?? [];
    if (!turn.toolResults.every((result) => stint.ended.has(result.toolCallId))) {
      // The work goes on anyway: a reminder, what the reply's form has to say, and the rules a judging model's answer fired go in with the next call.
      for (const fired of reminders) this.#add(stint, fired, "remind", "steer");
      for (const text of answers) this.#pi.steer(userMessage([text]));
      for (const judged of stint.judged.splice(0)) this.#judged(stint, judged, "steer");
      return undefined;
    }
    // The work would end here. What is due at a run's end goes in as a follow-up, and the agent
    // gets one more call.
    const due = (await this.#o.runEnd?.due({ agent: this.agent, call: this.#calls })) ?? [];
    if (stint.halt !== undefined) return { action: "end" };
    for (const fired of reminders) this.#add(stint, fired, "remind", "follow-up");
    for (const text of answers) this.#pi.followUp(userMessage([text]));
    for (const fired of due) this.#add(stint, fired, "follow-up", "follow-up");
    for (const judged of stint.judged.splice(0)) this.#judged(stint, judged, "follow-up");
    return undefined;
  }

  /**
   * Puts the `question:` rules due on a message just finished to the judging model. A rule its
   * answer fires goes in front of the agent at the end of the step under way; one that comes once
   * the work has ended goes back to the run (`QuestionRules.late`).
   */
  #judge(stint: Stint, message: AssistantMessage): void {
    const questions = this.#o.questions;
    if (questions === undefined) return;
    for (const judgment of questions.ask({ agent: this.agent, call: this.#calls, text: textOf(message), thinking: thinkingOf(message) })) {
      stint.judging.add(judgment);
      const settle = (judged: Judged | undefined): void => {
        stint.judging.delete(judgment);
        if (judged === undefined) return;
        if (this.#stint === stint && stint.halt === undefined) stint.judged.push(judged);
        else questions.late(this.agent, judged);
      };
      // A judgment that failed is an answer that fires nothing; the run that made it says why.
      void judgment.answer.then(settle, () => settle(undefined));
    }
  }

  /** A rule a judging model's answer fired: its text goes in with the next call (a reply already shown: it was held for the next briefing). */
  #judged(stint: Stint, judged: Judged, how: "steer" | "follow-up"): void {
    if (judged.deliver === "briefing") this.#emit(stint, { kind: "rule_fired", firing: { ...judged.fired.firing, agent: this.agent, action: "briefing" } });
    else this.#add(stint, judged.fired, how === "steer" ? "remind" : "follow-up", how);
  }

  #add(stint: Stint, fired: Fired, action: "remind" | "follow-up", how: "steer" | "follow-up"): void {
    const message = userMessage([fired.text]);
    if (how === "steer") this.#pi.steer(message);
    else this.#pi.followUp(message);
    this.#emit(stint, { kind: "rule_fired", firing: { ...fired.firing, agent: this.agent, action } });
  }

  /**
   * After a stop or a failure: a message cut short or failed leaves the transcript, and the step
   * before it stays, its calls that finished with their answers and each that did not with the
   * runner's text for it. So the agent can be continued as it stands, and no write that went through
   * vanishes from what it knows. (pi-ai would skip such a message and invent results for unanswered
   * calls, in its own words; this way it never has to.)
   */
  #settle(stint: Stint): void {
    const messages = this.#pi.state.messages.slice();
    for (let last = messages.at(-1); messages.length > stint.from && last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error"); last = messages.at(-1)) {
      messages.pop();
    }
    for (let at = messages.length - 1; at >= stint.from; at -= 1) {
      const message = messages[at];
      if (message?.role !== "assistant") continue;
      const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [part] : []));
      if (calls.every((call) => stint.finished.has(call.id))) break;
      const answers = new Map(messages.slice(at + 1).flatMap((after) => (after.role === "toolResult" ? [[after.toolCallId, after] as const] : [])));
      // What pi holds for a call that did not finish is the empty answer the stop gave it, or pi's own words: neither is kept.
      messages.splice(at + 1, messages.length, ...calls.map((call) => (stint.finished.has(call.id) ? answers.get(call.id) : undefined) ?? this.#unfinished(call)));
      break;
    }
    this.#pi.state.messages = messages;
  }

  #unfinished(call: ToolCall): ToolResultMessage {
    const line = this.#o.texts.unfinished?.({ tool: call.name });
    return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: line === undefined ? [] : [{ type: "text", text: line }], isError: true, timestamp: Date.now() };
  }

  /** The answer to the question the agent stopped on becomes that call's result. */
  #answer(call: string, text: string): void {
    this.#pi.state.messages = this.#pi.state.messages.map((message) => (message.role === "toolResult" && message.toolCallId === call ? { ...message, content: [{ type: "text", text }] } : message));
  }

  #piTool(tool: LoopTool): AgentTool<JsonSchema, JsonValue | undefined> {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: withClosing(tool, this.#o.texts.closing),
      ...(tool.sequential === true ? { executionMode: "sequential" as const } : {}),
      execute: async (callId, params, signal) => {
        const stint = this.#stint;
        // Only a call of the work in flight runs; pi makes no other.
        if (stint === undefined) return { content: [], details: undefined };
        let answered = false;
        const call: GateCall = { agent: this.agent, callId, tool: tool.name, args: withoutClosing(params as JsonValue) };
        const ctx: ToolCtx = {
          scope: this.#o.trace.scope,
          agent: this.agent,
          run: this.#o.trace.run,
          callId,
          signal: signal ?? new AbortController().signal,
          onUpdate: (partial) => {
            if (answered || stint.halt !== undefined) return;
            this.#emit(stint, { kind: "tool_update", callId, tool: tool.name, partial });
          },
        };
        if (tool.carrier === true) {
          // The tool it carries runs through `runAs`, gated and ruled on as itself with its lines after its answer; the carrier has no gate of its own.
          const carried = await untilAborted(this.#run(tool, call, ctx), signal);
          answered = true;
          if (carried === undefined) return { content: [], details: undefined };
          stint.results.set(callId, carried);
          const reports = stint.ranAs.has(callId) ? [] : (carried.reports ?? []).map((line) => ({ type: "text" as const, text: line }));
          return { content: [...carried.content, ...reports], details: carried.details, ...(carried.error === true ? { isError: true } : {}) };
        }
        // pi waits on a tool until it settles; a stop does not. What fails around the tool (a permission
        // or a rule that could not be asked) is answered like a tool that failed, never in pi's words.
        const result = await untilAborted(
          this.#gated(stint, tool, call, ctx).catch((error: unknown) => ({ answer: this.#failed(tool, error), texts: [] })),
          signal,
        );
        answered = true;
        if (result === undefined) return { content: [], details: undefined };
        stint.results.set(callId, result.answer);
        if (result.texts.length > 0) stint.unclean.add(callId);
        // A report is shown to the model after the call's content, one line each; then the texts of the rules on the call.
        const after = [...(result.answer.reports ?? []), ...result.texts].map((line) => ({ type: "text" as const, text: line }));
        return { content: [...result.answer.content, ...after], details: result.answer.details, ...(result.answer.error === true ? { isError: true } : {}) };
      },
    };
  }

  /**
   * Runs the tool a carrier's call names (`tool_use`, §6.8) as itself, from inside that call: through
   * the gate, ruled on and traced under its own name and the carrier's call id, with its reports and
   * the texts of the rules on it after its answer, as a call of the agent's own list is. Outside a
   * carrier's call of the work in flight it runs nothing.
   */
  async runAs(tool: LoopTool, args: JsonValue, ctx: ToolCtx): Promise<LoopToolResult> {
    const stint = this.#stint;
    const carried = stint?.carried.get(ctx.callId);
    if (stint === undefined || carried === undefined || stint.halt !== undefined) return { content: [] };
    const callId = ctx.callId;
    let answered = false;
    const own: ToolCtx = {
      ...ctx,
      onUpdate: (partial) => {
        if (answered || stint.halt !== undefined) return;
        this.#emit(stint, { kind: "tool_update", callId, tool: tool.name, partial });
      },
    };
    this.#emit(stint, { kind: "tool_started", callId, tool: tool.name, args, closing: carried.closing, via: "tool_use" });
    const ran = await this.#gated(stint, tool, { agent: this.agent, callId, tool: tool.name, args }, own).catch((error: unknown) => ({ answer: this.#failed(tool, error), texts: [] }));
    answered = true;
    if (ran === undefined) return { content: [] };
    stint.ranAs.set(callId, { tool: tool.name, result: ran.answer });
    if (ran.texts.length > 0) stint.unclean.add(callId);
    const after = [...(ran.answer.reports ?? []), ...ran.texts].map((line) => ({ type: "text" as const, text: line }));
    return { ...ran.answer, content: [...ran.answer.content, ...after] };
  }

  /**
   * One call through the gate: refused or held there, or run; then the rules on its result. Gives the
   * answer and the rules' texts that go after it, or nothing once the work stopped: a call the gate
   * was still asking about (a permission still open) never runs, and a result that comes in after the
   * stop goes through nothing more.
   */
  async #gated(stint: Stint, tool: LoopTool, call: GateCall, ctx: ToolCtx): Promise<{ answer: LoopToolResult; texts: string[] } | undefined> {
    const gate = this.#o.gate;
    if (gate === undefined) return { answer: await this.#run(tool, call, ctx), texts: [] };
    const before = await gate.before(call, ctx.signal);
    if (ctx.signal.aborted) return undefined;
    if (before.refuse !== undefined) return { answer: before.refuse, texts: [] };
    if (before.hold !== undefined) {
      // Answered with the rule's text instead of running: never clean, so a closing call goes on to a call that reads it (§10.7).
      stint.unclean.add(call.callId);
      this.#ruled(stint, call, before.hold, "hold");
      return { answer: { content: [{ type: "text", text: before.hold.text.trimEnd() }] }, texts: [] };
    }
    const ran = await this.#run(tool, call, ctx);
    if (ctx.signal.aborted) return undefined;
    const after = await gate.after(call, ran, ctx.signal);
    // Whether an answer is clean is the tool's own: what it reported counts though the model reads none of it.
    if (!isClean(ran)) stint.unclean.add(call.callId);
    const reminders = [...before.remind, ...after.remind];
    for (const fired of reminders) this.#ruled(stint, call, fired, "remind");
    return { answer: after.result, texts: reminders.map((fired) => fired.text.trimEnd()) };
  }

  /** Runs the tool. One that throws is answered with the runner's text for it, the error's own words in it. */
  async #run(tool: LoopTool, call: GateCall, ctx: ToolCtx): Promise<LoopToolResult> {
    try {
      return await tool.run(call.args, ctx);
    } catch (error) {
      return this.#failed(tool, error);
    }
  }

  #failed(tool: LoopTool, error: unknown): LoopToolResult {
    const words = error instanceof Error ? error.message : String(error);
    const line = this.#o.texts.failed?.({ tool: tool.name, error: words });
    return { content: line === undefined ? [] : [{ type: "text", text: line }], error: true, details: { error: words } };
  }

  #ruled(stint: Stint, call: GateCall, fired: Fired, action: RuleAction): void {
    if (stint.halt !== undefined) return;
    this.#emit(stint, { kind: "rule_fired", firing: { callId: call.callId, tool: call.tool, ...fired.firing, agent: this.agent, action } });
  }

  #emit(stint: Stint, event: TraceEvent): void {
    this.#o.trace.event(this.agent, stint.parent, event);
  }
}

/** A message to the agent of texts from files, each without the line break its file ends on. */
function userMessage(texts: string[]): UserMessage {
  return { role: "user", content: texts.map((text) => ({ type: "text", text: text.trimEnd() })), timestamp: Date.now() };
}

/** Whether the agent marked the call closing. The raw arguments may carry it as the text "true", which pi's validation turns into the boolean before the call runs; both count, so the trace and the decision agree. */
export function isClosing(args: JsonValue): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  return args[CLOSING] === true || args[CLOSING] === "true";
}

function withoutClosing(args: JsonValue): JsonValue {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const { [CLOSING]: _closing, ...rest } = args;
  return rest;
}

/** A tool's own arguments, by name. */
function argumentsOf(tool: LoopTool): JsonObject {
  const properties = tool.parameters["properties"];
  return typeof properties === "object" && properties !== null && !Array.isArray(properties) ? properties : {};
}

function withClosing(tool: LoopTool, description: string | undefined): JsonSchema {
  return { ...tool.parameters, properties: { ...argumentsOf(tool), [CLOSING]: description === undefined ? { type: "boolean" } : { type: "boolean", description } } };
}

/** Clean: no failure and nothing reported (§10.7). */
function isClean(result: ToolResult): boolean {
  return result.error !== true && (result.reports?.length ?? 0) === 0;
}

function withoutAsk(result: LoopToolResult): ToolResult {
  const { ask: _ask, ...rest } = result;
  return rest;
}

function textOf(message: AssistantMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function thinkingOf(message: AssistantMessage): string {
  return message.content.map((part) => (part.type === "thinking" ? part.thinking : "")).join("");
}

/** A call's tokens as the contract counts them: what was sent includes what the cache read and wrote. */
function usageOf(message: AssistantMessage): Usage {
  const { input, output, cacheRead, cacheWrite, reasoning } = message.usage;
  return { calls: 0, input: input + cacheRead + cacheWrite, cacheRead, cacheWrite, output, ...(reasoning !== undefined ? { reasoning } : {}) };
}

/** The call's settings in pi-ai's terms: temperature by name, the other sampling parameters as given, the longest answer as `maxTokens`. */
function streamSettings(settings: CallSettings): Partial<SimpleStreamOptions> {
  const { temperature, ...rest } = settings.sampling ?? {};
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(Object.keys(rest).length > 0 ? { samplingParams: rest } : {}),
    ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
  };
}

function emptyAnswer(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "aborted",
    timestamp: Date.now(),
  };
}

function endAborted(out: AssistantMessageEventStream, partial: AssistantMessage): void {
  // A provider may share its live blocks and go on writing into them: the aborted message keeps them as they stood.
  const message: AssistantMessage = { ...partial, content: partial.content.map((part) => ({ ...part })), stopReason: "aborted" };
  out.push({ type: "error", reason: "aborted", error: message });
  out.end(message);
}

/**
 * Passes a model's stream on to pi's loop, and ends it the moment the work's signal fires, whatever
 * the provider does: a provider slow to notice can neither keep the run open nor add to it.
 */
async function pump(source: Promise<AssistantMessageEventStream>, out: AssistantMessageEventStream, signal: AbortSignal | undefined, model: Model<Api>): Promise<void> {
  let partial: AssistantMessage | undefined;
  let open = true;
  const abort = (): void => {
    if (!open) return;
    open = false;
    endAborted(out, partial ?? emptyAnswer(model));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted === true) return abort();
    const inner = await source;
    for await (const event of inner) {
      if (!open) return;
      if (event.type === "done" || event.type === "error") {
        open = false;
        out.push(event);
        out.end(event.type === "done" ? event.message : event.error);
        return;
      }
      partial = event.partial;
      out.push(event);
    }
    if (!open) return;
    const message = await inner.result();
    open = false;
    if (message.stopReason === "error" || message.stopReason === "aborted") out.push({ type: "error", reason: message.stopReason, error: message });
    else out.push({ type: "done", reason: message.stopReason === "pending" ? "stop" : message.stopReason, message });
    out.end(message);
  } catch (error) {
    if (!open) return;
    open = false;
    const failed: AssistantMessage = { ...(partial ?? emptyAnswer(model)), stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
    out.push({ type: "error", reason: "error", error: failed });
    out.end(failed);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** The work's result, or undefined when the signal fires first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal === undefined) return work;
  const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
  const onAbort = (): void => resolve(undefined);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  work.then(
    (value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    },
  );
  return promise;
}
