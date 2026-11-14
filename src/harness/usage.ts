// What runs spent (Appendix A `UsageApi`): calls and tokens per run and per agent, what each user's
// runs spent on a day (kept in the host's store, so it outlives a restart), and how full each
// working agent's context is. Counted from the trace, as each agent's work ends.
import type { AgentRef, Clock, JsonValue, Log, RunUsage, Scope, StorePort, TraceRecord, Usage, UsageApi, WindowGauge } from "../contract";
import { addUsage, emptyUsage } from "../loop/budget";

/** How many finished runs' usage is kept to be asked for; the trace has every one. */
const KEPT_RUNS = 1_000;

interface RunBook {
  run: string;
  total: Usage;
  agents: Map<string, { agent: AgentRef; usage: Usage }>;
}

/** A usage as the store keeps it: its counts, each 0 where it holds none. */
function storedUsage(value: JsonValue | undefined): Usage {
  const fields = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  const number = (name: string): number => {
    const n = fields[name];
    return typeof n === "number" ? n : 0;
  };
  const reasoning = fields["reasoning"];
  return { calls: number("calls"), input: number("input"), cacheRead: number("cacheRead"), cacheWrite: number("cacheWrite"), output: number("output"), ...(typeof reasoning === "number" ? { reasoning } : {}) };
}

function gaugeKey(scope: Scope, agent: string): string {
  return JSON.stringify([scope.user, scope.chat, scope.session, scope.turn ?? null, agent]);
}

export class UsageBook implements UsageApi {
  readonly #store: StorePort;
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #runs = new Map<string, RunBook>();
  readonly #finished: string[] = [];
  readonly #gauges = new Map<string, WindowGauge>();
  /** Each run's agents with a gauge, so the gauges go when the run ends. */
  readonly #gauged = new Map<string, string[]>();
  /** Writes to the day's totals not yet kept. */
  readonly #writing = new Set<Promise<unknown>>();

  constructor(store: StorePort, clock: Clock, log: Log) {
    this.#store = store;
    this.#clock = clock;
    this.#log = log;
  }

  /** A run begins. */
  begin(run: string): void {
    this.#runs.set(run, { run, total: emptyUsage(), agents: new Map() });
  }

  /** An agent's model and the room it keeps for its answer, for its gauge while the run lasts. */
  gauge(scope: Scope, run: string, agent: string, window: number, reserve: number): void {
    const key = gaugeKey(scope, agent);
    this.#gauges.set(key, { used: 0, window, reserve });
    this.#gauged.set(run, [...(this.#gauged.get(run) ?? []), key]);
  }

  /** Every record of a run, as it happens. */
  record(record: TraceRecord): void {
    const { event } = record;
    if (event.kind === "call_ended") {
      const gauge = this.#gauges.get(gaugeKey(record.scope, record.agent.id));
      // What the call was sent is what the agent's context held.
      if (gauge !== undefined && event.usage.input > 0) gauge.used = event.usage.input;
      return;
    }
    if (event.kind !== "agent_ended") return;
    const book = this.#runs.get(record.run);
    if (book !== undefined) {
      addUsage(book.total, event.usage);
      const entry = book.agents.get(record.agent.id) ?? { agent: record.agent, usage: emptyUsage() };
      addUsage(entry.usage, event.usage);
      book.agents.set(record.agent.id, entry);
    }
    const user = record.scope.user;
    const day = this.#clock.day(record.at);
    const writing = this.#store
      .update(`usage/days/${day}`, (current) => {
        const days = typeof current === "object" && current !== null && !Array.isArray(current) ? { ...current } : {};
        const total = storedUsage(days[user]);
        addUsage(total, event.usage);
        days[user] = { ...total };
        return days;
      })
      .catch((error: unknown) => this.#log.error("A day's usage could not be kept.", { day, error: error instanceof Error ? error.message : String(error) }));
    this.#writing.add(writing);
    void writing.finally(() => this.#writing.delete(writing));
  }

  /** A run ended: its usage is kept to be asked for, and its gauges go. */
  end(run: string): void {
    for (const key of this.#gauged.get(run) ?? []) this.#gauges.delete(key);
    this.#gauged.delete(run);
    this.#finished.push(run);
    while (this.#finished.length > KEPT_RUNS) {
      const oldest = this.#finished.shift();
      if (oldest !== undefined) this.#runs.delete(oldest);
    }
  }

  /** Waits for the day's totals to be kept. */
  async settled(): Promise<void> {
    await Promise.all([...this.#writing]);
  }

  async run(run: string): Promise<RunUsage | undefined> {
    const book = this.#runs.get(run);
    if (book === undefined) return undefined;
    return { run, total: { ...book.total }, agents: [...book.agents.values()].map(({ agent, usage }) => ({ agent, usage: { ...usage } })) };
  }

  async day(user: string, day?: string): Promise<Usage> {
    const value = await this.#store.get(`usage/days/${day ?? this.#clock.day()}`);
    const kept = typeof value === "object" && value !== null && !Array.isArray(value) ? value[user] : undefined;
    return storedUsage(kept);
  }

  async window(scope: Scope, agent: string): Promise<WindowGauge | undefined> {
    const gauge = this.#gauges.get(gaugeKey(scope, agent));
    return gauge === undefined ? undefined : { ...gauge };
  }
}
