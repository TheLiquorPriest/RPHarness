// The live view's way in (Appendix A `LiveApi`): which runs are going on now, and every event and
// piece of streaming text of the runs a page follows, as it happens. Everything a run does already
// goes to the host's trace; this hands the same to whoever subscribed.
import type { AgentRef, LiveApi, LiveFilter, LiveItem, RunView, Scope, TracePort, TraceRecord } from "../contract";

export class LiveHub implements LiveApi {
  readonly #runs = new Map<string, RunView>();
  readonly #listeners = new Set<{ filter: LiveFilter; listener: (item: LiveItem) => void }>();

  /** A trace port that gives every record and piece to `port`, then to the subscribers whose filter takes it. */
  tee(port: TracePort, scope: Scope): TracePort {
    return {
      event: (record) => {
        port.event(record);
        this.#event(record);
      },
      delta: (delta) => {
        port.delta(delta);
        this.#send({ type: "delta", scope, delta }, scope, delta.run);
      },
      flush: () => port.flush(),
    };
  }

  /** A run began. */
  started(view: RunView): void {
    this.#runs.set(view.run, { ...view, agents: [...view.agents] });
  }

  /** A run ended. */
  ended(run: string): void {
    this.#runs.delete(run);
  }

  running(user: string): RunView[] {
    return [...this.#runs.values()].filter((view) => view.scope.user === user).map((view) => ({ ...view, agents: [...view.agents] }));
  }

  subscribe(filter: LiveFilter, listener: (item: LiveItem) => void): () => void {
    const entry = { filter, listener };
    this.#listeners.add(entry);
    return () => this.#listeners.delete(entry);
  }

  #event(record: TraceRecord): void {
    if (record.event.kind === "agent_started") this.#joined(record.run, record.agent);
    this.#send({ type: "event", record }, record.scope, record.run);
  }

  #joined(run: string, agent: AgentRef): void {
    const view = this.#runs.get(run);
    if (view !== undefined && !view.agents.some((known) => known.id === agent.id)) view.agents.push(agent);
  }

  #send(item: LiveItem, scope: Scope, run: string): void {
    for (const { filter, listener } of this.#listeners) {
      if (filter.user !== scope.user || (filter.chat !== undefined && filter.chat !== scope.chat) || (filter.run !== undefined && filter.run !== run)) continue;
      // A listener that throws is the page's own trouble; the run goes on and the others still hear.
      try {
        listener(item);
      } catch {
        continue;
      }
    }
  }
}
