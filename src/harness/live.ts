// The live view's way in (Appendix A `LiveApi`): which runs are going on now, and every event and
// piece of streaming text of the runs a page follows, as it happens. Everything a run does goes to
// the host's trace first; this hands the same to whoever subscribed, off the run's way (§14): each
// listener has its own queue, sent in turn once the trace has the item, and a listener that returns
// a promise is sent its next item when that settles, so a slow page slows no agent and no other page.
// A listener that throws is logged once, with what it follows, and goes on being sent items. One
// that has left more of a run's items untaken than that run's setting `live.backlog` allows is cut
// off: logged, dropped, and told how far behind it was (C29). Each run hands `tee` the setting as it
// read it, so a listener following a turn and a job at once is held to each run's own for that
// run's items, and a change to the setting is taken by the next run. The owner's hand on each run
// going on is here too (C-19): he pauses a run of his, lets it go, or says something to its main
// agent, and every runner of the run asks the run's hold before each request.
import type { AgentRef, JsonValue, LiveApi, LiveFilter, LiveItem, Log, RunView, Scope, TracePort } from "../contract";
import { Holds } from "../jobs/hold";
import type { RunHold } from "../loop";
import { TRACE } from "./settings/trace";

export interface LiveHubOptions {
  /** Where a listener that throws, or that is cut off, is reported. */
  log?: Log;
}

/** An item a listener has yet to take, and the run it is of. */
interface Queued {
  readonly item: LiveItem;
  readonly run: string;
}

/** One subscription: what it follows, its listener, and what it has yet to take. */
interface Subscriber {
  readonly filter: LiveFilter;
  readonly listener: (item: LiveItem) => unknown;
  /** What it follows, as the log names it. */
  readonly fields: Record<string, JsonValue>;
  readonly queue: Queued[];
  /** How many of each run's items are in its queue, by the run. */
  readonly behind: Map<string, number>;
  /** Whether its queue is being sent now: a new item then waits its turn. */
  sending: boolean;
  /** Whether it has thrown before: that is logged once. */
  threw: boolean;
}

export class LiveHub implements LiveApi {
  readonly #runs = new Map<string, Omit<RunView, "held">>();
  /** The owner's hand on each run going on (C-19). */
  readonly holds = new Holds();
  readonly #subscribers = new Set<Subscriber>();
  readonly #log: Log | undefined;

  constructor(options: LiveHubOptions = {}) {
    this.#log = options.log;
  }

  /**
   * A trace port that gives every record and piece to `port`, then to the subscribers whose filter
   * takes it. `backlog` is the run's own `live.backlog`, read where the run holds its settings;
   * absent, the setting's default.
   */
  tee(port: TracePort, scope: Scope, backlog: () => number = () => TRACE.liveBacklog.default): TracePort {
    return {
      event: (record) => {
        port.event(record);
        if (record.event.kind === "agent_started" && record.agent !== undefined) this.#joined(record.run, record.agent);
        this.#send({ type: "event", record }, record.scope, record.run, backlog);
      },
      delta: (delta) => {
        port.delta(delta);
        this.#send({ type: "delta", scope, delta }, scope, delta.run, backlog);
      },
      flush: () => port.flush(),
    };
  }

  /** A run began. */
  started(view: Omit<RunView, "held">): void {
    this.#runs.set(view.run, { ...view, agents: [...view.agents] });
  }

  /** A run ended. */
  ended(run: string): void {
    this.#runs.delete(run);
    this.holds.close(run);
  }

  running(user: string): RunView[] {
    return [...this.#runs.values()].filter((view) => view.scope.user === user).map((view) => ({ ...view, agents: [...view.agents], held: this.holds.held(view.run) }));
  }

  /** The owner's hand on a run, for the runners that work in it. */
  hold(run: string): RunHold {
    return this.holds.of(run);
  }

  pause(user: string, run: string): boolean {
    return this.#owns(user, run) && this.holds.add(run, "paused");
  }

  letGo(user: string, run: string): boolean {
    return this.#owns(user, run) && this.holds.drop(run, "paused");
  }

  say(user: string, run: string, words: string): boolean {
    return this.#owns(user, run) && this.holds.say(run, words);
  }

  #owns(user: string, run: string): boolean {
    return this.#runs.get(run)?.scope.user === user;
  }

