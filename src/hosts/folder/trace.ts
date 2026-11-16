// The folder host's trace: every event as a line of `trace.jsonl` in the run's records (its chat's,
// or its user's for a job of no chat), in the order given; and the streamed text of each run beside
// it, `deltas/<run>.jsonl`, a line per delta in the order given, read back by `readDeltas`. A delta
// of a run the host has had no event of yet is kept once its first event names where the run is.

import { join } from "node:path";
import type { Log, RunScope, TraceDelta, TracePort } from "../../contract/index";
import type { Appender } from "./disk";
import { readLines, safeId } from "./disk";
import type { Site } from "./site";

/** Where a run's trace is kept. */
export function tracePath(site: Site, scope: RunScope): string {
  return join(site.recordsOf(scope), "trace.jsonl");
}

/** Where a run's streamed text is kept. */
export function deltasPath(site: Site, scope: RunScope, run: string): string {
  return join(site.recordsOf(scope), "deltas", `${safeId("run", run)}.jsonl`);
}

/** A run's streamed text, in the order it came. */
export async function readDeltas(site: Site, scope: RunScope, run: string): Promise<TraceDelta[]> {
  return (await readLines(deltasPath(site, scope, run))) as TraceDelta[];
}

export function folderTrace(site: Site, appender: Appender, log: Log): TracePort {
  /** Each run's scope, from its events; deltas that came first wait for it. */
  const runs = new Map<string, RunScope>();
  const early = new Map<string, TraceDelta[]>();
  return {
    event(record) {
      // A trace call never throws into the run that made it: an event the host cannot keep is logged.
      try {
        site.check(record.scope);
      } catch (error) {
        log.error("A trace event with a scope this host cannot keep was dropped.", { kind: record.event.kind, run: record.run, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      appender.line(tracePath(site, record.scope), record);
      if (!runs.has(record.run)) {
        runs.set(record.run, record.scope);
        for (const delta of early.get(record.run) ?? []) appender.line(deltasPath(site, record.scope, record.run), delta);
        early.delete(record.run);
      }
      if (record.event.kind === "run_ended") runs.delete(record.run);
    },
    delta(delta) {
      const scope = runs.get(delta.run);
      if (scope === undefined) {
        const waiting = early.get(delta.run) ?? [];
        waiting.push(delta);
        early.set(delta.run, waiting);
        return;
      }
      try {
        appender.line(deltasPath(site, scope, delta.run), delta);
      } catch (error) {
        log.error("A run's streamed text could not be kept.", { run: delta.run, error: error instanceof Error ? error.message : String(error) });
      }
    },
    flush: () => appender.flush(),
  };
}
