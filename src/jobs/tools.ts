// `job_list`, `job_read` and `job_cancel` (§13.5, §6.8): the rest of the jobs family beside
// `job_start`, held by no definition's list and found with `tool_search`, called with `tool_use`. An
// agent sees the jobs of its own chat: lists them, reads one whole (its brief and its report), and
// cancels one an agent started. What each does and says is the harness's jobs' (`JobsWork`), in the
// words of `.prompts/jobs.md`.
import { argumentsOf, fieldsOf, type OwnTool, text, type ToolText } from "../tools/kit";
import type { JobsWork } from "./tool";

export const JOB_LIST = "job_list";
export const JOB_READ = "job_read";
export const JOB_CANCEL = "job_cancel";

/** The jobs family's tools beside `job_start`, whose files the harness reads with its other tools'. */
export const JOB_SEARCHED = [JOB_LIST, JOB_READ, JOB_CANCEL] as const;

/** The three tools for one run: `most` is the most jobs `job_list` gives, from the user's `tools.perCall`. */
export function jobTools(work: JobsWork, texts: ReadonlyMap<string, ToolText>, most: number): OwnTool[] {
  return [
    {
      name: JOB_LIST,
      family: "jobs",
      tier: "read",
      description: texts.get(JOB_LIST)?.description ?? "",
      parameters: argumentsOf({}, [], texts.get(JOB_LIST)),
      run: (_args, ctx) => work.listFor(ctx, most),
    },
    {
      name: JOB_READ,
      family: "jobs",
      tier: "read",
      description: texts.get(JOB_READ)?.description ?? "",
      parameters: argumentsOf({ job: { type: "string" } }, ["job"], texts.get(JOB_READ)),
      run: (args, ctx) => work.readFor(ctx, text(fieldsOf(args), "job") ?? ""),
    },
    {
      name: JOB_CANCEL,
      family: "jobs",
      tier: "read",
      description: texts.get(JOB_CANCEL)?.description ?? "",
      parameters: argumentsOf({ job: { type: "string" } }, ["job"], texts.get(JOB_CANCEL)),
      run: (args, ctx) => work.cancelFor(ctx, text(fieldsOf(args), "job") ?? ""),
    },
  ];
}
