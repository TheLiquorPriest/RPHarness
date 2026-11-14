// The agent runner: one agent on pi's `Agent` (§13.2, §13.3), with what RPH adds around pi's loop.
// Per request: the call's sampling and longest answer, and the user's limits. Per tool: the
// `closing` argument, the call's context, and a stop that does not wait on a tool. Per message: the
// text to the reply as it streams, rules on what is written (stop the call, drop what was not
// shown, go on), and at the moment the work would end, the rules due then as follow-ups. Every
// event goes to the run's trace with the agent and the run it belongs to; after a stop, nothing
// but the agent's end.
import { Agent, type AfterToolCallContext, type AfterToolCallResult, type AgentEvent, type AgentMessage, type AgentTool, type AgentToolResult, type AgentTurnContext, type AgentTurnDecision, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentRef, JsonObject, JsonSchema, JsonValue, LimitHit, ToolCtx, ToolResult, TraceEvent, Usage } from "../contract";
import { addUsage, Budget, emptyUsage } from "./budget";
import type { TextChannel } from "./channel";
import type { Fired, RunEndRules, StreamFired, StreamRules } from "./rules";
import type { ParentCall, RunTrace } from "./trace";
import type { AgentLimits, AgentOutcome, CallRequest, CallSettings, LoopClock, LoopTool, LoopToolResult } from "./types";

/** The argument RPH adds to every tool (§10.7, Appendix A): the agent marks a call that needs no answer. */
export const CLOSING = "closing";

/** Texts the runner sends a model. Each comes from a file. */
export interface RunnerTexts {
  /**
   * `.prompts/continue-after-rule.md`, filled with what the player was shown: the line an agent
   * goes on under after a rule stopped its call. The rule's own text comes just before it.
   */
  continueAfterRule(fields: { shown: string }): string;
  /** How the `closing` argument is described to the model, from the tool guides; absent leaves it undescribed. */
  closing?: string;
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
  /** Where its text goes as it streams, when it writes the reply. */
  channel?: TextChannel;
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
  /** Each tool call's own answer, by call id. */
  readonly results: Map<string, LoopToolResult>;
  /** Calls whose result ended their batch. */
  readonly ended: Set<string>;
  /** Calls that finished before any stop. */
  readonly finished: Set<string>;
  /** Rules on the stream that remind after the message. */
  readonly reminders: StreamFired[];
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
  #calls = 0;
  #stint: Stint | undefined;
  /** The call its last work ended on with a question, until a message answers it. */
  #asked: string | undefined;

