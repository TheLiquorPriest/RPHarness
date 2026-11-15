// One run's trace (a turn's, a job's or a talk's): every agent of the run writes through the same
// writer, so records are numbered from 1 with no gap across all of them, and each carries the agent
// and the run it belongs to.
import type { AgentRef, Scope, TraceEvent, TracePort, TraceRecord } from "../contract";
import type { LoopClock, RunHold } from "./types";

/** The agent, run and tool call that started or continued a sub-agent's work. */
export type ParentCall = NonNullable<TraceRecord["parent"]>;

export class RunTrace {
  readonly port: TracePort;
  readonly scope: Scope;
  readonly run: string;
  readonly clock: LoopClock;
  /** The owner's hand on the run, which every agent of it asks before each request. */
  readonly hold: RunHold | undefined;
  readonly #watchers: ((record: TraceRecord) => void)[] = [];
  #seq = 0;

  constructor(port: TracePort, scope: Scope, run: string, clock: LoopClock, hold?: RunHold) {
    this.port = port;
    this.scope = scope;
    this.run = run;
    this.clock = clock;
    this.hold = hold;
  }

  /** Also gives every record to `watcher`, after the port: the progress clock follows what agents do. */
  watch(watcher: (record: TraceRecord) => void): void {
    this.#watchers.push(watcher);
  }

  event(agent: AgentRef, parent: ParentCall | undefined, event: TraceEvent): void {
    this.#seq += 1;
    const record: TraceRecord = { seq: this.#seq, run: this.run, scope: this.scope, at: this.clock.now(), agent, ...(parent ? { parent } : {}), event };
    this.port.event(record);
    for (const watcher of this.#watchers) watcher(record);
  }

  delta(agent: AgentRef, call: number, piece: { text: string } | { thinking: string }): void {
    this.port.delta({ run: this.run, agent: agent.id, call, ...piece, at: this.clock.now() });
  }
}
