// Everything RPH does, as events (Appendix A `trace`). The live view, the Turn page and every
// measurement are built from these: each agent's run as its own session, tied to the call that
// started it (§13.4), and nothing done that is not shown (§18.4: a piece is not done if its work
// cannot be watched).

import type { AgentRef, Effort, Scope, Usage } from "./common";
import type { RuleFiring } from "./events";
import type { JobView } from "./harness";
import type { JsonValue } from "./json";
import type { PromptNotice } from "./prompt";
import type { ToolResult } from "./tools";
import type { LimitHit, Release, RunOutcome, Sampling, TurnKind } from "./turn";
import type { ApprovalAnswer, LanePermission } from "./approvals";

/**
 * A tool call a model made: the model's id for it, the tool, and its arguments. `began`: when the
 * model began writing it (pi's `toolcall_start`), by the host's clock, so the floor can take the
 * intent record's own time out of "first words" on a two-step connection (§17.1); absent where the
 * provider gave the call whole, with no start of its own.
 */
export interface ToolCallView {
  id: string;
  name: string;
  args: JsonValue;
  began?: number;
}

/**
 * The permission a call of a write or external tool ran under (§6.8: each lane is Auto, Confirm or
 * Never per chat): the lane its tier puts it under (`external` for a tool of the external tier,
 * whatever lane it names), the user's setting for that lane (Auto where the host has no approvals
 * port), and under Confirm the user's word on this call. So the host keeps, per turn, what ran under
 * which setting (Appendix B `approval`; the review card, one per turn).
 */
export interface CallPermission {
  lane: string;
  setting: LanePermission;
  /** Under Confirm: the user's word. */
  answer?: ApprovalAnswer;
}

/**
 * How an agent's run ended: by itself; with a question to the lead (`ask_author` ends the run and
 * the question returns through `delegate`, §13.3); at a limit; stopped; or failed.
 */
export type AgentStatus = "done" | "asked" | "limit" | "stopped" | "failed";

/** The moments a hook can run at (§5.4 "Hooks"). */
export type HookEvent =
  | "turn-start"
  | "before-tool"
  | "after-tool"
  | "before-release"
  | "after-release"
  | "run-end"
  | "session-close"
  | "before-compaction"
  | "job-start"
  | "job-end";

/** One item of an agent's `todo` list (§6.8), as the live view shows it. */
export interface TodoItem {
  text: string;
  done: boolean;
}