  constructor(options: RunnerOptions) {
    this.agent = options.agent;
    this.#o = options;
    this.#clock = options.trace.clock;
    this.#budget = new Budget("agent", options.limits ?? {});
    this.#pi = new Agent({
      initialState: {
        ...(options.instructions !== undefined ? { systemPrompt: options.instructions } : {}),
        model: options.model,
        ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
        tools: (options.tools ?? []).map((tool) => this.#piTool(tool)),
        messages: options.messages ?? [],
      },
      streamFn: (model, context, streamOptions) => this.#call(model, context, streamOptions),
      afterToolCall: (context) => this.#afterTool(context),
      finishTurn: (turn) => this.#finishTurn(turn),
      // Every rule due at one moment goes in with the same call.
      followUpMode: "all",
      steeringMode: "all",
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
      results: new Map(),
      ended: new Set(),
      finished: new Set(),
      reminders: [],
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

  async #drive(stint: Stint, first: () => Promise<void>): Promise<void> {
    let next: (() => Promise<void>) | undefined = first;
    let failure: string | undefined;
    while (next !== undefined) {
      try {
        await next();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
      next = undefined;
      const cut = stint.cut;
      if (cut !== undefined && stint.halt === undefined) {
        // The call a rule stopped leaves no trace in the transcript; the agent goes on under the
        // rule's text and the line that says where the player's view ends (§5.4).
        stint.cut = undefined;
        this.#dropAborted();
        const shown = this.#o.channel?.tail() ?? "";
        const content = [cut.text, this.#o.texts.continueAfterRule({ shown })];
        next = () => this.#pi.prompt(userMessage(content));
      }
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
    else if (failed) outcome = { ...base, status: "failed", error: failure ?? last?.errorMessage ?? "" };
    else if (stint.asked !== undefined) {
      outcome = { ...base, status: "asked", question: stint.asked.question };
      this.#asked = stint.asked.call;
    } else outcome = { ...base, status: "done" };
    this.#stint = undefined;
    this.#emit(stint, { kind: "agent_ended", status: outcome.status, ...(outcome.limit !== undefined ? { limit: outcome.limit } : {}), usage: stint.usage });
    stint.resolve(outcome);
  }

  #halt(stint: Stint, halt: Halt): void {
    if (this.#stint !== stint || stint.halt !== undefined) return;
    stint.halt = halt;
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
    this.#o.channel?.begin();
    this.#emit(stint, {
      kind: "call_started",
      call: this.#calls,
      connection: this.#o.connection,
      model: model.id,
      ...(settings.sampling !== undefined ? { sampling: settings.sampling } : {}),
      ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
      messages: context.messages.length,
      tools: this.#pi.state.tools.length,
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
        if (message.role !== "assistant") return;
        const used = usageOf(message);
        addUsage(stint.usage, used);
        this.#budget.count(used);
        this.#o.turn?.count(used);
        if (stint.halt !== undefined) return;
        if (stint.cut === undefined) {
          stint.last = message;
          this.#o.channel?.end(message);
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
        return;
      }
      case "tool_execution_start": {
        if (stint.halt !== undefined) return;
        const args = event.args as JsonValue;
        this.#emit(stint, { kind: "tool_started", callId: event.toolCallId, tool: event.toolName, args: withoutClosing(args), closing: isClosing(args) });
        return;
      }
      case "tool_execution_end": {
        if (stint.halt !== undefined) return;
        stint.finished.add(event.toolCallId);
        const own = stint.results.get(event.toolCallId);
        // A result pi made itself (an unknown tool, arguments that did not validate) is pi's AgentToolResult; pi types the event's field loosely.
        const made: AgentToolResult = event.result;
        const result: ToolResult = own !== undefined ? withoutAsk(own) : { content: made.content, ...(event.isError ? { error: true as const } : {}) };
        this.#emit(stint, { kind: "tool_ended", callId: event.toolCallId, tool: event.toolName, result, clean: !event.isError && isClean(result), endedRun: stint.ended.has(event.toolCallId), ms: event.durationMs ?? 0 });
        return;
      }
      default:
        return;
    }
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
    if (isClosing(context.args as JsonValue) && !context.isError && result !== undefined && isClean(result)) {
      stint.ended.add(id);
      return { terminate: true };
    }
    return undefined;
  }

  async #finishTurn(turn: AgentTurnContext): Promise<AgentTurnDecision | undefined> {
    const stint = this.#stint;
    if (stint === undefined) return undefined;
    const { message } = turn;
    if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
    if (stint.halt !== undefined || stint.asked !== undefined) return { action: "end" };
    const reminders = stint.reminders.splice(0);
    if (!turn.toolResults.every((result) => stint.ended.has(result.toolCallId))) {
      // The work goes on anyway: a reminder goes in with the next call.
      for (const fired of reminders) this.#add(stint, fired, "remind", "steer");
      return undefined;
    }
    // The work would end here. What is due at a run's end goes in as a follow-up, and the agent
    // gets one more call.
    const due = (await this.#o.runEnd?.due({ agent: this.agent, call: this.#calls })) ?? [];
    if (stint.halt !== undefined) return { action: "end" };
    for (const fired of reminders) this.#add(stint, fired, "remind", "follow-up");
    for (const fired of due) this.#add(stint, fired, "follow-up", "follow-up");
    return undefined;
  }

  #add(stint: Stint, fired: Fired, action: "remind" | "follow-up", how: "steer" | "follow-up"): void {
    const message = userMessage([fired.text]);
    if (how === "steer") this.#pi.steer(message);
    else this.#pi.followUp(message);
    this.#emit(stint, { kind: "rule_fired", firing: { ...fired.firing, agent: this.agent, action } });
  }

  /**
   * After a stop or a failure: a message cut short or failed, and a step whose calls did not all
   * finish, leave the transcript, so the agent can be continued as it stands and its session never
   * keeps half a step. (pi-ai would skip such a message and invent results for unanswered calls,
   * in its own words; this way it never has to.)
   */
  #settle(stint: Stint): void {
    const messages = this.#pi.state.messages.slice();
    for (let last = messages.at(-1); messages.length > stint.from && last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error"); last = messages.at(-1)) {
      messages.pop();
    }
    for (let at = messages.length - 1; at >= stint.from; at -= 1) {
      const message = messages[at];
      if (message?.role !== "assistant") continue;
      if (message.content.some((part) => part.type === "toolCall" && !stint.finished.has(part.id))) messages.splice(at);
      break;
    }
    this.#pi.state.messages = messages;
  }

  /** After a rule stopped a call: the message it cut short leaves the transcript. */
  #dropAborted(): void {
    const messages = this.#pi.state.messages;
    const last = messages.at(-1);
    if (last?.role === "assistant" && last.stopReason === "aborted") this.#pi.state.messages = messages.slice(0, -1);
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
        if (stint === undefined) throw new Error(`Tool ${tool.name} was called while agent ${this.agent.id} was not working.`);
        let answered = false;
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
        // pi waits on a tool until it settles; a stop does not.
        const result = await untilAborted(tool.run(withoutClosing(params as JsonValue), ctx), signal);
        answered = true;
        if (result === undefined) return { content: [], details: undefined };
        stint.results.set(callId, result);
        // A report is shown to the model after the call's content, one line each.
        const reports = (result.reports ?? []).map((line) => ({ type: "text" as const, text: line }));
        return { content: [...result.content, ...reports], details: result.details, ...(result.error === true ? { isError: true } : {}) };
      },
    };
  }

  #emit(stint: Stint, event: TraceEvent): void {
    this.#o.trace.event(this.agent, stint.parent, event);
  }
}

function userMessage(texts: string[]): UserMessage {
  return { role: "user", content: texts.map((text) => ({ type: "text", text })), timestamp: Date.now() };
}

/** Whether the agent marked the call closing. The raw arguments may carry it as the text "true", which pi's validation turns into the boolean before the call runs; both count, so the trace and the decision agree. */
function isClosing(args: JsonValue): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  return args[CLOSING] === true || args[CLOSING] === "true";
}

function withoutClosing(args: JsonValue): JsonValue {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const { [CLOSING]: _closing, ...rest } = args;
  return rest;
}

function withClosing(tool: LoopTool, description: string | undefined): JsonSchema {
  const properties = tool.parameters["properties"];
  const own: JsonObject = typeof properties === "object" && properties !== null && !Array.isArray(properties) ? properties : {};
  if (CLOSING in own) throw new Error(`Tool ${tool.name} has an argument named "${CLOSING}", which RPH adds to every tool.`);
  return { ...tool.parameters, properties: { ...own, [CLOSING]: description === undefined ? { type: "boolean" } : { type: "boolean", description } } };
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
