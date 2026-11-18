// What the agent runner takes and gives, beyond the contract's own types.
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRef, AgentStatus, CallFailureKind, CallPermission, CallRefusal, Clock, JsonSchema, JsonValue, LimitHit, Sampling, ToolContent, ToolCtx, ToolResult, Usage } from "../contract";
import type { RetryTerms } from "../model/failure";
import type { Fired } from "./rules";

/** What the loop needs of the host's clock: the time, and timers. */
export type LoopClock = Pick<Clock, "now" | "setTimeout" | "clearTimeout">;

/**
 * A tool as the runner takes it. A host's tool (`HostTool`) has this shape; so do RPH's own base
 * tools, which may also end their agent's work with a question.
 */
export interface LoopTool {
  name: string;
  description: string;
  /** Its arguments, as an object schema: the model is told them as they are, and the tool is called with them. */
  parameters: JsonSchema;
  run(args: JsonValue, ctx: ToolCtx): Promise<LoopToolResult>;
  /** Runs alone: a message that calls it runs its calls one after another. */
  sequential?: boolean;
  /**
   * Carries a call of another tool (`tool_use`): the tool it carries runs through
   * `AgentRunner.runAs`, gated, ruled on and traced as itself, so the carrier itself is never gated
   * and is traced only when it ran nothing.
   */
  carrier?: boolean;
}

/** A tool's answer, with what only RPH's own tools may add. */
export interface LoopToolResult extends ToolResult {
  /**
   * Ends the agent's work with this question for whoever started it (`ask_author`, §10.5): the
   * outcome is `asked`, and the next message the agent is given becomes this call's answer. A
   * host's tool never sets it: a host cannot end a run.
   */
  ask?: JsonValue;
  /**
   * A carrier's answer when it ran no tool because the one it names is kept from starting (`tool_use`
   * naming a tool not switched on): why, for the end record, which then names that tool as itself.
   */
  refused?: CallRefusal;
}

/** A tool call as the gate sees it: who made it, the model's id for it, the tool, and its arguments. */
export interface GateCall {
  agent: AgentRef;
  callId: string;
  tool: string;
  args: JsonValue;
}

/**
 * Before a call runs. `refuse`: it does not run, and this is its answer (the host's switches or the
 * user's permission said no, in a file's words), with `refused`, why, as a fact. `hold`: a rule on
 * its arguments holds it, and the rule's text is its answer. `remind`: rules on its arguments whose
 * texts come back with its answer. `permission`: for a write or external tool, the permission it
 * runs (or was refused, or would have run) under.
 */
export interface GateBefore {
  refuse?: LoopToolResult;
  refused?: CallRefusal;
  hold?: Fired;
  remind: Fired[];
  permission?: CallPermission;
  /** The call's arguments as a hook before it changed them (§5.4 "Hooks"): the tool runs with these, where they still fit its schema. */
  args?: JsonValue;
}

/**
 * One call held to the user's bound on what the model reads of a call (`results.clipChars`): `result`, its
 * answer as it is kept (cut to the bound where it is longer, with the file's line on what was left
 * out and where the whole is, among its reports where it has any); `read`, what the model reads of
 * the call, in order: the answer's text, its reports and the texts that go after it, as far as the
 * bound left them, then that line.
 */
export interface Bounded {
  result: LoopToolResult;
  read: ToolContent[];
}

/**
 * After a call ran: its answer as it is kept, what the model reads of the call (absent: the answer,
 * then its reports and the rules' texts, as they are), and the rules on its result.
 */
export interface GateAfter {
  result: LoopToolResult;
  read?: ToolContent[];
  remind: Fired[];
}

/**
 * What is asked around every tool call besides the tool (§13.3), from pi's own hooks: before it
 * (`beforeToolCall`), the host's switches, the user's permissions and the rules on its arguments;
 * after it (`afterToolCall`), the rules on its result and the bound on what the model reads of it.
 * A tool found through `tool_use` is asked about as itself. The gate says what is so; the runner
 * traces the firings, and puts their texts and the answer in front of the agent.
 */
