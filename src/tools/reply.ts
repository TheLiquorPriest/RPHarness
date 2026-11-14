// The reply tools (§6.8, §10.6, §10.7): `write_reply` hands the prose to a writer, as a draft or
// live; `reply_release` sends the last draft, or a finished file, whole. One reply per generation:
// the turn's reply desk answers a second attempt.
import type { ToolCtx } from "../contract";
import type { LoopToolResult } from "../loop/types";
import { argumentsOf, fieldsOf, type OwnTool, text, type ToolText } from "./kit";

/**
 * The family of the reply tools, which `out_of_reach:` names. Only an agent whose own list names one
 * of them reaches it: who releases the turn's one reply is the definitions' to say (§10.6).
 */
export const REPLY_FAMILY = "reply";

/** What the reply tools do, which is the turn's: its writer, its desk, its sink. */
export interface ReplyWork {
  /** The writer's call on the brief: a draft that comes back, or the reply live. */
  write(brief: string, live: boolean, ctx: ToolCtx): Promise<LoopToolResult>;
  /** Sends the last draft, or a file's text (`path`), whole. */
  release(path: string | undefined, ctx: ToolCtx): Promise<LoopToolResult>;
}

export function writeReply(work: ReplyWork, own: ToolText | undefined): OwnTool {
  return {
    name: "write_reply",
    family: REPLY_FAMILY,
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ brief: { type: "string" }, live: { type: "boolean" } }, ["brief"], own),
    // A writer's call and a release are one at a time: the reply is one.
    sequential: true,
    run: (args, ctx) => {
      const given = fieldsOf(args);
      return work.write(text(given, "brief") ?? "", given["live"] === true, ctx);
    },
  };
}

export function replyRelease(work: ReplyWork, own: ToolText | undefined): OwnTool {
  return {
    name: "reply_release",
    family: REPLY_FAMILY,
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ path: { type: "string" } }, [], own),
    sequential: true,
    run: (args, ctx) => work.release(text(fieldsOf(args), "path"), ctx),
  };
}
