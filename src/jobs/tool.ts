// `job_start` (§13.5, §6.8): an agent that holds it starts background work, a run of its own that
// outlives the turn's reply, with a definition and a brief as `delegate` takes them. It answers at
// once, in the words of `.prompts/jobs.md`; how the job ends is told to the host. What it does is
// the harness's jobs' (`JobsWork`). Each run, a turn's or a job's, makes its own `job_start`, which
// counts the jobs that run's agents start against the user's `jobs.perRun`.
import type { ToolCtx } from "../contract";
import type { DelegateCall } from "../agents/tools";
import type { LoopToolResult } from "../loop/types";
import { argumentsOf, fieldsOf, type OwnTool, text, type ToolText } from "../tools/kit";

/** The tool's name, whose file the harness reads with its other tools' (`.tools/job_start.md`). */
export const JOB_START = "job_start";

/** The jobs the agents of one run have started, and the most they may (the user's `jobs.perRun`); absent, no limit. */
export interface RunJobs {
  started: number;
  max?: number;
}

/** What `job_start` does: the harness's jobs. */
export interface JobsWork {
  /** Starts a job for an agent's call, tied to the caller's turn and counted among `run`'s; answers with what became of it. */
  startFor(call: DelegateCall, ctx: ToolCtx, run: RunJobs): Promise<LoopToolResult>;
}

/** `job_start` for one run: `max` is the most jobs its agents may start, from the run's settings. */
export function jobStart(work: JobsWork, own: ToolText | undefined, max: number | undefined): OwnTool {
  const run: RunJobs = { started: 0, ...(max !== undefined ? { max } : {}) };
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
        run,
      );
    },
  };
}
