// The folder host's trace: every event as a line of `host/chats/<chat>/trace.jsonl`, in the order
// given. The folder host has no live view, so streaming text is shown nowhere and not kept, as the
// contract lets a host do (`TracePort.delta`).

import { join } from "node:path";
import type { Log, TracePort } from "../../contract/index";
import type { Appender } from "./disk";
import type { Site } from "./site";

/** Where a chat's trace is kept. */
export function tracePath(site: Site, chat: string): string {
  return join(site.chatRecords(chat), "trace.jsonl");
}

export function folderTrace(site: Site, appender: Appender, log: Log): TracePort {
  return {
    event(record) {
      // A trace call never throws into the run that made it: an event the host cannot keep is logged.
      try {
        site.check(record.scope);
      } catch (error) {
        log.error("A trace event with a scope this host cannot keep was dropped.", { kind: record.event.kind, run: record.run, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      appender.line(tracePath(site, record.scope.chat), record);
    },
    delta() {
      // Nothing shows streaming text in the folder host; see the note at the top.
    },
    flush: () => appender.flush(),
  };
}
