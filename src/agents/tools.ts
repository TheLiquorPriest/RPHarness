// RPH's own tools for sub-agents (§10.5, §13.3, §13.4): `delegate` starts an agent on a brief with
// what it is given; `ask_author` ends a sub-agent's work with its question for the agent that set
// it going; `agent_message` goes on with one where it stopped; `agent_drop` drops what one wrote,
// which the host staged under the turn. Each is described by its file in `.tools/`; what they do is
// the turn's team's (`TeamWork`).
import type { JsonValue, ToolCtx } from "../contract";
import type { LoopToolResult } from "../loop/types";
import { argumentsOf, fieldsOf, type OwnTool, text, type ToolText } from "../tools/kit";

/** The names of these tools, whose files the harness reads with its other tools' (`.tools/<name>.md`). */
export const AGENT_TOOLS = ["delegate", "ask_author", "agent_message", "agent_drop"] as const;

/** A `delegate` call: which definition, the brief, what it is given by name, the character it plays, what to send back, and whether it is kept past the turn's reply. */
export interface DelegateCall {
  agent: string;
  brief: string;
  attach: string[];
  plays?: string;
  returns?: string;
  keep?: boolean;
}

/** An `ask_author` call: the question, and what was looked for, and where, before asking. */
export interface AskCall {
  question: string;
  searched: string;
}

/** What may be invented, within what bounds, and the gap check it rests on (§10.5 step 5): recorded as a `ConsentGrant`. */
export interface ConsentArgument {
  topic: string;
  bounds?: string;
  gapCheck?: string;
}

/** An `agent_message` call: the agent by its handle, the message, a consent given with it, and whether it is kept past the turn's reply (absent: as it was). */
export interface MessageCall {
  agent: string;
  message: string;
  consent?: ConsentArgument;
  keep?: boolean;
}

/** An `agent_drop` call: the agent, by its handle, whose writes this turn are dropped. */
export interface DropCall {
  agent: string;
}

/** What the tools do, which is the turn's team's. */
export interface TeamWork {
  delegate(call: DelegateCall, ctx: ToolCtx): Promise<LoopToolResult>;
  ask(call: AskCall, ctx: ToolCtx): Promise<LoopToolResult>;
  message(call: MessageCall, ctx: ToolCtx): Promise<LoopToolResult>;
  drop(call: DropCall, ctx: ToolCtx): Promise<LoopToolResult>;
}

/** A text argument with something in it. */
function filled(args: Readonly<Record<string, JsonValue>>, name: string): string | undefined {
  const value = text(args, name);
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** A yes-or-no argument, as JSON or as its text; absent where it is neither. */
function yesNo(args: Readonly<Record<string, JsonValue>>, name: string): boolean | undefined {
  const value = args[name];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

export function delegate(work: TeamWork, own: ToolText | undefined): OwnTool {
  return {
    name: "delegate",
    family: "agents",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ agent: { type: "string" }, brief: { type: "string" }, attach: { type: "array", items: { type: "string" } }, plays: { type: "string" }, returns: { type: "string" }, keep: { type: "boolean" } }, ["agent", "brief"], own),
    run: (args, ctx) => {
      const given = fieldsOf(args);
      const plays = filled(given, "plays");
      const returns = filled(given, "returns");
      const keep = yesNo(given, "keep");
      const attach = given["attach"];
      return work.delegate({ agent: text(given, "agent") ?? "", brief: text(given, "brief") ?? "", attach: Array.isArray(attach) ? attach.filter((item): item is string => typeof item === "string") : [], ...(plays !== undefined ? { plays } : {}), ...(returns !== undefined ? { returns } : {}), ...(keep !== undefined ? { keep } : {}) }, ctx);
    },
  };
}

export function askAuthor(work: TeamWork, own: ToolText | undefined): OwnTool {
  return {
    name: "ask_author",
    family: "agents",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ question: { type: "string" }, searched: { type: "string" } }, ["question", "searched"], own),
    run: (args, ctx) => {
      const given = fieldsOf(args);
      return work.ask({ question: text(given, "question") ?? "", searched: text(given, "searched") ?? "" }, ctx);
    },
  };
}

export function agentMessage(work: TeamWork, own: ToolText | undefined): OwnTool {
  return {
    name: "agent_message",
    family: "agents",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf(
      {
        agent: { type: "string" },
        message: { type: "string" },
        consent: { type: "object", properties: { topic: { type: "string" }, bounds: { type: "string" }, gap_check: { type: "string" } }, required: ["topic"] },
        keep: { type: "boolean" },
      },
      ["agent", "message"],
      own,
    ),
    run: (args, ctx) => {
      const given = fieldsOf(args);
      const consent = fieldsOf(given["consent"] ?? null);
      const topic = filled(consent, "topic");
      const bounds = filled(consent, "bounds");
      const gapCheck = filled(consent, "gap_check");
      const keep = yesNo(given, "keep");
      return work.message(
        {
          agent: text(given, "agent") ?? "",
          message: text(given, "message") ?? "",
          ...(topic !== undefined ? { consent: { topic, ...(bounds !== undefined ? { bounds } : {}), ...(gapCheck !== undefined ? { gapCheck } : {}) } } : {}),
          ...(keep !== undefined ? { keep } : {}),
        },
        ctx,
      );
    },
  };
}

export function agentDrop(work: TeamWork, own: ToolText | undefined): OwnTool {
  return {
    name: "agent_drop",
    family: "agents",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ agent: { type: "string" } }, ["agent"], own),
    run: (args, ctx) => work.drop({ agent: text(fieldsOf(args), "agent") ?? "" }, ctx),
  };
}
