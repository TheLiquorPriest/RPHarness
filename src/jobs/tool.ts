// `job_start` (§13.5, §6.8): an agent that holds it starts background work, a run of its own that
// outlives the turn's reply, with a definition and a brief as `delegate` takes them, or the one an
// earlier job of the chat had that was interrupted, failed or cancelled (`repeats`, §13.5: "You or
// the Author start it again"). It answers at once, in the words of `.prompts/jobs.md`; how the job
// ends is told to the host. What it does is the harness's jobs' (`JobsWork`). Each run, a turn's or a
// job's, makes its own `job_start`, which counts the jobs that run's agents start against the user's
// `jobs.perRun`. `job_list`, `job_read` and `job_cancel` (`./tools`) are the same family, reached
// through the search.
import type { ToolCtx } from "../contract";
import type { DelegateCall } from "../agents/tools";
import type { LoopToolResult } from "../loop/types";
import { argumentsOf, fieldsOf, type OwnTool, text, type ToolText } from "../tools/kit";

/** The tool's name, whose file the harness reads with its other tools' (`.tools/job_start.md`). */
export const JOB_START = "job_start";

/** What `job_start` asks of the harness's jobs: a delegate's call, and the earlier job it repeats where it names one. */
export interface JobCall extends DelegateCall {
  repeats?: string;
}

/** The jobs the agents of one run have started, and the most they may (the user's `jobs.perRun`); absent, no limit. */
export interface RunJobs {
  started: number;
  max?: number;
}

/** What the job tools do: the harness's jobs. Each answers in the words of `.prompts/jobs.md`, for the caller's chat alone. */
export interface JobsWork {
  /** Starts a job for an agent's call, tied to the caller's turn and counted among `run`'s; answers with what became of it. */
  startFor(call: JobCall, ctx: ToolCtx, run: RunJobs): Promise<LoopToolResult>;
  /** The jobs of the caller's chat, the latest started first, at most `most` of them. */
  listFor(ctx: ToolCtx, most: number): Promise<LoopToolResult>;
  /** One job of the caller's chat, its brief and its report whole. */
  readFor(ctx: ToolCtx, id: string): Promise<LoopToolResult>;
  /** Stops a job of the caller's chat that an agent started; one the player started is his to stop. */
  cancelFor(ctx: ToolCtx, id: string): Promise<LoopToolResult>;
}

/** `job_start` for one run: `max` is the most jobs its agents may start, from the run's settings. */
export function jobStart(work: JobsWork, own: ToolText | undefined, max: number | undefined): OwnTool {
  const run: RunJobs = { started: 0, ...(max !== undefined ? { max } : {}) };
  return {
    name: JOB_START,
    family: "jobs",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ agent: { type: "string" }, brief: { type: "string" }, attach: { type: "array", items: { type: "string" } }, plays: { type: "string" }, returns: { type: "string" }, repeats: { type: "string" } }, [], own),
    run: (args, ctx) => {
      const given = fieldsOf(args);
      const attach = given["attach"];
      const plays = text(given, "plays");
      const returns = text(given, "returns");
      const repeats = text(given, "repeats");
      return work.startFor(
        {
          agent: text(given, "agent") ?? "",
          brief: text(given, "brief") ?? "",
          attach: Array.isArray(attach) ? attach.filter((item): item is string => typeof item === "string") : [],
          ...(plays !== undefined && plays.trim() !== "" ? { plays } : {}),
          ...(returns !== undefined && returns.trim() !== "" ? { returns } : {}),
          ...(repeats !== undefined && repeats.trim() !== "" ? { repeats: repeats.trim() } : {}),
        },
        ctx,
        run,
      );
    },
  };
}
