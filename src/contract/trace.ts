// Everything RPH does, as events (Appendix A `trace`). The live view, the Turn page and every
// measurement are built from these: each agent's run as its own session, tied to the call that
// started it (§13.4), and nothing done that is not shown (§18.4: a piece is not done if its work
// cannot be watched).

import type { AgentRef, Effort, RunScope, Usage } from "./common";
import type { RuleFiring } from "./events";
import type { JobView } from "./harness";
import type { JsonValue } from "./json";
import type { PromptNotice } from "./prompt";
import type { ToolResult } from "./tools";
import type { LimitHit, Release, RunOutcome, Sampling, TurnKind } from "./turn";
import type { ApprovalAnswer, LanePermission } from "./approvals";
import type { Switchable, SwitchState } from "./switches";

/**
 * Why a tool call never ran, as a fact on its end record (C1's note), so the record says why after
 * the words of the tool answers' file are gone: a limit spent before it started (R-194); a call past
 * the count of tool calls one answer may make (`answer`, that count); the thing it calls out to not
 * switched on for the user; its lane set to Never; the user's no, with his reason; a rule that held
 * it; or a permission or a rule that could not be asked (`error`, the failure's own words, for the
 * trace alone).
 */
export type CallRefusal =
  | { by: "limit"; hit: LimitHit }
  | { by: "answer"; max: number }
  | { by: "switch"; thing: Switchable; state: SwitchState }
  | { by: "never"; lane: string }
  | { by: "declined"; lane: string; reason?: string }
  | { by: "hold"; rule: string }
  | { by: "unasked"; error: string }
  /** A hook before the call blocked it (§5.4 "Hooks"): its name and its reason, which is the call's answer. */
  | { by: "hook"; hook: string; reason: string };

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
  /**
   * An agent began work, on its model, in its own session, with what it was given by name. `tools`:
   * the size of the fixed list its requests declare, in tokens as the model layer counts a call's
   * tools, and the user's `tools.fixedTokens`; it is over where `tokens` passes `most`, and nothing is
   * refused for that (a lead's). `judges`: the call is a judging model's (§5.4), answering the
   * question rule `rule` about a message of the agent `agent` (its handle), so the live view shows a
   * judge, not another author.
   */
  | { kind: "agent_started"; definition: string; connection: string; model: string; effort?: Effort; session: string; given: string[]; tools?: { tokens: number; most: number }; judges?: { rule: string; agent: string } }
  /**
   * A tool an agent's list names is not held (§6.8), told once a session and definition: its
   * definition lists a name nobody registered (`unregistered`); a host's tool takes a name of RPH's
   * own and is left out (`shadowed`); or a tool the session declared as it opened has since been
   * withdrawn by the host (`withdrawn`), and answers that it is gone.
   */
  | { kind: "tool_unheld"; tool: string; definition: string; reason: "unregistered" | "shadowed" | "withdrawn" }
  /**
   * The lead's intent record began (§10.3): in the tag form, its opening tag was read; where the lead
   * writes it into the turn's folder itself, that write began. Its end is the `intent` that follows.
   */
  | { kind: "intent_began" }
  /** The lead's intent record (§10.3), as it was written: its end. */
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
  /**
   * A call held by its connection's throttle (§13.2): `minute`, its requests or tokens over the last
   * minute; `place`, its calls at once. Told as the wait begins, and again with `ms`, how long it
   * waited, as it ends.
   */
  | { kind: "connection_wait"; connection: string; for: "minute" | "place"; ms?: number }
  /**
   * A call waits for a place (§10.11): `tool`, one of an answer's tool calls past the agent's tool
   * calls at once; `agent`, a sub-agent (`delegate`, `agent_message`) past the run's sub-agents at
   * once, on the trace of the agent that called. Told as the wait begins, and again with `ms`, how
   * long it waited, as it ends; a call stopped in line is told no end.
   */
  | { kind: "waiting"; for: "tool" | "agent"; callId: string; tool: string; ms?: number }
  /** The agent's definition names a connection that is no longer there: its call went on the default connection (`used`), with that connection's own model. */
  | { kind: "connection_stand_in"; named: string; used: string }
  /**
   * The provider refused the thinking level a call asked for (`asked`), now or within
   * `calls.effortRefusalMinutes`: the call went at the next level down its model has (`sent`, `off`
   * at the last) on that connection's model.
   */
  | { kind: "effort_lowered"; connection: string; model: string; asked: Effort; sent: Effort }
  /** A tool call began; `via` when it was reached through `tool_use`. */
  | { kind: "tool_started"; callId: string; tool: string; args: JsonValue; via?: "tool_use" }
  /** Part of a tool's answer, while it runs. */
  | { kind: "tool_update"; callId: string; tool: string; partial: ToolResult }
  /**
   * A tool's answer: whether it was clean, and whether it ended the agent's work (a question, §10.5). For a write
   * or external tool, the permission it ran under, or would have run under, Auto included (`never`:
   * refused; `confirm`: with the user's word), a call a limit or a switch kept from starting included.
   * `refused`: why a call that never ran did not (C1's note). A found tool's record is under its own name.
   */
  | { kind: "tool_ended"; callId: string; tool: string; result: ToolResult; clean: boolean; endedRun: boolean; ms: number; permission?: CallPermission; refused?: CallRefusal }
  /** A rule fired (§5.4), as it fired: its `then` comes later, in `TurnEvents.ruleFired`. */
  | { kind: "rule_fired"; firing: RuleFiring }
  /** A rule's pattern ran out of `rules.patternTime` on a text (R-55): that check counted as no match, and the rule stays in force. `length`: the text's, in characters. */
  | { kind: "rule_failed"; rule: string; path: string; why: "time"; length: number }
  /** A rule's command failed or ran out of `rules.commandTimeout` (C5): the rule did not fire, and is unable to work, never a "no". `detail`: why, in words. */
  | { kind: "rule_failed"; rule: string; path: string; why: "command"; detail: string }
  /** A question rule's question cannot be put (§5.4, §17.2): the judging model's part is missing, off or names no `yes:`, its connection is none, or it has no model. Shown each time it would be asked, never taken as a "no". `detail`: what is missing, in words. */
  | { kind: "rule_failed"; rule: string; path: string; why: "judge"; detail: string }
  /**
   * A hook ran (§5.4 "Hooks", C2): which, at which moment, what it did, and how long it took; for a
   * tool's moments, the call (`callId`); `text`: its reason where it blocked, failed or timed out, or
   * what it added. The record's agent is the one it ran for.
   */
  | { kind: "hook"; hook: string; on: HookEvent; outcome: "ok" | "added" | "changed" | "blocked" | "failed" | "timed-out"; ms: number; callId?: string; text?: string }
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
  /** The owner held the run (§14, C-19): this agent waits, before its call number `call`'s request, until the run is let go. */
  | { kind: "paused"; call: number }
  /** The run was let go: this agent's call number `call` goes out, after `ms` of waiting. */
  | { kind: "resumed"; call: number; ms: number }
  /** The owner said something to the run's main agent (§14): it hears `text` at call number `call`, as his words. */
  | { kind: "said"; call: number; text: string }
  /** The reply was released (§10.7). */
  | { kind: "released"; release: Release }
  /**
   * The turn went quiet and the chat's progress file has no line to send (§10.7, READINGS R-124):
   * nothing keeps it alive, so its limit on wall time was held at `time` milliseconds, under the ten
   * minutes after which the chat application ends a generation that shows nothing. Once in a turn.
   */
  | { kind: "progress_missing"; time: number }
  /**
   * A run was compacted (§11, S-9): `session`, the session of the run compacted (a lead's scene, a
   * sub-agent's or a job's own); why (`would-not-fit`, a call would not fit its model's window less
   * the reserve; `refused`, the provider refused one as too long; `asked`, the host asked; `fold`, the
   * records mode's records passed their size); what it summarized (`turns`, the session's earlier
   * turns, with how many of the newest it kept as they were; `run`, the run's own older calls); and
   * the request's size as counted before and after, in tokens.
   */
  | { kind: "compacted"; session: string; reason: "would-not-fit" | "refused" | "asked" | "fold"; of: "turns" | "run"; before: number; after: number; keptTurns?: number }
  /**
   * A session opened, closed, forked from another (`from`, the session it was forked from), or opened
   * again: by the owner's undo of his own close (`by`), or because the turn that closed it left the
   * path (§11). `turn`: the turn whose work the change is, or that left or was shown again; `by`: the
   * change was the owner's own press (S-3, S-4). `unreadable`: its file could not be read, `reason`
   * saying why (§17.2: failure is allowed, and visible).
   */
  | { kind: "session"; session: string; change: "opened" | "closed" | "forked" | "reopened" | "unreadable"; from?: string; turn?: string; by?: "user"; reason?: string }
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
  scope: RunScope;
  at: number;
  /**
   * The agent it is about; for a run's own events, the agent the run started with. Absent for a
   * record of the host's word outside any agent's work (a session opened, closed, forked or opened
   * again by a call of the sessions API): a run of its own, numbered 1 (S-1).
   */
  agent?: AgentRef;
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