export interface ToolGate {
  before(call: GateCall, signal: AbortSignal): Promise<GateBefore>;
  /**
   * `added`: texts already due after the answer (the rules on its arguments), held to the bound with
   * it. `room`: characters left of the agent's prompt per call (`limits.callTokensIn`); what the model
   * reads is held to the least of it and the bound, whole kept as a clipped result is.
   */
  after(call: GateCall, result: LoopToolResult, signal: AbortSignal, added?: readonly string[], room?: number): Promise<GateAfter>;
  /**
   * The bound on what the model reads of a call answered without running its tool (a refusal, a
   * hold, a failure around it), as `after` holds an answer to it, `room` too. Absent: such an answer goes as it is.
   */
  bound?(call: GateCall, answer: LoopToolResult, added?: readonly string[], room?: number): Promise<Bounded>;
  /** For a write or external tool, the lane and the user's setting it would run under, asking him nothing: the record of a call a limit kept from starting. */
  permissionOf?(call: GateCall): Promise<CallPermission | undefined>;
  /** Calls of a write tool that ran without failing so far, by any agent of the run: the same call again after one is not a loop. Absent: none counted. */
  writes?(): number;
}

/** What one model call is sent with besides its messages, decided in pi's request hook before that request alone. */
export interface CallSettings {
  /** The model the call is made on; absent: the agent's own. */
  model?: Model<Api>;
  /** The effort the call is made with; absent: the agent's own. */
  effort?: ThinkingLevel;
  sampling?: Sampling;
  /** The longest answer the call may give, in tokens. */
  maxTokens?: number;
}

/** What every model call of an agent is made on, from the settings: how its tokens are estimated, the least room an answer is given, how its run's own controls stand where its definition sets none, and its definition's own sampling. */
export interface CallTerms {
  /** Characters per token, where a provider has not counted (`tokens.charsPerToken`). */
  charsPerToken: number;
  /** The least room an answer is given (`limits.minAnswerTokens`): with less left under a limit, no call is made. */
  answerFloor: number;
  /** What a token read again from a provider's cache counts for against every limit on tokens sent (`limits.cachedWeight`); absent, in full. */
  cachedWeight?: number;
  /** An answer's tool calls that run at once where the definition sets none (`limits.toolsAtOnce`); absent, all of them. */
  toolsAtOnce?: number;
  /** The same call with the same arguments this many times in a row, nothing written between, ends the run (`limits.repeats`); absent, never. */
  repeats?: number;
  /** Its definition's sampling (`agents.<definition>.sampling`), on each call whose settings give none. */
  sampling?: Sampling;
  /** How a call that failed is made again (`calls.retries` and the settings beside it); absent, never. */
  retry?: RetryTerms;
}

/** Which call is about to be made, for deciding its settings. */
export interface CallRequest {
  agent: AgentRef;
  /** The agent's call number, from 1. */
  call: number;
  /** The agent's own model's id. */
  model: string;
}

/**
 * Keeps what a call is sent, where the user's setting asks for it (`trace.requests`): given the
 * call's number, its messages as sent, the agent's opening block among them (none when it has
 * none), and the names of the tools it declared, the path of the file they are kept in, which the
 * call's `call_started` names; undefined when this call's are not kept.
 */
export type KeepRequest = (call: number, messages: readonly Message[], opening: Message | undefined, tools: readonly string[]) => string | undefined;

/**
 * The run's point before each of an agent's requests (§11): it is shown the request as it would go,
 * and what it weighs against the model's window, and may put something in place of part of it. It
 * may await model calls of its own before it answers, which the run makes on its own trace and
 * limits and ends at `PendingRequest.signal`. It is asked again when the provider refuses a call as
 * too long, and the call goes out again on what it put in place.
 */
