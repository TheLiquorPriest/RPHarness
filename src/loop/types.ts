// What the agent runner takes and gives, beyond the contract's own types.
import type { AgentRef, AgentStatus, Clock, JsonSchema, JsonValue, LimitHit, Sampling, ToolCtx, ToolResult, Usage } from "../contract";
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
 * Before a call runs. `refuse`: it does not run, and this is its answer (the user's permission said
 * no, in a file's words). `hold`: a rule on its arguments holds it, and the rule's text is its answer.
 * `remind`: rules on its arguments whose texts come back with its result.
 */
export interface GateBefore {
  refuse?: LoopToolResult;
  hold?: Fired;
  remind: Fired[];
}

/** After a call ran: its result as the model reads it (a long one clipped), and the rules on that result. */
export interface GateAfter {
  result: LoopToolResult;
  remind: Fired[];
}

/**
 * What runs around every tool call besides the tool (§13.3): before it, the user's permissions and
 * the rules on its arguments; after it, long results clipped and the rules on its result. It says
 * what is so; the runner traces the firings and puts their texts in front of the agent.
 */
export interface ToolGate {
  before(call: GateCall, signal: AbortSignal): Promise<GateBefore>;
  after(call: GateCall, result: LoopToolResult, signal: AbortSignal): Promise<GateAfter>;
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
