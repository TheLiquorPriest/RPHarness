// The host's own tools (for RPE: state, story and cast, and the engine's searchable tools, §6.8).
// An agent's definition lists the ones it holds fixed; the rest are reached through RPH's
// `tool_search` and `tool_use`. Each does one neutral thing when asked and reports what it did.

import type { AgentRef, Scope } from "./common";
import type { JsonSchema, JsonValue } from "./json";
import type { Switchable } from "./switches";

/**
 * What a tool may touch, which is what the user's permissions are decided by (§16): `read` changes
 * nothing; `write` changes what the host keeps; `external` acts outside the host (web, HTTP and MCP
 * tools).
 */
export type ToolTier = "read" | "write" | "external";

/** A piece of what a tool gives the model: text, or a picture (base64, with its type). */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * A tool's answer. It is clean when it has no `error` and no `reports`: a closing call whose result
 * is not clean keeps the run going for one more call (§10.7).
 */
export interface ToolResult {
  /** What the model is shown, in order. Every write's answer says what changed and how it now stands (§6.8). */
  content: ToolContent[];
  /** The call failed; `content` says how, in words that tell the model what it can do next. */
  error?: true;
  /**
   * What the call reports beyond doing what it was asked (a sum that does not balance, an operation
   * that no longer applies, §6.7): one line each, which RPH shows the model after `content`.
   */
  reports?: string[];
  /** Neutral marks a rule's condition can name (§10.5: a write with no source comes back marked `unsourced`). */
  marks?: string[];
  /** Data for the live view and the Turn page, never sent to the model. */
  details?: JsonValue;
}

/** What a tool's call runs with. */
export interface ToolCtx {
  scope: Scope;
  /** The agent that called it. */
  agent: AgentRef;
  /** The run the call is part of: the turn's, a job's or a talk's. */
  run: string;
  /** The model's id for the call. */
  callId: string;
  /** Ends the call: the turn was stopped or a limit was reached. A tool stops its work when it fires. */
  signal: AbortSignal;
  /** Shows part of the answer while the call runs, in the live view. Calls after the tool has answered are ignored. */
  onUpdate(partial: ToolResult): void;
}

/**
 * One of the host's tools. RPH adds one optional argument to every tool, `closing`, by which an
 * agent says the call needs no answer (§10.7); the tool never sees it. A tool reached through
 * `tool_use` is checked, permitted, ruled on, hooked and traced under its own name (§6.8).
 */
export interface HostTool {
  /**
   * Unique among the host's tools, and not the name of one of RPH's base tools (Y18). Letters,
   * digits, `_` and `-`, at most 64 long: a name every provider takes.
   */
  name: string;
  /** The family it belongs to, as the `.tools/` guides group them (§5.4). */
  family: string;
  tier: ToolTier;
  /**
   * For a tool that writes: the lane it writes to, so the user's Auto / Confirm / Never for that
   * lane applies (§6.8). Never `external`: that name is the setting of every tool of the external
   * tier, which is under it whatever lane it names.
   */
  lane?: string;
  /** What it does and when to use it. The text is the host's editable file (§5.4 "Tools"). */
  description: string;
  /** Its arguments, as an object schema. */
  parameters: JsonSchema;
  /**
   * For a tool that runs a command or calls out (an MCP server's tool, a command tool, an HTTP
   * tool): what it runs or calls. It is found, and run, only while the host's switches say that
   * thing is on (§16); RPH asks before every call, so a tool pinned in a definition's list waits too.
   */
  switchable?: Switchable;
  /**
   * Runs it. A thrown error is answered to the model as a failed call, in the words of the `failed`
   * line of `.prompts/tool-notices.md`; the error's own message goes to the trace (the call's
   * details), never to a model. A tool whose failure the model should be told why returns a result
   * marked `error` in words from its own files.
   */
  run(args: JsonValue, ctx: ToolCtx): Promise<ToolResult>;
}

export interface ToolsPort {
  /**
   * The host's tools for this scope. The list does not change within a session (§6.8: "the list
   * itself never changes in a session"), so the cached front of every prompt holds.
   */
  all(scope: Scope): Promise<HostTool[]>;
}
