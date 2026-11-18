// The agent runner: one agent on pi's `Agent` (§13.2, §13.3), with what RPH adds around pi's loop.
// Per request, in pi's request hook (`prepareRequest`): the run's point before it, which may put
// something in place of part of what the request carries, and is asked again when the provider
// refuses the call as too long (§11); the request's context, the same for every request of the work
// (§10.2): the opening block with the agent's tools, the run's fixed context (a lead's prompt, what
// its session carries and its briefing; a sub-agent's or a job's brief), then the agent's own work,
// which alone is pi's transcript; and the call's model, effort, sampling and longest answer, decided
// for that request alone. Also per request: the user's limits, and the agent's session, which pi
// hands every request so the provider's cache knows it. Per tool call, at the moments pi
// offers for them (§13.3): in `beforeToolCall`, the run's limits (no tool starts once one is
// reached, and the work ends at it) and the gate (the host's switches, the user's permission and
// word, the rules on the arguments), whose refusal or hold pi gives as the call's answer in the
// tool's place; in `afterToolCall`, the rules on the result, the bound on what the model reads of the
// call, and whether a question ends the work. A tool found through `tool_use` goes through the
// same two hooks under its own name (`runAs`, by pi's `runToolCall`). A stop waits neither on a tool
// nor on the gate. Per message: the text to the reply as it streams, rules on what is written (stop
// the call, drop what was not shown, go on), the moment each tool call began to be written, and at
// the moment the work would end, the rules due then as follow-ups. A message that makes no tool call
// ends the work, unless a rule is due then. A call that failed is made again where trying again can
// help, as the settings say: what the broken call produced leaves the transcript, and the next try
// goes on from the end of what the player was shown. Every event goes to the
// run's trace with the agent and the run it belongs to, and every time the runner writes is the
// host's clock's; after a stop, nothing but the agent's end.
//
// No text reaches a model that did not come from a file or from the request: where pi would answer a
// call in its own words (a tool it does not know, arguments that do not fit or are not JSON,
// arguments cut short by the length limit, a call its hook blocked, a tool or the gate that threw),
// the call is answered with the runner's texts or the gate's instead, which the harness reads from
// files. A text the file does not have leaves the answer empty.
import { Agent, runToolCall, type AfterToolCallContext, type AfterToolCallResult, type AgentEvent, type AgentMessage, type AgentRequestUpdate, type AgentTool, type AgentToolResult, type AgentTurnContext, type AgentTurnDecision, type BeforeToolCallContext, type BeforeToolCallResult, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, createInitialSystemMessage, getCurrentTools, isContextOverflow, toToolDeclaration, type Api, type AssistantMessage, type AssistantMessageEventStream, type Message, type Model, type SimpleStreamOptions, type SystemMessage, type TextContent, type ToolCall, type ToolResultMessage, type TranscriptContext, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentRef, CallBreakPoint, CallFailureKind, CallPermission, CallRefusal, Effort, JsonSchema, JsonValue, LimitHit, RuleAction, ToolContent, ToolCtx, ToolResult, TraceEvent, Usage } from "../contract";
import { failureOf, retried, retryWait, type FailureFacts } from "../model/failure";
import type { LayerOptions } from "../model/source";
import { estimateOf, type ProviderCount, requestTokens, tokensOf } from "../model/tokens";
import { addUsage, Budget, countLimit, emptyUsage, type Left, type Room } from "./budget";
import { PlaceLine } from "./line";
import type { ChannelMarks, TextChannel } from "./channel";
import type { Fired, Judged, Judgment, QuestionRules, RunEndRules, StreamFired, StreamRules } from "./rules";
import { fit, type Misfit } from "./fit";
import type { ParentCall, RunTrace } from "./trace";
import type { AgentLimits, AgentOutcome, Bounded, CallRequest, CallSettings, CallTerms, GateAfter, GateBefore, GateCall, KeepRequest, LoopClock, LoopTool, LoopToolResult, PendingRequest, RequestPoint, RequestSpan, RunHold, ToolGate } from "./types";

/** Texts the runner sends a model. Each comes from a file; one that gives undefined leaves its answer empty. */
export interface RunnerTexts {
  /**
   * `.prompts/continue-after-rule.md`, filled with what the player was shown (`shown`, empty where
   * nothing was) and how the reply is marked on the agent's connection (`form`, and in the tag form
   * `tags`): the line an agent goes on under after a rule stopped its call. The rule's own text comes
   * just before it.
   */
  continueAfterRule(fields: { shown: string } & Partial<ChannelMarks>): string;
  /**
   * `.prompts/continue-after-break.md`, filled as `continueAfterRule` is: the line an agent goes on
   * under when a call to its model broke off once the player had been shown some of the reply, and
   * the call is made again. Absent or empty, the call is made again as it was.
   */
  continueAfterBreak?(fields: { shown: string } & Partial<ChannelMarks>): string;
  /** The answer to a call of a tool the agent does not hold. */
  notFound?(fields: { tool: string }): string | undefined;
  /**
   * The answer to a call whose arguments do not fit what its tool takes: what was sent, and the
   * tool's parameters, both as JSON, and each argument that did not fit and why, as pi's check found
   * them. `unparsed`: what was sent was not JSON at all (`arguments` is then the text as sent), so
   * nothing of it could be checked and no argument is named.
   */
  invalid?(fields: { tool: string; arguments: string; parameters: string; misfits: Misfit[]; unparsed?: true }): string | undefined;
  /** The answer to a call in a message that hit its length limit, whose arguments may be cut short. */
  cutShort?(fields: { tool: string }): string | undefined;
  /** The answer to a call whose tool threw. The error's own words go to the trace, never to a model. */
  failed?(fields: { tool: string }): string | undefined;
  /** The answer to a call the work stopped before it finished (a stop, or a limit), kept so the agent can be continued: it may have done its work, or not. */
  unfinished?(fields: { tool: string }): string | undefined;
  /** The answer to a call a spent limit kept from starting (R-194): it never started. */
  notStarted?(fields: { tool: string }): string | undefined;
  /** The answer to a call past the count of tool calls one answer may make (`limits.toolsPerAnswer`): it is not run. */
  pastAnswerCount?(fields: { tool: string; max: number }): string | undefined;
  /** The answer to an `agent_message` past the sub-agent's count of messages after its first answer (`limits.messages`): it is not run. */
  pastMessageCount?(fields: { agent: string; max: number }): string | undefined;
  /** What the owner said to the run's main agent, as the agent is given it: his words marked as his. Absent, the words go in bare. */
  said?(fields: { words: string }): string | undefined;
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
  /**
   * Its own session (§13.4): for the trace, and on every request it makes, so the provider's cache
   * knows the session (OpenAI's prompt cache key; Anthropic's message threads where a connection
   * turns them on, let go when the model layer is told the session ended, `ModelLayer.ended`).
   */
  session: string;
  /** The effort each request is made with, where its settings give none. */
  thinkingLevel?: ThinkingLevel;
  /** The level its effort is set to (its definition's, a setting's or its connection's), which its model is sent, or the nearest it has (`thinkingLevel`) where it has none so high: for the record. */
  effortSet?: Effort;
  /** Its instructions, as its definition and the files it reads give them: with its tools, the opening block every request carries first. */
  instructions?: string;
  /**
   * The run's fixed context (§10.2), which every request carries right after the opening block and
   * ahead of the agent's own work: a lead's prompt, what its session carries and its briefing; a
   * sub-agent's or a job's brief. The same for every request of its work, but where the run's point
   * puts something in place of part of it.
   */
  context?: AgentMessage[];
  tools?: LoopTool[];
  /** The size of its fixed list as declared, in tokens, and the user's `tools.fixedTokens`, which its start record says (a lead's). */
  listSize?: { tokens: number; most: number };
  texts: RunnerTexts;
  /** The model, effort, sampling and longest answer of each model call, decided before that request alone. */
  settings?(request: CallRequest): CallSettings | undefined;
  /** The run's point before each request (§11). None: each request goes out as set, and nothing waits. */
  point?: RequestPoint;
  /** Its own limits, counted afresh for each stretch of its work (each a `delegate` or an `agent_message` starts); the run's limits (`turn`) count over all of them. */
  limits?: AgentLimits;
  /** The budget it counts against besides its own: its turn's or its job's, with every budget above that one. */
  turn?: Budget;
  /** How its calls' tokens are estimated, the least room an answer is given, and its definition's own sampling. */
  terms: CallTerms;
  stream?: StreamRules;
  runEnd?: RunEndRules;
  /** The rules `at: after-message`, asked after each message that made tool calls: their texts go in with the next call. */
  afterMessage?: RunEndRules;
  /** The `question:` rules, put to a judging model about each message it finishes. */
  questions?: QuestionRules;
  /** What is asked around each of its tool calls: permissions, rules, the bound on what the model reads. None: each call simply runs. */
  gate?: ToolGate;
  /** Where its text goes as it streams, when it writes the reply. */
  channel?: TextChannel;
  /** Keeps what its calls are sent, where the user's setting asks for it; none keeps nothing. */
  keep?: KeepRequest;
  /**
   * What of its opening block no longer stands, in the words it is told it (§5.2, R-128): asked
   * before each request once it has made a call. When that is something other than it last said, it
   * goes into the agent's work as a message, so an agent that goes on past an edit (a job's agent, a
   * sub-agent continued) is told the file's new text in its next message, as the lead is in its next
   * briefing.
   */
  changed?(): Promise<string>;
  /** A judging model's run (§5.4): the question rule it answers and the agent whose message it judges, which its start record names. */
  judges?: { rule: string; agent: string };
  /**
   * His hooks at the moment the work would end (§5.4 "Hooks", §13.3 l.1458), asked once a stretch:
   * a hook's block gives its reason, which goes in as a follow-up, and the agent gets one more call
   * under its limits. None: nothing is asked.
   */
  atRunEnd?(): Promise<string | undefined>;
}

