// What each agent of a run did, in a file of its own (§5.3 `transcripts/`, §13.4): one line per
// message its model wrote, per tool call and per result, appended as the run goes, written by RPH
// through the host's file port whatever the host's trace keeps. Every agent of a turn writes one in
// the turn's folder (the lead, each sub-agent, the writer, a judging call, a compaction's summary
// call); a job's agents under the turn that started the job, or in the job's own session folder
// when the owner started it. Each line is JSON: `{"at":…,"type":"message"|"call"|"result",…}`.
import type { AgentRef, FilesPort, JsonObject, Log, RunScope, TraceEvent } from "../contract";
import type { AgentRecord, RunTrace } from "../loop/trace";
import { agentFileName, TRANSCRIPTS } from "./requests";

export interface TranscriptsDeps {
  files: FilesPort;
  scope: RunScope;
  /** The folder the run's `transcripts/` is in: the turn's, or the session's for a run with no turn. */
  folder: string;
  log: Log;
  /** Where each write is handed, so the run's end waits for it. */
  tell(written: Promise<unknown>): void;
}

/** Where an agent's transcript is: `transcripts/<definition>-<handle>.jsonl`, beside its requests. */
export function transcriptPath(folder: string, agent: AgentRef): string {
  return `${folder}${TRANSCRIPTS}${agentFileName(agent)}.jsonl`;
}

/** A record as its agent's transcript keeps it: a message, a tool call or a result; nothing for any other record. */
function lineOf(event: TraceEvent): JsonObject | undefined {
  switch (event.kind) {
    case "call_ended":
      return { type: "message", call: event.call, text: event.text, ...(event.thinking !== undefined ? { thinking: event.thinking } : {}), toolCalls: event.toolCalls.map((call) => ({ id: call.id, name: call.name, args: call.args })), stop: event.stop };
    case "tool_started":
      return { type: "call", callId: event.callId, tool: event.tool, args: event.args, ...(event.via !== undefined ? { via: event.via } : {}) };
    case "tool_ended":
      return { type: "result", callId: event.callId, tool: event.tool, result: { content: event.result.content, ...(event.result.reports !== undefined ? { reports: event.result.reports } : {}), ...(event.result.error === true ? { error: true } : {}) }, clean: event.clean };
    default:
      return undefined;
  }
}

/** Writes every agent's transcript of one run, as its trace hears it. */
export class Transcripts {
  readonly #d: TranscriptsDeps;
  /** Each file's last append, so its lines land in the order they were made. */
  readonly #last = new Map<string, Promise<unknown>>();

  constructor(deps: TranscriptsDeps) {
    this.#d = deps;
  }

  /** Follows a run's trace from now on. */
  follow(trace: RunTrace): void {
    trace.watch((record) => this.#take(record));
  }

  #take(record: AgentRecord): void {
    const line = lineOf(record.event);
    if (line === undefined) return;
    const d = this.#d;
    const path = transcriptPath(d.folder, record.agent);
    const text = `${JSON.stringify({ at: record.at, ...line })}\n`;
    const appended = (this.#last.get(path) ?? Promise.resolve())
      .then(() => d.files.write(d.scope, path, { op: "append", text }, "harness"))
      .then(
        (done) => {
          if (done.status !== "written") d.log.warn("A line of an agent's transcript could not be written.", { agent: record.agent.id, path, status: done.status });
        },
        (error: unknown) => d.log.warn("A line of an agent's transcript could not be written.", { agent: record.agent.id, path, error: error instanceof Error ? error.message : String(error) }),
      );
    this.#last.set(path, appended);
    d.tell(appended);
  }
}
