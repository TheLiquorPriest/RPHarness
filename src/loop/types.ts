// What the agent runner takes and gives, beyond the contract's own types.
import type { Message } from "@earendil-works/pi-ai";
import type { AgentRef, AgentStatus, CallPermission, Clock, JsonSchema, JsonValue, LimitHit, Sampling, ToolContent, ToolCtx, ToolResult, Usage } from "../contract";
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
  /** Its arguments, as an object schema. The runner adds `closing` to it; the tool never sees that argument, and one that has its own argument of that name is left out (`AgentRunner.leftOut`). */
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
}

/** A tool call as the gate sees it: who made it, the model's id for it, the tool, and its arguments without `closing`. */
export interface GateCall {
  agent: AgentRef;
  callId: string;
  tool: string;
  args: JsonValue;
}

/**
 * Before a call runs. `refuse`: it does not run, and this is its answer (the host's switches or the
 * user's permission said no, in a file's words). `hold`: a rule on its arguments holds it, and the
 * rule's text is its answer. `remind`: rules on its arguments whose texts come back with its answer.
 * `permission`: for a write or external tool, the permission it runs (or was refused) under.
 */
export interface GateBefore {
  refuse?: LoopToolResult;
  hold?: Fired;
  remind: Fired[];
  permission?: CallPermission;
}

/**
 * One call held to the user's bound on what the model reads of a call (`results.clip`): `result`, its
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
  /** `added`: texts already due after the answer (the rules on its arguments), held to the bound with it. */
  after(call: GateCall, result: LoopToolResult, signal: AbortSignal, added?: readonly string[]): Promise<GateAfter>;
  /**
   * The bound on what the model reads of a call answered without running its tool (a refusal, a
   * hold, a failure around it), as `after` holds an answer to it. Absent: such an answer goes as it is.
   */
  bound?(call: GateCall, answer: LoopToolResult, added?: readonly string[]): Promise<Bounded>;
}

/** What one model call is sent with besides its messages, decided per request. */
export interface CallSettings {
  sampling?: Sampling;
  /** The longest answer the call may give, in tokens. */
  maxTokens?: number;
}

/** Which call is about to be made, for deciding its settings. */
export interface CallRequest {
  agent: AgentRef;
  /** The agent's call number, from 1. */
  call: number;
  model: string;
}

/**
 * Keeps what a call is sent, where the user's setting asks for it (`trace.requests`): given the
 * call's number and its messages as sent, the path of the file they are kept in, which the call's
 * `call_started` names; undefined when this call's are not kept.
 */
export type KeepRequest = (call: number, messages: readonly Message[]) => string | undefined;

/** The limits a user sets for one agent's work (§10.11). Each absent is no limit. */
export interface AgentLimits {
  calls?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Wall time, in milliseconds. */
  time?: number;
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
  /** The text of its last message: a sub-agent's answer. Empty when it stopped first. */
  text: string;
  /** For `asked`: the question, as its tool gave it. */
  question?: JsonValue;
  usage: Usage;
}