/** What RPH did. Each kind's fields are the facts of it; every record carries who did it (`TraceRecord`). */
export type TraceEvent =
  /** A run began: a turn, a job's run, or a talk with an agent; `lead` is the definition it started with. */
  | { kind: "run_started"; run: "turn" | "job" | "talk"; turn?: TurnKind; lead: string }
  /** An agent began work, on its model, in its own session, with what it was given by name. */
  | { kind: "agent_started"; definition: string; connection: string; model: string; effort?: Effort; session: string; given: string[] }
  /** The lead's intent record (§10.3), as it was written. */
  | { kind: "intent"; text: string }
  /**
   * A model call was sent: the agent's call number, from 1, and what it carried. `request`: the file
   * in the turn's folder that holds the call's messages, in order, as role and text, where the
   * user's setting keeps them (`trace.requests`). `toolTokens` and `openingTokens`: the tokens of the
   * tool list as sent and of the agent's opening block, by RPH's own estimate; RPH gives both on
   * every call (absent only in records made before it did).
   */
  | { kind: "call_started"; call: number; connection: string; model: string; sampling?: Sampling; maxTokens?: number; messages: number; tools: number; request?: string; toolTokens?: number; openingTokens?: number }
  /** A model call's answer, whole: its text, its thinking where the provider gave it, its tool calls, why it stopped, its tokens, its time; or its failure. */
  | { kind: "call_ended"; call: number; model: string; text: string; thinking?: string; toolCalls: ToolCallView[]; stop: string; usage: Usage; ms: number; error?: string }
  /** A tool call began; `via` when it was reached through `tool_use`, and `closing` when the agent marked it so (§10.7). */
  | { kind: "tool_started"; callId: string; tool: string; args: JsonValue; closing: boolean; via?: "tool_use" }
  /** Part of a tool's answer, while it runs. */
  | { kind: "tool_update"; callId: string; tool: string; partial: ToolResult }
  /**
   * A tool's answer: whether it was clean, and whether it ended the batch's run (§10.7). For a write
   * or external tool, the permission it ran under, Auto included (`never`: refused; `confirm`: with
   * the user's word); a call refused before its permission was read (a tool switched off) has none.
   */
  | { kind: "tool_ended"; callId: string; tool: string; result: ToolResult; clean: boolean; endedRun: boolean; ms: number; permission?: CallPermission }
  /** A rule fired (§5.4), as it fired: its `then` comes later, in `TurnEvents.ruleFired`. */
  | { kind: "rule_fired"; firing: RuleFiring }
  /** A hook ran (§5.4 "Hooks"): what it did, and how long it took. */
  | { kind: "hook"; hook: string; on: HookEvent; outcome: "ok" | "added" | "changed" | "blocked" | "failed" | "timed-out"; ms: number }
  /** A write to a lane set to Confirm waits for the user's word (§6.8). */
  | { kind: "approval_asked"; callId: string; tool: string; lane: string }
  | { kind: "approval_answered"; callId: string; tool: string; lane: string; answer: ApprovalAnswer }
  /**
   * Prompt notices of this turn (§4.8). `pictures`: each message of the prompt, by its place, that
   * held pictures the agent's request could not carry (a system or assistant message carries text
   * alone), with how many; the host words what the agent is told of them, if anything.
   */
  | { kind: "prompt_notices"; notices: PromptNotice[]; pictures?: { message: number; count: number }[] }
  /** An agent's `todo` list as it now stands (§6.8). */
  | { kind: "todo"; items: TodoItem[] }
  /** A limit was reached (§10.11). */
  | { kind: "limit"; hit: LimitHit }
  /** The reply was released (§10.7). */
  | { kind: "released"; release: Release }
  /** A session was compacted (§11): its tokens before and after, and how many of its newest turns were kept as they were. */
  | { kind: "compacted"; session: string; before: number; after: number; keptTurns: number }
  /** A session opened, closed, forked from another, or opened again because the turn that closed it left the path (§11). */
  | { kind: "session"; session: string; change: "opened" | "closed" | "forked" | "reopened"; from?: string }
  /** A job's state changed (§13.5). */
  | { kind: "job"; job: JobView }
  /** An agent's run ended. */
  | { kind: "agent_ended"; status: AgentStatus; limit?: LimitHit; usage: Usage }
  /** The run ended. */
  | { kind: "run_ended"; outcome: RunOutcome };

/** Every kind of event. */
export type TraceKind = TraceEvent["kind"];

/** An event with who did it and where. */
export interface TraceRecord {
  /** Its number within its run, from 1, with no gap. */
  seq: number;
  /** The run's own id, made by the harness's `ids` when the run starts: each run of a turn (its first, a continue, a "Settle now"), a job's, a talk's. Never the turn's id; the turn is in `scope`. */
  run: string;
  scope: Scope;
  at: number;
  /** The agent it is about; for a run's own events, the agent the run started with. */
  agent: AgentRef;
  /** For a sub-agent or a job: the agent, run and tool call that started it, so the live view shows the tree (§13.4). */
  parent?: { agent: string; run: string; call: string };
  event: TraceEvent;
}

/** Text of a model call as it streams, for the live view only: what arrived since the last piece. Never numbered; the call's `call_ended` holds the whole. */
export interface TraceDelta {
  run: string;
  agent: string;
  call: number;
  text?: string;
  thinking?: string;
  at: number;
}

export interface TracePort {
  /** One event, in order. Never answered; the host keeps it. */
  event(record: TraceRecord): void;
  /** A piece of streaming text, in order, before its call's `call_ended`. The host may show it and drop it. */
  delta(delta: TraceDelta): void;
  /** Resolves once every event given so far is kept. */
  flush(): Promise<void>;
}