export interface RequestPoint {
  /** The model's window, in tokens; absent where nobody knows it. */
  window?: number;
  /** The tokens kept free for the answer: the reserve's setting. */
  reserve: number;
  /** How many times in a row a call the provider refused as too long goes out again on what `check` put in place: the run's setting. */
  resend: number;
  /** What to put in place before the request goes out: nothing, or spans of `request.messages` with what stands in their place. */
  check(request: PendingRequest): Promise<readonly RequestSpan[] | undefined> | readonly RequestSpan[] | undefined;
}

/**
 * The owner's hand on a run (§14 Live, C-19), the same for every agent of it. A run that is held
 * makes no further request until it is let go; what the owner said goes to its main agent at its
 * next request, as his words. The runner asks at the point before each request. None: nothing waits.
 */
export interface RunHold {
  /** Whether the run is held now. */
  readonly held: boolean;
  /** Settles once the run is not held, at once where it is not; settles too when `signal` aborts. */
  until(signal: AbortSignal): Promise<void>;
  /** What the owner said to this agent since it last asked, in the order he said it, taken out: only the run's main agent is given any. */
  said(agent: AgentRef): string[];
}

/** A request about to go out, as the run's point is shown it. */
export interface PendingRequest {
  agent: AgentRef;
  /** The agent's call it would be, from 1. */
  call: number;
  /** Its messages as they would go: the opening block, the run's fixed context, then the agent's own work. */
  messages: readonly AgentMessage[];
  /** Where the run's fixed context lies in `messages`, from `from` up to `to`: after the opening block (when there is one), before the agent's own work. */
  context: { from: number; to: number };
  window: number | undefined;
  reserve: number;
  /** What the request weighs, in tokens, by the model layer's own estimate. */
  tokens: number;
  /** The provider's words, when it refused this request as too long. */
  refused?: string;
  /** Aborts when the work stops or reaches a limit: a call of the point's own ends with it. */
  signal: AbortSignal;
}

/**
 * Messages that stand in place of a span of the request the run's point was shown, from `from` up to
 * but not including `to`. It lies in the run's fixed context or in the agent's own work, never
 * across the two, never over the opening block, and in the agent's own work it never parts a tool
 * call from its result. What is put in place holds for the run's later requests.
 */
export interface RequestSpan {
  from: number;
  to: number;
  messages: readonly AgentMessage[];
}

/** The limits a user sets for one agent's work (§10.11). Each absent is no limit. */
export interface AgentLimits {
  calls?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Wall time, in milliseconds. */
  time?: number;
  /** The prompt of one call, as estimated before it is sent. */
  callTokensIn?: number;
  /** The answer of one call. */
  callTokensOut?: number;
  /** One call's wall time, in milliseconds, apart from the model layer's silent wait. */
  callTime?: number;
  /** Its answers that call tools. */
  toolRounds?: number;
  /** The tool calls one answer may make: the calls past it are answered and not run. */
  toolsPerAnswer?: number;
  /** An answer's tool calls that run at once (absent: the setting's); one more waits for a place. */
  toolsAtOnce?: number;
  /** For a sub-agent: the messages it may be sent after its first answer; one past it is answered and it is not run. */
  messages?: number;
}

/** How one stretch of an agent's work ended. */
export interface AgentOutcome {
  agent: AgentRef;
  status: AgentStatus;
  /** For `limit`: which. */
  limit?: LimitHit;
  /** For `failed`: the model's or the runner's words. */
  error?: string;
  /** For `failed`: whether the model's provider failed, or RPH's own work around it. */
  failure?: "model" | "harness";
  /** For a `failed` model: what broke its last call, and how many times that call was made, its retries among them. */
  broke?: { failure: CallFailureKind; tries: number };
  /** The text of its last message: a sub-agent's answer. Empty when it stopped first. */
  text: string;
  /** For `limit` and `stopped`: what it had done by then: how many of its tool calls had finished, and the text of its last whole message (empty where it wrote none). */
  worked?: { tools: number; wrote: string };
  /** For `asked`: the question, as its tool gave it. */
  question?: JsonValue;
  usage: Usage;
}
