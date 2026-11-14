// The one question the contract carries, and it is the user's (Appendix A): whether a write to a
// lane the user set to Confirm goes ahead (§6.8: each lane is Auto, Confirm or Never per chat).
// A tool of the external tier (web, HTTP, MCP; §16) has a setting of its own beside the lanes,
// named `external`, with the same three values, whatever lane it names.

import type { AgentRef, Scope } from "./common";
import type { JsonValue } from "./json";

/** The user's setting for a lane: writes go ahead; wait for the user's word; never go ahead. */
export type LanePermission = "auto" | "confirm" | "never";

/** A call held for the user's word: which call of which agent, the tool, its lane (or `external`) and its arguments. */
export interface ApprovalAsk {
  agent: AgentRef;
  callId: string;
  tool: string;
  /** The lane it writes to, or `external` for a tool of the external tier. */
  lane: string;
  args: JsonValue;
  /** When it was asked, in milliseconds since 1970. */
  at: number;
}

/** The user's word: go ahead, or not (with a reason the agent is given). */
export type ApprovalAnswer = { go: true } | { go: false; reason?: string };

/** Without it, every lane is Auto, and `external` too (Appendix D.1: "Write permission, each lane: Auto"). */
export interface ApprovalsPort {
  /** The user's setting in this chat for a lane, or, asked with `external`, for the tools of the external tier. */
  permission(scope: Scope, lane: string): Promise<LanePermission>;
  /**
   * Asks the user and resolves with the answer. The signal ends the wait (the turn stopped or its
   * time ran out): the host takes the question down, and the promise rejects with the signal's reason.
   */
  ask(scope: Scope, ask: ApprovalAsk, signal: AbortSignal): Promise<ApprovalAnswer>;
}