  subscribe(filter: LiveFilter, listener: (item: LiveItem) => unknown): () => void {
    const fields: Record<string, JsonValue> = { user: filter.user, ...(filter.chat !== undefined ? { chat: filter.chat } : {}), ...(filter.run !== undefined ? { run: filter.run } : {}) };
    const subscriber: Subscriber = { filter, listener, fields, queue: [], behind: new Map(), sending: false, threw: false };
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
      subscriber.queue.length = 0;
      subscriber.behind.clear();
    };
  }

  #joined(run: string, agent: AgentRef): void {
    this.holds.joined(run, agent);
    const view = this.#runs.get(run);
    if (view !== undefined && !view.agents.some((known) => known.id === agent.id)) view.agents.push(agent);
  }

  /** Puts `item` in the queue of each subscriber that follows it; the run's way goes on at once. */
  #send(item: LiveItem, scope: Scope, run: string, backlog: () => number): void {
    for (const subscriber of this.#subscribers) {
      const { filter } = subscriber;
      if (filter.user !== scope.user || (filter.chat !== undefined && filter.chat !== scope.chat) || (filter.run !== undefined && filter.run !== run)) continue;
      const behind = (subscriber.behind.get(run) ?? 0) + 1;
      const most = backlog();
      if (behind > most) {
        this.#cut(subscriber, run, most);
        continue;
      }
      subscriber.behind.set(run, behind);
      subscriber.queue.push({ item, run });
      if (subscriber.sending) continue;
      subscriber.sending = true;
      queueMicrotask(() => void this.#sendOn(subscriber));
    }
  }

  /** Sends the subscriber its queue in turn, each item once the one before it was taken, until the queue is empty or it is dropped. */
  async #sendOn(subscriber: Subscriber): Promise<void> {
    while (subscriber.queue.length > 0 && this.#subscribers.has(subscriber)) {
      const { item, run } = subscriber.queue.shift()!;
      const left = subscriber.behind.get(run)! - 1;
      if (left === 0) subscriber.behind.delete(run);
      else subscriber.behind.set(run, left);
      const taking = this.#hand(subscriber, item);
      if (taking !== undefined) await taking;
    }
    subscriber.sending = false;
  }

  /** Drops a subscriber that fell behind past the run's setting, logs it, and tells it how many items it had not taken. */
  #cut(subscriber: Subscriber, run: string, most: number): void {
    // What it had not taken: its queue, and the item that went past the setting.
    const behind = subscriber.queue.length + 1;
    this.#subscribers.delete(subscriber);
    subscriber.queue.length = 0;
    subscriber.behind.clear();
    this.#log?.warn("A live listener fell behind and was cut off: more of a run's items were left untaken than live.backlog allows.", { ...subscriber.fields, cutAt: run, behind, backlog: most });
    // Told off the run's way too, and at once: a listener stalled on its last item still hears it.
    queueMicrotask(() => void this.#hand(subscriber, { type: "cut", behind }));
  }

  /** Hands `item` to the listener: what it returned, where that is a promise to wait for. A throw, or a promise that fails, is logged once. */
  #hand(subscriber: Subscriber, item: LiveItem): PromiseLike<unknown> | undefined {
    try {
      const taken = subscriber.listener(item);
      if (typeof taken === "object" && taken !== null && "then" in taken && typeof taken.then === "function") {
        return Promise.resolve(taken).then(undefined, (error: unknown) => this.#threw(subscriber, error));
      }
    } catch (error) {
      this.#threw(subscriber, error);
    }
    return undefined;
  }

  /** A listener threw: the page's own trouble. The run goes on and the others still hear; it is logged the first time. */
  #threw(subscriber: Subscriber, error: unknown): void {
    if (subscriber.threw) return;
    subscriber.threw = true;
    this.#log?.warn("A live listener threw; it goes on being sent the items of the runs it follows.", { ...subscriber.fields, error: error instanceof Error ? error.message : String(error) });
  }
}