export type WorkInput =
  /** Messages a run's first work starts from, as its own: each request carries them after the run's fixed context. None where that context is all the agent is given. */
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
  /** The transcript's length when it began: its own messages come after. What the run's point puts in place before them moves it. */
  from: number;
  readonly startedAt: number;
  readonly usage: Usage;
  readonly resolve: (outcome: AgentOutcome) => void;
  halt?: Halt;
  /** A rule that stopped the call in flight. */
  cut?: StreamFired;
  callText: string;
  callThinking: string;
  callStartedAt: number;
  /** What the call under way was sent: the request a provider's count of it is a count of. */
  callSent: readonly Message[];
  /** The limit on one call's time, while the call is under way. */
  callTimer?: unknown;
  /** Tokens of what the model reads of this batch's calls, not yet in the transcript, by call id. */
  readonly reading: Map<string, number>;
  /** The transcript's length when the call under way began: a message a rule stops is cut back to it. */
  callFrom: number;
  /**
   * A call this runner started is open. pi also ends every message it is given to start from (an
   * earlier reply in the prompt, a prefilled start), with the same event as a model's answer; only
   * the answer to an open call is a call's end.
   */
  calling: boolean;
  /** When the model began writing each tool call of the call under way (pi's `toolcall_start`), by the call's place in the message. */
  readonly writing: Map<number, number>;
  /** The permission each call of a write or external tool ran under, by call id, for the record of its end. */
  readonly permissions: Map<string, CallPermission>;
  /** Why each call that never ran did not, by call id, for the record of its end (C1's note). */
  readonly refusals: Map<string, CallRefusal>;
  /** Calls pi answered in its own words, reworded by the runner and waiting to be held to the bound before the next request (`#finishTurn`), by call id. */
  readonly reworded: Map<string, { tool: string; made: AgentToolResult; ms: number }>;
  /** The rules on each call's arguments that remind, by call id: their texts come back with its answer. */
  readonly argued: Map<string, Fired[]>;
  /** Each tool's own answer as it ran, by call id, until the hook after it takes it. */
  readonly ran: Map<string, LoopToolResult>;
  /** Each call's answer as it is kept, by call id: what the gate gave (the bound applied), for the trace. */
  readonly results: Map<string, LoopToolResult>;
  /** What the model reads of a call answered in its tool's place (a refusal, a hold), by call id: what pi's answer for a blocked call is given instead of its own words. */
  readonly read: Map<string, ToolContent[]>;
  /**
   * Calls that are never clean, whatever their answer now shows: a rule added its text to them or
   * answered instead of the tool, or the tool reported something the bound on what the model reads
   * left out.
   */
  readonly unclean: Set<string>;
  /** The calls of the answer under way so far, its found tools left out: the count `limits.toolsPerAnswer` holds. */
  answerCalls: number;
  /** Calls whose result ended the agent's work: a question. */
  readonly ended: Set<string>;
  /** Calls that finished before any stop. */
  readonly finished: Set<string>;
  /** Rules on the stream that remind after the message. */
  readonly reminders: StreamFired[];
  /** A carrier's calls (`tool_use`) as they began, by call id: its own arguments, traced only if it carries no tool. */
  readonly carried: Map<string, { args: JsonValue }>;
  /** A call's arguments as a hook before it changed them (§5.4 "Hooks"), by call id: the tool runs with them where they still fit its schema. */
  readonly changed: Map<string, JsonValue>;
  /** The tool each carrier's call ran as itself (`runAs`), by the carrier's call id. */
  readonly ranAs: Map<string, string>;
  /** Questions put to the judging model about its messages, still unanswered. */
  readonly judging: Set<Judgment>;
  /** Rules a judging model's answer fired, to go in front of the agent at the end of the step under way. */
  readonly judged: Judged[];
  /** Settles when the work stops or reaches a limit, so nothing it waits for outlasts it. */
  readonly halted: PromiseWithResolvers<void>;
  /** Aborts when the work stops or reaches a limit, so what the run's point awaits ends with it. */
  readonly stopped: AbortController;
  /** How many calls in a row the provider refused as too long and went out again. */
  resent: number;
  /** How many times in a row a call that failed was made again: an answer that ends whole ends the row. */
  retried: number;
  /** What the model layer knew of the call under way's failure (`call_facts`), until the run sorts it. */
  facts?: FailureFacts;
  /** How much of the reply had been shown when the call under way began. */
  shownAt: number;
  /** What broke the call the work ended on, failed, and how many times that call was made. */
  broke?: { failure: CallFailureKind; tries: number };
  /** Its hooks at the work's end were asked this stretch. */
  hooked: boolean;
  /**
   * What failed in the harness inside pi's loop before a request went out (the run's point, the
   * call's settings). pi ends its loop on the throw with an answer of its own, which is no call's.
   */
  failure?: string;
  asked?: { call: string; question: JsonValue };
  last?: AssistantMessage;
  timer?: unknown;
}

export class AgentRunner {
  readonly agent: AgentRef;
  readonly #o: RunnerOptions;
  readonly #pi: Agent;
  readonly #clock: LoopClock;
  /** Its own limits' count, for the stretch of work under way (or the next). */
  #budget: Budget;
  /** Where an answer's tool calls wait for a place past its tool calls at once (`limits.toolsAtOnce`); none: all run at once. */
  readonly #line: PlaceLine | undefined;
  /** The last tool call it made and how many times in a row, with the run's writes when it was made: the loop's count (`limits.repeats`). */
  #last: { key: string; writes: number; count: number } | undefined;
  /** Its tools by name, as the model was told them. */
  readonly #tools = new Map<string, AgentTool<JsonSchema, JsonValue | undefined>>();
  /** Its tools that carry a call of another tool (`LoopTool.carrier`). */
  readonly #carriers = new Set<string>();
  /** The opening block every request carries first: its instructions, and its tools as the model is told them (none when it has neither). The run's point never touches it (R-119). */
  readonly #opening: SystemMessage | undefined;
  /** The run's fixed context (`RunnerOptions.context`), as the run's point last left it. */
  readonly #context: AgentMessage[];
  /** What `changed` last said: the same is not told twice. */
  #told = "";
  /** The settings decided for the request being prepared, which its call goes out with. */
  #settings: CallSettings = {};
  /** The provider's count of the last request it counted: an estimate of a later request starts from it. */
  #counted: ProviderCount | undefined;
  /** What the provider held in its cache of the last request it counted (read again, or written for later): the next request, which begins with it, likely reads that much again. */
  #cachedLast = 0;
  #calls = 0;
  #stint: Stint | undefined;
  /** The call its last work ended on with a question, until a message answers it. */
  #asked: string | undefined;

