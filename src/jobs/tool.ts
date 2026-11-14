// `job_start` (§13.5, §6.8): an agent that holds it starts background work, a run of its own that
// outlives the turn's reply, with a definition and a brief as `delegate` takes them. It answers at
// once, in the words of `.prompts/jobs.md`; how the job ends is told to the host. What it does is
// the harness's jobs' (`JobsWork`).
import type { ToolCtx } from "../contract";
import type { DelegateCall } from "../agents/tools";
import type { LoopToolResult } from "../loop/types";
import { argumentsOf, fieldsOf, type OwnTool, text, type ToolText } from "../tools/kit";

/** The tool's name, whose file the harness reads with its other tools' (`.tools/job_start.md`). */
export const JOB_START = "job_start";

/** What `job_start` does: the harness's jobs. */
export interface JobsWork {
  /** Starts a job for an agent's call, tied to the caller's turn; answers with what became of it. */
  startFor(call: DelegateCall, ctx: ToolCtx): Promise<LoopToolResult>;
}

export function jobStart(work: JobsWork, own: ToolText | undefined): OwnTool {
  return {
    name: JOB_START,
    family: "jobs",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ agent: { type: "string" }, brief: { type: "string" }, attach: { type: "array", items: { type: "string" } }, plays: { type: "string" }, returns: { type: "string" } }, ["agent", "brief"], own),
    run: (args, ctx) => {
      const given = fieldsOf(args);
      const attach = given["attach"];
      const plays = text(given, "plays");
      const returns = text(given, "returns");
      return work.startFor(
        {
          agent: text(given, "agent") ?? "",
          brief: text(given, "brief") ?? "",
          attach: Array.isArray(attach) ? attach.filter((item): item is string => typeof item === "string") : [],
          ...(plays !== undefined && plays.trim() !== "" ? { plays } : {}),
          ...(returns !== undefined && returns.trim() !== "" ? { returns } : {}),
        },
        ctx,
      );
    },
  };
}