  constructor(options: RunnerOptions) {
    this.agent = options.agent;
    this.#o = options;
    this.#clock = options.trace.clock;
    this.#budget = this.#ownBudget();
    const atOnce = options.limits?.toolsAtOnce ?? options.terms.toolsAtOnce;
    this.#line = atOnce !== undefined ? new PlaceLine(atOnce) : undefined;
    for (const tool of options.tools ?? []) {
      this.#tools.set(tool.name, this.#piTool(tool, true));
      if (tool.carrier === true) this.#carriers.add(tool.name);
    }
    this.#opening = createInitialSystemMessage(options.instructions, [...this.#tools.values()].map(toToolDeclaration));
    this.#context = [...(options.context ?? [])];
    // Its opening block, its tools and the run's fixed context go with each request from pi's request
    // hook (`#prepare`), never through pi's state: pi's transcript holds only the agent's own work, and
    // pi declares no tool into it.
    this.#pi = new Agent({
      initialState: {
        model: options.model,
        ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
      },
      prepareRequest: () => this.#prepare(),
      streamFn: (model, context, streamOptions) => this.#call(model, context, streamOptions),
      // The session goes with every request, so the provider's cache knows it (§13.3).
      sessionId: options.session,
      beforeToolCall: (context, signal) => this.#beforeTool(context, signal),
      afterToolCall: (context, signal) => this.#afterTool(context, signal),
      finishTurn: (turn) => this.#finishTurn(turn),
      // Every rule due at one moment goes in with the same call.
      followUpMode: "all",
      steeringMode: "all",
      // pi's loop names itself to providers by default (OpenRouter's attribution headers); RPH's calls go out as the user's own.
      identity: { attribution: null },
    });
    this.#pi.subscribe((event) => this.#onEvent(event));
  }

  /** What is left under its own limits on calls, tool rounds and tokens (the fact `limits.left`): none where it has none. */
  left(): Left {
    return this.#budget.left();
  }

  /** Whether it is working now. */
  get working(): boolean {
    return this.#stint !== undefined;
  }

  /** Whether its last work ended with a question that no message has answered yet. */
  get asking(): boolean {
    return this.#asked !== undefined;
  }

  /** Its own work as it stands: pi's transcript, which holds neither the opening block nor the run's fixed context. */
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
        const message = this.#message([input.message]);
        first = () => this.#pi.prompt(message);
      }
    } else {
      if (this.#asked !== undefined) throw new Error(`Agent ${this.agent.id} is waiting for the answer to its question; continue it with a message.`);
      first = () => this.#pi.prompt(input.messages);
    }
    this.#asked = undefined;
    // Its own limits count per stretch of work, the run's over all of them (§13.4): a sub-agent continued has its own calls again.
    this.#budget = this.#ownBudget();
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
      callSent: [],
      reading: new Map(),
      callFrom: 0,
      calling: false,
      writing: new Map(),
      permissions: new Map(),
      refusals: new Map(),
      reworded: new Map(),
      argued: new Map(),
      ran: new Map(),
      results: new Map(),
      read: new Map(),
      unclean: new Set(),
      answerCalls: 0,
      ended: new Set(),
      finished: new Set(),
      reminders: [],
      carried: new Map(),
      changed: new Map(),
      ranAs: new Map(),
      judging: new Set(),
      judged: [],
      halted: Promise.withResolvers<void>(),
      stopped: new AbortController(),
      resent: 0,
      retried: 0,
      shownAt: 0,
      hooked: false,
    };
    this.#stint = stint;
    const effort = this.#pi.state.thinkingLevel;
    this.#emit(stint, { kind: "agent_started", definition: this.agent.definition, connection: this.#o.connection, model: this.#pi.state.model.id, effort, ...(this.#o.effortSet !== undefined ? { set: this.#o.effortSet } : {}), session: this.#o.session, given: options.given ?? [], ...(this.#o.listSize !== undefined ? { tools: this.#o.listSize } : {}), ...(this.#o.judges !== undefined ? { judges: this.#o.judges } : {}) });
    const time = this.#o.limits?.time;
    if (time !== undefined) {
      stint.timer = this.#clock.setTimeout(() => {
        this.#halt(stint, { status: "limit", hit: { limit: "time", per: "agent", max: time, value: this.#clock.now() - stint.startedAt, agent: this.agent } });
      }, time);
    }
    void this.#drive(stint, first);
    return { done: promise, stop: () => this.#halt(stint, { status: "stopped" }) };
  }

  /** A fresh count of its own limits, counted into the run's budget too. */
  #ownBudget(): Budget {
    const o = this.#o;
    return new Budget("agent", o.limits ?? {}, o.turn, o.terms.cachedWeight !== undefined ? { cachedWeight: o.terms.cachedWeight } : {});
  }

  /** A message for the agent while it works, from a file or his own hooks: it goes in with its next call. False where it is not working. */
  tell(text: string): boolean {
    if (this.#stint === undefined || this.#stint.halt !== undefined) return false;
    this.#pi.steer(this.#message([text]));
    return true;
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
      failure ??= stint.failure;
      next = undefined;
      const cut = stint.cut;
      if (cut === undefined) {
        try {
          if (failure === undefined && stint.halt === undefined) next = (await this.#retry(stint)) ?? (await this.#resend(stint));
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        continue;
      }
      // The call a rule stopped leaves no trace in the transcript, whatever the provider had sent
      // before pi's loop read the match: its words, its calls, and pi's answers to them.
      stint.cut = undefined;
      this.#pi.state.messages = this.#pi.state.messages.slice(0, stint.callFrom);
      if (stint.halt !== undefined || failure !== undefined) continue;
      // The agent goes on under the rule's text and the line that says where the player's view ends (§5.4).
      const shown = this.#o.channel?.tail() ?? "";
      const goOn = this.#o.texts.continueAfterRule({ shown, ...this.#o.channel?.marks });
      const message = this.#message(goOn === "" ? [cut.text] : [cut.text, goOn]);
      next = () => this.#pi.prompt(message);
    }
    this.#finish(stint, failure);
  }

  #finish(stint: Stint, failure: string | undefined): void {
    if (stint.timer !== undefined) this.#clock.clearTimeout(stint.timer);
    if (stint.callTimer !== undefined) this.#clock.clearTimeout(stint.callTimer);
    // pi's own words for calls the work ended before their step finished: recorded as they are.
    for (const [id, { tool, made, ms }] of stint.reworded) this.#ended(stint, id, tool, made, true, ms);
    stint.reworded.clear();
    const last = stint.last;
    const failed = stint.halt === undefined && (failure !== undefined || last === undefined || last.stopReason === "error");
    if (stint.halt !== undefined || failed) this.#settle(stint);
    // A message its provider broke off in the middle of is no answer: none of it is the outcome's text.
    const base = { agent: this.agent, usage: stint.usage, text: last !== undefined && stint.halt === undefined && last.stopReason !== "error" ? textOf(last) : "" };
    let outcome: AgentOutcome;
    const worked = { tools: stint.finished.size, wrote: last !== undefined && last.stopReason !== "error" ? textOf(last) : "" };
    if (stint.halt?.status === "limit") outcome = { ...base, status: "limit", limit: stint.halt.hit, worked };
    else if (stint.halt !== undefined) outcome = { ...base, status: "stopped", worked };
    else if (failed) outcome = { ...base, status: "failed", error: failure ?? last?.errorMessage ?? "", failure: failure !== undefined ? "harness" : "model", ...(failure === undefined && stint.broke !== undefined ? { broke: stint.broke } : {}) };
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
    stint.stopped.abort();
    if (halt.status === "limit") this.#emit(stint, { kind: "limit", hit: halt.hit });
    this.#o.channel?.cut();
    this.#pi.abort();
  }

  /**
   * What a call spent, as its provider counted it. A call stopped part-way (a rule's cut, a stop, a
   * limit) or broken off by its provider most often has no count from its provider, which sends one at the answer's end: where
   * something of its answer came back, what it was sent and what it wrote are estimated as every
   * request's tokens are, so the run, its limits and the user's day book what it spent.
   */
  #spent(stint: Stint, message: AssistantMessage): Usage {
    const used = usageOf(message);
    if ((message.stopReason !== "aborted" && message.stopReason !== "error") || message.content.length === 0) return used;
    const ratio = this.#o.terms.charsPerToken;
    if (used.input === 0) used.input = requestTokens(stint.callSent, ratio, this.#counted);
    if (used.output === 0) {
      const written = estimateOf([], message, ratio);
      used.output = written.out + written.reasoningOut;
      if (written.reasoningOut > 0) used.reasoning = written.reasoningOut;
    }
    return used;
  }

  /**
   * pi's request hook, before every request (§13.3): the run's point first, where it has one; then
   * the request's context, the same for every request of the work (the opening block, the run's fixed
   * context, the agent's own work), and the call's model, effort, sampling and longest answer,
   * decided for this request alone.
   */
  async #prepare(): Promise<AgentRequestUpdate> {
    const stint = this.#stint;
    try {
      const hold = this.#o.trace.hold;
      if (stint !== undefined && hold !== undefined && stint.halt === undefined) await this.#held(stint, hold);
      const changed = this.#o.changed;
      if (stint !== undefined && changed !== undefined && stint.halt === undefined && this.#calls > 0) await this.#tellChanged(changed);
      const point = this.#o.point;
      if (stint !== undefined && point !== undefined && stint.halt === undefined) await this.#atPoint(stint, point, undefined);
      // The rules on what it writes, as the files stand at the start of this call.
      await this.#o.stream?.fresh?.();
      const settings = this.#o.settings?.({ agent: this.agent, call: this.#calls + 1, model: this.#o.model.id }) ?? {};
      this.#settings = settings;
      return { context: { messages: this.#request(), tools: [...this.#tools.values()] }, model: settings.model ?? this.#o.model, thinkingLevel: settings.effort ?? this.#o.thinkingLevel ?? "off" };
    } catch (error) {
      if (stint !== undefined) stint.failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * The owner's hand on the run (§14, C-19), before each request: the agent waits here while the run
   * is held, and takes in what the owner said to it as his words. A stop ends the wait and the work
   * with it.
   */
  async #held(stint: Stint, hold: RunHold): Promise<void> {
    const call = this.#calls + 1;
    if (hold.held) {
      const since = this.#clock.now();
      this.#emit(stint, { kind: "paused", call });
      await hold.until(stint.stopped.signal);
      if (stint.halt !== undefined) return;
      this.#emit(stint, { kind: "resumed", call, ms: this.#clock.now() - since });
    }
    for (const words of hold.said(this.agent)) {
      this.#emit(stint, { kind: "said", call, text: words });
      this.#pi.state.messages = [...this.#pi.state.messages, this.#message([this.#o.texts.said?.({ words }) ?? words])];
    }
  }

  /** What of its opening block no longer stands, when it is news: a message in its work. */
  async #tellChanged(changed: () => Promise<string>): Promise<void> {
    const text = await changed();
    if (text === this.#told) return;
    this.#told = text;
    if (text !== "") this.#pi.state.messages = [...this.#pi.state.messages, this.#message([text])];
  }

  /** The request as it would go now: the opening block, the run's fixed context, then the agent's own work. */
  #request(): AgentMessage[] {
    return [...(this.#opening !== undefined ? [this.#opening] : []), ...this.#context, ...this.#pi.state.messages];
  }

  /**
   * Asks the run's point about the request as it would go now (§11), with the provider's words when
   * it refused the call as too long, and puts in place what the point gives. A stop does not wait on
   * it. Whether anything was put in place.
   */
  async #atPoint(stint: Stint, point: RequestPoint, refused: string | undefined): Promise<boolean> {
    const messages = this.#request();
    const from = this.#opening !== undefined ? 1 : 0;
    const to = from + this.#context.length;
    const request: PendingRequest = {
      agent: this.agent,
      call: this.#calls + 1,
      messages,
      context: { from, to },
      window: point.window,
      reserve: point.reserve,
      // The model layer's own estimate of a whole request, the tools its opening block declares included.
      tokens: requestTokens(messages, this.#o.terms.charsPerToken, this.#counted),
      ...(refused !== undefined ? { refused } : {}),
      signal: stint.stopped.signal,
    };
    const spans = await untilAborted(Promise.resolve(point.check(request)), stint.stopped.signal);
    if (spans === undefined || spans.length === 0 || stint.halt !== undefined) return false;
    this.#apply(stint, spans, messages, from, to);
    return true;
  }

  /**
   * Puts in place the spans the run's point gave, each over the request it was shown (`messages`,
   * whose fixed context runs from `from` up to `to`): one in the fixed context replaces messages of
   * it; one in the agent's own work replaces messages of pi's transcript. What is put in place holds
   * for every later request. A span that reaches the opening block (R-119) or past the request,
   * crosses from the fixed context into the agent's own work, overlaps another, or parts a tool call
   * from its result puts nothing in place: the work fails on it.
   */
  #apply(stint: Stint, spans: readonly RequestSpan[], messages: readonly AgentMessage[], from: number, to: number): void {
    const ordered = [...spans].sort((a, b) => b.from - a.from);
    let end = messages.length;
    for (const span of ordered) {
      const where = `${span.from} to ${span.to}`;
      if (!Number.isInteger(span.from) || !Number.isInteger(span.to) || span.from < from || span.from > span.to || span.to > end) throw new Error(`The run's point gave a span outside the request, over its opening block, or over another span: ${where}.`);
      if (span.from < to && span.to > to) throw new Error(`The run's point gave a span that crosses from the fixed context into the agent's own work: ${where}.`);
      if (span.to > to && partsCall(messages, span.from, span.to)) throw new Error(`The run's point gave a span that parts a tool call from its result: ${where}.`);
      end = span.from;
    }
    const work = this.#pi.state.messages.slice();
    for (const span of ordered) {
      if (span.to <= to) {
        this.#context.splice(span.from - from, span.to - span.from, ...span.messages);
        continue;
      }
      const at = span.from - to;
      const gone = span.to - span.from;
      work.splice(at, gone, ...span.messages);
      if (stint.from >= at + gone) stint.from += span.messages.length - gone;
      else if (stint.from > at) stint.from = at + span.messages.length;
    }
    this.#pi.state.messages = work;
  }

  /**
   * After a call failed (§13.2), where trying again can help (its kind's switch on, a try left):
   * what the broken call produced leaves the transcript (its thinking, its text, a tool call it had
   * not finished, so no tool runs from a call that did not end whole), and after the wait the call goes
   * out again, a call like any other against every limit. Where some of the reply had been shown, it
   * goes on from where that ends, under the line that says so, and what it writes is joined to it as
   * after a rule's cut; else it goes out as it was. A prompt too long for the model is the run's
   * point's to make room for (`#resend`). Gives the work that sends it again.
   */
  async #retry(stint: Stint): Promise<(() => Promise<void>) | undefined> {
    const terms = this.#o.terms.retry;
    const last = stint.last;
    const facts = stint.facts ?? {};
    stint.facts = undefined;
    if (terms === undefined || last?.stopReason !== "error" || isContextOverflow(last)) return undefined;
    const failure = failureOf(last.errorMessage ?? "", facts);
    const retries = facts.retries ?? terms.retries;
    const wait = retried(terms, failure, stint.retried, retries) ? retryWait(terms, stint.retried, failure.asked) : undefined;
    const tries = stint.retried + 1;
    this.#emit(stint, {
      kind: "call_failed",
      call: this.#calls,
      failure: failure.kind,
      words: last.errorMessage ?? "",
      at: this.#brokeAt(stint, last),
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      tries,
      retries,
      retried: wait !== undefined,
      ...(wait !== undefined ? { wait } : {}),
      ...(failure.asked !== undefined ? { asked: failure.asked } : {}),
    });
    if (wait === undefined) {
      stint.broke = { failure: failure.kind, tries };
      return undefined;
    }
    stint.retried = tries;
    this.#pi.state.messages = this.#pi.state.messages.slice(0, stint.callFrom);
    if (!(await this.#pause(stint, wait))) return undefined;
    const shown = this.#o.channel?.tail() ?? "";
    const goOn = shown === "" ? "" : (this.#o.texts.continueAfterBreak?.({ shown, ...this.#o.channel?.marks }) ?? "");
    if (goOn !== "") {
      const message = this.#message([goOn]);
      return () => this.#pi.prompt(message);
    }
    // A first call has nothing of the agent's own to go on from.
    return this.#pi.state.messages.length === 0 ? () => this.#pi.prompt([]) : () => this.#pi.continue();
  }

  /** Where a call that failed broke: after some of the reply was shown in it; else in the piece it was writing (thinking, a tool call, text); else before any of its answer came. */
  #brokeAt(stint: Stint, message: AssistantMessage): CallBreakPoint {
    if ((this.#o.channel?.shown.length ?? 0) > stint.shownAt) return "shown";
    const piece = message.content.at(-1);
    return piece === undefined ? "before" : piece.type === "toolCall" ? "tool-call" : piece.type === "thinking" ? "thinking" : "text";
  }

  /** Waits `ms` on the host's clock, or until the work stops or reaches a limit: whether it may go on. */
  async #pause(stint: Stint, ms: number): Promise<boolean> {
    if (ms > 0 && stint.halt === undefined) {
      const { promise: waited, resolve } = Promise.withResolvers<void>();
      const timer = this.#clock.setTimeout(resolve, ms);
      await Promise.race([waited, stint.halted.promise]);
      this.#clock.clearTimeout(timer);
    }
    return stint.halt === undefined;
  }

  /**
   * After the provider refused a call as too long (§11): the refused answer leaves the transcript,
   * and the run's point is asked about the request again, with the provider's words. Where it puts
   * something in place, the call goes out again on it, as many times in a row as the run's setting
   * says; else the work ends on the provider's refusal. Gives the work that sends it again.
   */
  async #resend(stint: Stint): Promise<(() => Promise<void>) | undefined> {
    const point = this.#o.point;
    const last = stint.last;
    if (point === undefined || last === undefined || stint.resent >= point.resend || !isContextOverflow(last)) return undefined;
    stint.resent += 1;
    this.#pi.state.messages = this.#pi.state.messages.slice(0, stint.callFrom);
    if (!(await this.#atPoint(stint, point, last.errorMessage ?? ""))) return undefined;
    // A first call has nothing of the agent's own to go on from.
    return this.#pi.state.messages.length === 0 ? () => this.#pi.prompt([]) : () => this.#pi.continue();
  }

  /**
   * Whether a call may go out, and the room its answer has: a limit reached here or above it, the
   * call's prompt past its own limit, or less room left under a limit than the floor stops it.
   */
  #limitsBefore(model: Model<Api>, messages: readonly Message[]): Room {
    const reached = this.#budget.reached(this.agent)[0];
    if (reached !== undefined) return { hit: reached };
    const limits = this.#o.limits ?? {};
    const prompt = requestTokens(messages, this.#o.terms.charsPerToken, this.#counted);
    if (limits.callTokensIn !== undefined && prompt > limits.callTokensIn) return { hit: { limit: "callTokensIn", per: "agent", max: limits.callTokensIn, value: prompt, agent: this.agent } };
    // A limit on tokens sent and written together counts the call's own prompt before its answer's room, the part its provider will likely read again from its cache at that limit's weight.
    return this.#budget.room(this.agent, { floor: this.#o.terms.answerFloor, bounds: [model.maxTokens > 0 ? model.maxTokens : undefined, this.#settings.maxTokens, limits.callTokensOut], prompt: { tokens: prompt, cached: this.#cachedLast } });
  }

  /** The model call pi's loop makes, wrapped: limits first, then the settings decided for its request, then a stream that ends the moment the work stops. */
  #call(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessageEventStream {
    const out = createAssistantMessageEventStream();
    const stint = this.#stint;
    const signal = options?.signal;
    let room: number | undefined;
    if (stint !== undefined && stint.halt === undefined) {
      const before = this.#limitsBefore(model, context.messages);
      if ("hit" in before) this.#halt(stint, { status: "limit", hit: before.hit });
      else room = before.room;
    }
    const now = (): number => this.#clock.now();
    if (stint === undefined || stint.halt !== undefined || signal?.aborted === true) {
      endAborted(out, emptyAnswer(model, now()));
      return out;
    }
    this.#calls += 1;
    const counted: Usage = { ...emptyUsage(), calls: 1 };
    addUsage(stint.usage, counted);
    this.#budget.count(counted);
    const sampling = this.#settings.sampling ?? this.#o.terms.sampling;
    const settings: CallSettings = { ...this.#settings, ...(sampling !== undefined ? { sampling } : {}), ...(room !== undefined ? { maxTokens: room } : {}) };
    stint.callText = "";
    stint.callThinking = "";
    stint.callStartedAt = now();
    stint.callSent = context.messages;
    stint.facts = undefined;
    stint.shownAt = this.#o.channel?.shown.length ?? 0;
    const callTime = this.#o.limits?.callTime;
    if (callTime !== undefined) stint.callTimer = this.#clock.setTimeout(() => this.#halt(stint, { status: "limit", hit: { limit: "callTime", per: "agent", max: callTime, value: this.#clock.now() - stint.callStartedAt, agent: this.agent } }), callTime);
    stint.callFrom = this.#pi.state.messages.length;
    stint.calling = true;
    stint.writing.clear();
    this.#o.channel?.begin();
    const request = this.#o.keep?.(this.#calls, context.messages, this.#opening, [...this.#tools.keys()]);
    this.#emit(stint, {
      kind: "call_started",
      call: this.#calls,
      connection: this.#o.connection,
      model: model.id,
      ...(settings.sampling !== undefined ? { sampling: settings.sampling } : {}),
      ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
      messages: context.messages.length,
      tools: this.#tools.size,
      ...(request !== undefined ? { request } : {}),
      // The model layer's own estimate, so these weigh as its counts of a whole request do.
      toolTokens: tokensOf(JSON.stringify(getCurrentTools(context.messages)), this.#o.terms.charsPerToken),
      openingTokens: tokensOf(this.#o.instructions ?? "", this.#o.terms.charsPerToken),
    });
    let source: Promise<AssistantMessageEventStream>;
    try {
      const layered: SimpleStreamOptions & LayerOptions = {
        ...options,
        ...streamSettings(settings),
        heard: (event) => {
          if (event.kind === "call_facts") stint.facts = event.facts;
          else if (event.kind === "limit") this.#halt(stint, { status: "limit", hit: event.hit });
          else this.#emit(stint, event);
        },
        // The run makes a failed call again itself, each try a call of its own (`#retry`).
        ...(this.#o.terms.retry !== undefined ? { retries: 0 } : {}),
      };
      source = Promise.resolve(this.#o.streamFn(model, context, layered));
    } catch (error) {
      source = Promise.reject(error);
    }
    void pump(source, out, signal, model, now);
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
        // The moment the model began writing a tool call (§17.1: the floor takes the intent record's own time from it).
        else if (piece.type === "toolcall_start" && stint.calling) stint.writing.set(piece.contentIndex, this.#clock.now());
        return;
      }
      case "message_end": {
        const message = event.message;
        if (message.role === "toolResult") {
          // A tool's answer carries the host's time, as every other message of the run does.
          message.timestamp = this.#clock.now();
          stint.reading.delete(message.toolCallId);
          return;
        }
        if (message.role !== "assistant" || !stint.calling) return;
        stint.calling = false;
        stint.answerCalls = 0;
        if (stint.callTimer !== undefined) {
          this.#clock.clearTimeout(stint.callTimer);
          stint.callTimer = undefined;
        }
        const used = this.#spent(stint, message);
        addUsage(stint.usage, used);
        this.#budget.count(used);
        // An answer that calls tools is a tool round, the agent's and every budget's above it.
        if (stint.halt === undefined && stint.cut === undefined && message.stopReason !== "error" && message.stopReason !== "aborted" && message.content.some((part) => part.type === "toolCall")) this.#budget.round();
        // A provider's count of the request: the next estimate starts from it. An answer with none leaves the last count standing.
        if (message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0) {
          this.#counted = { messages: stint.callSent, tokens: used.input };
          this.#cachedLast = message.usage.cacheRead + message.usage.cacheWrite;
        }
        if (stint.halt !== undefined) return;
        if (stint.cut === undefined) {
          stint.last = message;
          // Only refusals one after another are counted against the run's setting, and only failures one after another against the retries: an answer ends the row.
          if (message.stopReason !== "error") {
            stint.resent = 0;
            stint.retried = 0;
          }
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
          toolCalls: message.content.flatMap((part, at) => {
            if (part.type !== "toolCall") return [];
            const began = stint.writing.get(at);
            return [{ id: part.id, name: part.name, args: part.arguments as JsonValue, ...(began !== undefined ? { began } : {}) }];
          }),
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
        if (this.#carriers.has(event.toolName)) stint.carried.set(event.toolCallId, { args });
        else this.#emit(stint, { kind: "tool_started", callId: event.toolCallId, tool: event.toolName, args });
        return;
      }
      case "tool_execution_end": {
        if (stint.halt !== undefined || stint.cut !== undefined) return;
        const id = event.toolCallId;
        stint.finished.add(id);
        // The very answer pi turns into the call's result message right after this event; pi types the event's field loosely.
        const made: AgentToolResult = event.result;
        const read = stint.read.get(id);
        const ms = event.durationMs ?? 0;
        // A call the hook before it answered in its tool's place: what the model reads is the gate's, never pi's words for a blocked call.
        if (read !== undefined) made.content.splice(0, made.content.length, ...read);
        else if (!stint.results.has(id)) {
          this.#reword(stint, id, event.toolName, made);
          // The runner's words for it are held to the bound as a tool's own answer is, and recorded then, before the next request (`#finishTurn`).
          if (this.#o.gate?.bound !== undefined) {
            stint.reworded.set(id, { tool: event.toolName, made, ms });
            return;
          }
        }
        this.#ended(stint, id, event.toolName, made, event.isError, ms);
        return;
      }
      default:
        return;
    }
  }

  /**
   * A call's end record. A found tool is recorded as itself: through `runAs`, or, where its carrier
   * ran nothing because the tool it names was kept from starting, by the name the carrier gave.
   */
  #ended(stint: Stint, id: string, toolName: string, made: AgentToolResult, isError: boolean, ms: number): void {
    const ranAs = stint.ranAs.get(id);
    const own = stint.results.get(id);
    const carried = stint.carried.get(id);
    const refused = own?.refused ?? stint.refusals.get(id);
    const named = carried !== undefined && ranAs === undefined && own?.refused !== undefined ? foundOf(carried.args) : undefined;
    const tool = ranAs ?? named?.name ?? toolName;
    const result: ToolResult = own !== undefined ? ownPart(own) : { content: made.content, ...(isError ? { error: true as const } : {}) };
    const clean = !isError && isClean(result) && !stint.unclean.has(id);
    if (carried !== undefined && ranAs === undefined) this.#emit(stint, { kind: "tool_started", callId: id, tool, args: named?.args ?? carried.args, ...(named !== undefined ? { via: "tool_use" as const } : {}) });
    const permission = stint.permissions.get(id);
    this.#emit(stint, { kind: "tool_ended", callId: id, tool, result, clean, endedRun: stint.ended.has(id), ms, ...(permission !== undefined ? { permission } : {}), ...(refused !== undefined ? { refused } : {}) });
  }

  /** pi's own words for the calls of the step that just finished, held to the bound, then recorded: before the next request reads them. */
  async #boundReworded(stint: Stint): Promise<void> {
    const waiting = [...stint.reworded];
    stint.reworded.clear();
    for (const [id, { tool, made, ms }] of waiting) {
      const { kept, read } = await this.#bounded(stint, { agent: this.agent, callId: id, tool, args: {} }, { content: [...made.content], error: true }, []);
      made.content.splice(0, made.content.length, ...read);
      stint.results.set(id, kept);
      this.#ended(stint, id, tool, made, true, ms);
    }
  }

  /**
   * A call pi answered itself, before its hook ran: a tool the agent does not hold, arguments cut
   * short by the length limit, or arguments that do not fit (or are not JSON). Its answer is given
   * the runner's text for it in place of pi's words. The answer's content is the very list pi turns
   * into the call's result message right after this event, so changing it here is what the model reads.
   */
  #reword(stint: Stint, callId: string, toolName: string, made: AgentToolResult): void {
    const texts = this.#o.texts;
    const tool = this.#tools.get(toolName);
    let line: string | undefined;
    if (tool === undefined) line = texts.notFound?.({ tool: toolName });
    else if (stint.last?.stopReason === "length") line = texts.cutShort?.({ tool: toolName });
    else {
      const part = stint.last?.content.find((piece) => piece.type === "toolCall" && piece.id === callId);
      const call = part?.type === "toolCall" ? part : undefined;
      line = this.#invalid(tool, (call?.arguments ?? {}) as JsonValue, callId, call?.argumentsError);
    }
    const content: TextContent[] = line === undefined ? [] : [{ type: "text", text: line }];
    made.content.splice(0, made.content.length, ...content);
  }

  /** The runner's text for arguments that do not fit `tool`: the check pi ran, run again on what it was given, so its findings come as data a file can lay out. */
  #invalid(tool: Pick<LoopTool, "name" | "description" | "parameters">, raw: JsonValue, callId: string, argumentsError?: string): string | undefined {
    const checked = fit(tool, raw, callId, argumentsError);
    const misfits = "misfits" in checked ? checked.misfits : [];
    const unparsed = "misfits" in checked ? checked.unparsed : undefined;
    return this.#o.texts.invalid?.({
      tool: tool.name,
      arguments: unparsed ?? JSON.stringify(raw),
      parameters: JSON.stringify(tool.parameters),
      misfits,
      ...(unparsed !== undefined ? { unparsed: true as const } : {}),
    });
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

  /**
   * pi's hook before a tool runs (§13.3), for a call of the agent's own list and, through `runAs`,
   * for a tool found by `tool_use`, as itself. Once a limit is reached no tool starts, and the work
   * ends at that limit (§10.11); the call it kept from running still ends in the trace. Then the
   * gate: a call it refuses or holds is answered in its tool's place (pi blocks it), in the gate's
   * words; the rules on its arguments that remind come back with its answer; the permission it runs
   * under is kept for the record of its end. A carrier's own call passes: the tool it carries comes
   * back here as itself. A stop does not wait on the gate (a permission still asked, say): the call
   * never runs.
   */
  async #beforeTool(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
    const stint = this.#stint;
    if (stint === undefined || stint.halt !== undefined || stint.cut !== undefined) return { block: true };
    const { id, name } = context.toolCall;
    // A limit the work has spent past (tokens), here or above it, holds the tool and is named. A count of calls or of tool rounds is reached by the very call that asked for it, which was within the limit: it holds the next call (`#call`), not this call's tools (R-194).
    // The same call again, nothing written since, as many times in a row as `limits.repeats` says, ends the work at the loop's count, as a limit spent does.
    const hit = this.#budget.reached(this.agent).find((reached) => !countLimit(reached)) ?? this.#looped(name, context.args as JsonValue);
    if (hit !== undefined) {
      this.#halt(stint, { status: "limit", hit });
      // A found tool is recorded as itself, whether its carrier had begun or not.
      const carried = this.#carriers.has(name) ? stint.carried.get(id) : undefined;
      const named = carried === undefined ? undefined : foundOf(carried.args);
      const tool = named?.name ?? name;
      if (carried !== undefined) this.#emit(stint, { kind: "tool_started", callId: id, tool, args: named?.args ?? carried.args, ...(named !== undefined ? { via: "tool_use" as const } : {}) });
      const refused: CallRefusal = { by: "limit", hit };
      stint.refusals.set(id, refused);
      // A write so stopped still names its lane and the permission it would have run under.
      const args = named?.args ?? (context.args as JsonValue);
      const permission = await this.#o.gate?.permissionOf?.({ agent: this.agent, callId: id, tool, args });
      // It never started: answered with a line of its own, the one the transcript keeps for it (`#settle`); the `limit` record before it says which.
      const line = this.#o.texts.notStarted?.({ tool });
      this.#emit(stint, { kind: "tool_ended", callId: id, tool, result: { content: line === undefined ? [] : [{ type: "text", text: line }], error: true }, clean: false, endedRun: false, ms: 0, ...(permission !== undefined ? { permission } : {}), refused });
      return { block: true };
    }
    // A call of the answer past its count of tool calls (`limits.toolsPerAnswer`) is answered, not run: a carrier's call counts, the tool it carries does not count again.
    const most = this.#o.limits?.toolsPerAnswer;
    if (most !== undefined && (this.#carriers.has(name) || !stint.carried.has(id)) && ++stint.answerCalls > most) {
      stint.refusals.set(id, { by: "answer", max: most });
      const line = this.#o.texts.pastAnswerCount?.({ tool: name, max: most });
      return this.#blocked(stint, { agent: this.agent, callId: id, tool: name, args: context.args as JsonValue }, { content: line === undefined ? [] : [{ type: "text", text: line }] }, []);
    }
    if (this.#carriers.has(name)) return undefined;
    const call: GateCall = { agent: this.agent, callId: id, tool: name, args: context.args as JsonValue };
    const gate = this.#o.gate;
    if (gate === undefined) return undefined;
    let before: GateBefore | undefined;
    try {
      before = await untilAborted(gate.before(call, signal ?? new AbortController().signal), signal);
    } catch (error) {
      if (stint.halt !== undefined) return { block: true };
      // What fails around the tool (a permission or a rule that could not be asked) is answered as a tool that failed, never in pi's words; the record says why.
      stint.refusals.set(id, { by: "unasked", error: error instanceof Error ? error.message : String(error) });
      return this.#blocked(stint, call, this.#failed(name, error), []);
    }
    if (before === undefined || stint.halt !== undefined) return { block: true };
    if (before.permission !== undefined) stint.permissions.set(id, before.permission);
    if (before.refuse !== undefined) {
      if (before.refused !== undefined) stint.refusals.set(id, before.refused);
      return this.#blocked(stint, call, before.refuse, []);
    }
    if (before.hold !== undefined) {
      // Answered with the rule's text in its tool's place, the texts of the rules that remind after it: never clean.
      stint.unclean.add(id);
      stint.refusals.set(id, { by: "hold", rule: before.hold.firing.rule });
      this.#ruled(stint, call, before.hold, "hold");
      for (const fired of before.remind) this.#ruled(stint, call, fired, "remind");
      return this.#blocked(stint, call, { content: [{ type: "text", text: before.hold.text.trimEnd() }] }, before.remind.map((fired) => fired.text.trimEnd()));
    }
    if (before.remind.length > 0) stint.argued.set(id, before.remind);
    if (before.args !== undefined) stint.changed.set(id, before.args);
    return undefined;
  }

  /**
   * The loop's count (`limits.repeats`): a call of the same tool with the same arguments as its last,
   * with no write by any agent of the run since, counts one more in a row; at the count, the limit it
   * ends the work at. A carrier's call is not counted: the tool it carries is, as itself.
   */
  #looped(name: string, args: JsonValue): LimitHit | undefined {
    const most = this.#o.terms.repeats;
    if (most === undefined || this.#carriers.has(name)) return undefined;
    const key = JSON.stringify([name, args]);
    const writes = this.#o.gate?.writes?.() ?? 0;
    const last = this.#last;
    const count = last !== undefined && last.key === key && last.writes === writes ? last.count + 1 : 1;
    this.#last = { key, writes, count };
    return count >= most ? { limit: "repeats", per: "agent", max: most, value: count, agent: this.agent } : undefined;
  }

  /**
   * A call answered in its tool's place (pi blocks it): its answer and the texts after it held to the
   * bound, kept as pi keeps a blocked call's answer (failed), and given to pi as the reason; what the
   * model reads of it replaces pi's words for it when the call ends.
   */
  async #blocked(stint: Stint, call: GateCall, answer: LoopToolResult, added: string[]): Promise<BeforeToolCallResult> {
    const { kept, read } = await this.#bounded(stint, call, answer, added);
    if (stint.halt !== undefined) return { block: true };
    stint.results.set(call.callId, { ...kept, error: true });
    stint.read.set(call.callId, read);
    const text = read.map((part) => (part.type === "text" ? part.text : "")).join("");
    stint.reading.set(call.callId, tokensOf(text, this.#o.terms.charsPerToken));
    return { block: true, reason: text };
  }

  /** What the model reads of a call, held to the gate's bound and to the room left of its prompt per call; where the bound itself fails, the runner's failure line, as it is. */
  async #bounded(stint: Stint, call: GateCall, answer: LoopToolResult, added: readonly string[]): Promise<{ kept: LoopToolResult; read: ToolContent[] }> {
    const gate = this.#o.gate;
    let bounded: Bounded = { result: answer, read: readOf(answer, added) };
    if (gate !== undefined && gate.bound !== undefined) {
      try {
        bounded = await gate.bound(call, answer, added, this.#promptRoom(stint));
      } catch (error) {
        const failed = this.#failed(call.tool, error);
        bounded = { result: failed, read: failed.content };
      }
    }
    return { kept: bounded.result, read: bounded.read };
  }

  /**
   * Characters left for what the model reads of a call: the least of the model's window less the
   * reserve (the run's point gives both) and the agent's prompt per call (`limits.callTokensIn`), less
   * the request as it stands and what it reads of this batch's other calls (§10.2: nothing is cut
   * until it would not fit). Undefined with neither.
   */
  #promptRoom(stint: Stint): number | undefined {
    const point = this.#o.point;
    const fits = point?.window !== undefined && point.window > 0 ? point.window - point.reserve : undefined;
    const limit = this.#o.limits?.callTokensIn;
    const most = fits === undefined ? limit : limit === undefined ? fits : Math.min(fits, limit);
    if (most === undefined) return undefined;
    const ratio = this.#o.terms.charsPerToken;
    let taken = requestTokens(this.#request(), ratio, this.#counted);
    for (const tokens of stint.reading.values()) taken += tokens;
    return Math.max(0, Math.floor((most - taken) * ratio));
  }

  /**
   * pi's hook after a tool ran (§13.3): the rules on its result, and what the model reads of the call
   * held to the bound with the texts of every rule on it; then whether the call ends the work. A
   * carrier's call that ran a found tool already holds that tool's answer as the model reads it; one
   * that ran none is held to the bound as it is.
   */
  async #afterTool(context: AfterToolCallContext, signal?: AbortSignal): Promise<AfterToolCallResult | undefined> {
    const stint = this.#stint;
    if (stint === undefined || stint.halt !== undefined) return undefined;
    const { id, name } = context.toolCall;
    const ran = stint.ran.get(id);
    // A tool that answered after the work stopped: nothing more goes around its late answer.
    if (ran === undefined) return undefined;
    stint.ran.delete(id);
    const carrier = this.#carriers.has(name);
    const found = !carrier && stint.carried.has(id);
    const call: GateCall = { agent: this.agent, callId: id, tool: name, args: context.args as JsonValue };
    let taken: { kept: LoopToolResult; read: ToolContent[] } | undefined;
    if (carrier && stint.ranAs.has(id)) taken = { kept: stint.results.get(id) ?? ran, read: ran.content };
    else if (carrier) taken = await this.#bounded(stint, call, ran, []);
    else {
      const argued = stint.argued.get(id) ?? [];
      stint.argued.delete(id);
      taken = await this.#after(stint, call, ran, argued, signal);
    }
    if (taken === undefined || stint.halt !== undefined) return undefined;
    stint.results.set(id, taken.kept);
    stint.reading.set(id, tokensOf(taken.read.map((part) => (part.type === "text" ? part.text : "")).join(""), this.#o.terms.charsPerToken));
    const answer: AfterToolCallResult = { content: taken.read, ...(taken.kept.details !== undefined ? { details: taken.kept.details } : {}), isError: taken.kept.error === true };
    // A found tool's answer goes back through its carrier's call, which decides whether the work ends.
    if (found) return answer;
    return { ...answer, ...this.#ending(stint, id, ran) };
  }

  /**
   * A call that ran, through the gate after it: the rules on its result, and its answer held to the
   * bound with the texts of every rule on the call, each firing traced. Whatever fails around it, the
   * tool's own answer stands (§6.1): a write that went through is never told as failed. Undefined once
   * the work stopped.
   */
  async #after(stint: Stint, call: GateCall, ran: LoopToolResult, argued: Fired[], signal: AbortSignal | undefined): Promise<{ kept: LoopToolResult; read: ToolContent[] } | undefined> {
    const gate = this.#o.gate;
    const texts = argued.map((fired) => fired.text.trimEnd());
    let after: GateAfter | undefined;
    try {
      after = gate === undefined ? { result: ran, remind: [] } : await untilAborted(gate.after(call, ran, signal ?? new AbortController().signal, texts, this.#promptRoom(stint)), signal);
    } catch {
      if (stint.halt !== undefined) return undefined;
      // The gate says what it could not do beside the answer, and logs it; failing whole, the answer goes as the tool gave it.
      if (!isClean(ran) || argued.length > 0) stint.unclean.add(call.callId);
      for (const fired of argued) this.#ruled(stint, call, fired, "remind");
      return this.#bounded(stint, call, ran, texts);
    }
    if (after === undefined || stint.halt !== undefined) return undefined;
    // Whether an answer is clean is the tool's own: what it reported counts though the model reads none of it.
    if (!isClean(ran)) stint.unclean.add(call.callId);
    const reminders = [...argued, ...after.remind];
    if (reminders.length > 0) stint.unclean.add(call.callId);
    for (const fired of reminders) this.#ruled(stint, call, fired, "remind");
    return { kept: after.result, read: after.read ?? readOf(after.result, reminders.map((fired) => fired.text.trimEnd())) };
  }

  /**
   * Whether the call ends the work: a question that ends it (`ask_author`, §10.5), and nothing else.
   * A message that makes no tool call ends the work too, which pi's loop does by itself; what is due
   * at the run's end is asked then (`#finishTurn`).
   */
  #ending(stint: Stint, id: string, ran: LoopToolResult): AfterToolCallResult {
    if (ran.ask === undefined) return {};
    stint.asked ??= { call: id, question: ran.ask };
    stint.ended.add(id);
    return { terminate: true };
  }

  async #finishTurn(turn: AgentTurnContext): Promise<AgentTurnDecision | undefined> {
    const stint = this.#stint;
    if (stint === undefined) return undefined;
    await this.#boundReworded(stint);
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
    // A reply waiting for his before-release hooks went out, or was kept back with their reason, before the agent goes on.
    await Promise.race([this.#o.channel?.settled?.(), stint.halted.promise]);
    if (stint.halt !== undefined) return { action: "end" };
    const answers = this.#o.channel?.answers?.() ?? [];
    if (turn.toolResults.length > 0) {
      // A message that made tool calls: the work goes on, and a reminder, what the reply's form has to say, the rules a judging model's answer fired and the rules due after a message (a fact at its threshold: the last rounds) go in with the next call.
      const due = (await this.#o.afterMessage?.due({ agent: this.agent, call: this.#calls })) ?? [];
      if (stint.halt !== undefined) return { action: "end" };
      for (const fired of reminders) this.#add(stint, fired, "remind", "steer");
      for (const text of answers) this.#pi.steer(this.#message([text]));
      for (const judged of stint.judged.splice(0)) this.#judged(stint, judged, "steer");
      for (const fired of due) this.#add(stint, fired, "remind", "steer");
      return undefined;
    }
    // The message made no tool call: the work would end here. What is due at a run's end goes in as a follow-up, and the agent
    // gets one more call. It does not end while a question about its messages is unanswered (§5.4):
    // it waits for the judging model, racing a stop, and a yes gives it one more call too.
    if (stint.judging.size > 0) {
      await Promise.race([Promise.allSettled([...stint.judging].map((judgment) => judgment.answer)), stint.halted.promise]);
      if (stint.halt !== undefined) return { action: "end" };
    }
    const due = (await this.#o.runEnd?.due({ agent: this.agent, call: this.#calls })) ?? [];
    if (stint.halt !== undefined) return { action: "end" };
    const kept = stint.hooked ? undefined : await this.#o.atRunEnd?.();
    stint.hooked = true;
    if (stint.halt !== undefined) return { action: "end" };
    for (const fired of reminders) this.#add(stint, fired, "remind", "follow-up");
    for (const text of answers) this.#pi.followUp(this.#message([text]));
    for (const fired of due) this.#add(stint, fired, "follow-up", "follow-up");
    for (const judged of stint.judged.splice(0)) this.#judged(stint, judged, "follow-up");
    if (kept !== undefined) this.#pi.followUp(this.#message([kept]));
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
    const message = this.#message([fired.text]);
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
      messages.splice(at + 1, messages.length, ...calls.map((call) => (stint.finished.has(call.id) ? answers.get(call.id) : undefined) ?? this.#unfinished(stint, call)));
      break;
    }
    this.#pi.state.messages = messages;
  }

  /** The answer the transcript keeps for a call the work ended before it finished: never started, where a spent limit kept it from starting; else it may have done its work, or not. */
  #unfinished(stint: Stint, call: ToolCall): ToolResultMessage {
    const line = stint.refusals.get(call.id)?.by === "limit" ? this.#o.texts.notStarted?.({ tool: call.name }) : this.#o.texts.unfinished?.({ tool: call.name });
    return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: line === undefined ? [] : [{ type: "text", text: line }], isError: true, timestamp: this.#clock.now() };
  }

  /** The answer to the question the agent stopped on becomes that call's result, at the time it came. */
  #answer(call: string, text: string): void {
    const at = this.#clock.now();
    this.#pi.state.messages = this.#pi.state.messages.map((message) => (message.role === "toolResult" && message.toolCallId === call ? { ...message, content: [{ type: "text", text }], timestamp: at } : message));
  }

  /** A tool as pi's loop runs it, with its own arguments: `own` for one of the agent's own list, which waits for a place among its tool calls at once; a found tool runs in its carrier's place (§6.8). */
  #piTool(tool: LoopTool, own: boolean): AgentTool<JsonSchema, JsonValue | undefined> {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.sequential === true ? { executionMode: "sequential" as const } : {}),
      execute: async (callId, params, signal) => {
        const stint = this.#stint;
        // Only a call of the work in flight runs; pi makes no other.
        if (stint === undefined) return { content: [], details: undefined };
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
        // One past the agent's tool calls at once waits for a place, in line; a found tool runs in its carrier's place.
        const free = own ? await this.#place(stint, callId, tool.name, signal) : () => {};
        if (free === undefined) return { content: [], details: undefined };
        try {
          // pi waits on a tool until it settles; a stop does not.
          // A hook's change of the arguments holds where they still fit the tool's own schema; else the call runs as the model wrote it.
          const asked = params as JsonValue;
          const changed = stint.changed.get(callId);
          const fitted = changed === undefined ? undefined : fit(tool, changed, callId);
          const ran = await untilAborted(this.#run(tool, fitted !== undefined && "args" in fitted ? fitted.args : asked, ctx), signal);
          answered = true;
          if (ran === undefined) return { content: [], details: undefined };
          stint.ran.set(callId, ran);
          return { content: ran.content, details: ran.details, ...(ran.error === true ? { isError: true } : {}) };
        } finally {
          free();
        }
      },
    };
  }

  /** A place for one of an answer's tool calls (`limits.toolsAtOnce`): at once, or after a wait the trace is told of as it begins and ends; undefined where a stop took it out of the line. */
  async #place(stint: Stint, callId: string, tool: string, signal: AbortSignal | undefined): Promise<(() => void) | undefined> {
    const line = this.#line;
    if (line === undefined) return () => {};
    const from = this.#clock.now();
    let waited = false;
    const free = await line.take(signal, () => {
      waited = true;
      this.#emit(stint, { kind: "waiting", for: "tool", callId, tool });
    });
    if (free !== undefined && waited) this.#emit(stint, { kind: "waiting", for: "tool", callId, tool, ms: this.#clock.now() - from });
    return free;
  }

  /**
   * Runs the tool a carrier's call names (`tool_use`, §6.8) as itself, from inside that call, by pi's
   * own steps for a tool call (`runToolCall`: its arguments checked against its own schema, then the
   * same two hooks as a call of the agent's own list), under its own name and the carrier's call id.
   * It gives what the model reads of the call. Outside a carrier's call of the work in flight it runs
   * nothing.
   */
  async runAs(tool: LoopTool, args: JsonValue, ctx: ToolCtx): Promise<LoopToolResult> {
    const stint = this.#stint;
    const callId = ctx.callId;
    const carried = stint?.carried.get(callId);
    const message = stint?.last;
    if (stint === undefined || carried === undefined || message === undefined || stint.halt !== undefined) return { content: [] };
    stint.ranAs.set(callId, tool.name);
    this.#emit(stint, { kind: "tool_started", callId, tool: tool.name, args, via: "tool_use" });
    const outcome = await runToolCall(
      { type: "toolCall", id: callId, name: tool.name, arguments: typeof args === "object" && args !== null && !Array.isArray(args) ? args : {} },
      {
        tools: [this.#piTool(tool, false)],
        assistantMessage: message,
        context: { messages: this.#request(), tools: [...this.#tools.values()] },
        signal: ctx.signal,
        beforeToolCall: (context, signal) => this.#beforeTool(context, signal),
        afterToolCall: (context, signal) => this.#afterTool(context, signal),
      },
    );
    if (stint.halt !== undefined) return { content: [] };
    const kept = stint.results.get(callId);
    if (kept === undefined) {
      // pi answered it without asking the hooks: its arguments did not pass pi's own check. The answer is the runner's text, never pi's words.
      const line = this.#invalid(tool, args, callId);
      const answer: LoopToolResult = { content: line === undefined ? [] : [{ type: "text", text: line }], error: true };
      stint.results.set(callId, answer);
      return answer;
    }
    const read = stint.read.get(callId);
    stint.read.delete(callId);
    return {
      content: read ?? outcome.result.content,
      ...(outcome.isError ? { error: true as const } : {}),
      ...(kept?.details !== undefined ? { details: kept.details } : {}),
      ...(kept?.ask !== undefined ? { ask: kept.ask } : {}),
    };
  }

  /** Runs the tool. One that throws is answered with the runner's text for it; the error's own words are kept in the call's details, for the trace alone. */
  async #run(tool: LoopTool, args: JsonValue, ctx: ToolCtx): Promise<LoopToolResult> {
    try {
      return await tool.run(args, ctx);
    } catch (error) {
      return this.#failed(tool.name, error);
    }
  }

  #failed(tool: string, error: unknown): LoopToolResult {
    const words = error instanceof Error ? error.message : String(error);
    const line = this.#o.texts.failed?.({ tool });
    return { content: line === undefined ? [] : [{ type: "text", text: line }], error: true, details: { error: words } };
  }

  #ruled(stint: Stint, call: GateCall, fired: Fired, action: RuleAction): void {
    if (stint.halt !== undefined) return;
    this.#emit(stint, { kind: "rule_fired", firing: { callId: call.callId, tool: call.tool, ...fired.firing, agent: this.agent, action } });
  }

  #emit(stint: Stint, event: TraceEvent): void {
    this.#o.trace.event(this.agent, stint.parent, event);
  }

  /** A message to the agent of texts from files, each without the line break its file ends on, at the host's clock's time. */
  #message(texts: string[]): UserMessage {
    return { role: "user", content: texts.map((text) => ({ type: "text", text: text.trimEnd() })), timestamp: this.#clock.now() };
  }
}

/** Clean: no failure and nothing reported. */
function isClean(result: ToolResult): boolean {
  return result.error !== true && (result.reports?.length ?? 0) === 0;
}

/** A call's answer as the trace keeps it: what only RPH's own tools add to an answer (a question, why it never ran) stays out. */
function ownPart(result: LoopToolResult): ToolResult {
  const { ask: _ask, refused: _refused, ...rest } = result;
  return rest;
}

/** The tool a carrier's call names (`tool_use`'s `name` and `args`), as itself: undefined where it names none. */
function foundOf(args: JsonValue): { name: string; args: JsonValue } | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const name = args["name"];
  return typeof name === "string" && name !== "" ? { name, args: args["args"] ?? {} } : undefined;
}

/** What the model reads of a call: its answer's content, then its reports and the texts that go after it, one part each. */
function readOf(result: ToolResult, added: readonly string[]): ToolContent[] {
  return [...result.content, ...[...(result.reports ?? []), ...added].map((text) => ({ type: "text" as const, text }))];
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

/** An answer with nothing in it, stopped, at `at` by the host's clock. */
function emptyAnswer(model: Model<Api>, at: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "aborted",
    timestamp: at,
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
 * the provider does: a provider slow to notice can neither keep the run open nor add to it. An answer
 * it has to make up itself carries the host's clock's time (`now`).
 */
async function pump(source: Promise<AssistantMessageEventStream>, out: AssistantMessageEventStream, signal: AbortSignal | undefined, model: Model<Api>, now: () => number): Promise<void> {
  let partial: AssistantMessage | undefined;
  let open = true;
  const abort = (): void => {
    if (!open) return;
    open = false;
    endAborted(out, partial ?? emptyAnswer(model, now()));
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
    const failed: AssistantMessage = { ...(partial ?? emptyAnswer(model, now())), stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
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

/** Whether putting something in place of `messages` from `from` up to `to` would part a tool call from its result. */
function partsCall(messages: readonly AgentMessage[], from: number, to: number): boolean {
  const calls = new Set<string>();
  for (const message of messages.slice(from, to)) {
    if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") calls.add(part.id);
  }
  return messages.some((message, at) => message.role === "toolResult" && calls.has(message.toolCallId) !== (at >= from && at < to));
}
