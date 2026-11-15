// A clock for tests that moves only when the test moves it. Waits and timers fall due in order of
// their time (in order of setting, at the same time), and a test runs work to its end by jumping
// from one timer to the next whenever nothing else can happen. Nothing here waits on real time.

import type { Clock } from "../../contract";

interface Timer {
  at: number;
  run: () => void;
}

/** How many turns of the event loop `settle` lets pass before it takes the work to be waiting on a timer: enough for streams and callbacks the work set going to run their course. */
const IDLE_TURNS = 20;
/** How many timers `settle` fires at most, so that work that sets timers forever fails its test instead of hanging it. */
const MOST_TIMERS = 100_000;

/** One turn of the event loop: every callback already waiting runs first. */
function turn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** A contract `Clock` for tests. */
export class FakeClock implements Clock {
  private time: number;
  private made = 0;
  private readonly timers = new Map<number, Timer>();

  /** `start`: the time it starts at. */
  constructor(start = 0) {
    this.time = start;
  }

  readonly now = (): number => this.time;

  readonly setTimeout = (run: () => void, ms: number): number => {
    this.made += 1;
    this.timers.set(this.made, { at: this.time + Math.max(0, Number.isFinite(ms) ? ms : 0), run });
    return this.made;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.timers.delete(handle);
  };

  /** Resolves once the clock has moved `ms` on; a signal that ends first rejects it with its reason and takes its timer away. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    if (signal?.aborted === true) {
      reject(signal.reason);
      return promise;
    }
    const stop = (): void => {
      this.clearTimeout(handle);
      reject(signal?.reason);
    };
    const handle = this.setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
    return promise;
  }

  /** How many timers are set. */
  get pending(): number {
    return this.timers.size;
  }

  /** The handle of the timer due first; undefined when none is set. */
  private earliest(): number | undefined {
    let first: number | undefined;
    for (const [handle, timer] of this.timers) {
      const best = first === undefined ? undefined : this.timers.get(first);
      if (best === undefined || timer.at < best.at) first = handle;
    }
    return first;
  }

  /** Fires the timer `handle`, the clock at its time. */
  private fire(handle: number): void {
    const timer = this.timers.get(handle);
    if (timer === undefined) return;
    this.timers.delete(handle);
    this.time = Math.max(this.time, timer.at);
    timer.run();
  }

  /** Moves the clock `ms` on, firing every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const until = this.time + ms;
    for (let next = this.earliest(); next !== undefined && (this.timers.get(next)?.at ?? Number.POSITIVE_INFINITY) <= until; next = this.earliest()) this.fire(next);
    this.time = until;
  }

  /** Jumps to the timer due first and fires it; false when no timer is set. */
  next(): boolean {
    const first = this.earliest();
    if (first === undefined) return false;
    this.fire(first);
    return true;
  }

  /** Lets everything that can happen without the clock moving happen: the event loop turns, the clock stays. */
  async idle(): Promise<void> {
    for (let i = 0; i < IDLE_TURNS; i += 1) await turn();
  }

  /**
   * Runs `work` to its end: whenever nothing else can happen, the clock jumps to the next timer.
   * Rejects, instead of hanging, when the work waits on something no timer brings (a gate the test
   * opens later, say).
   */
  async settle<T>(work: Promise<T>): Promise<T> {
    let done = false;
    work.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    for (let fired = 0; fired <= MOST_TIMERS; fired += 1) {
      for (let i = 0; i < IDLE_TURNS && !done; i += 1) await turn();
      if (done) return work;
      if (!this.next()) throw new Error("The work waits on something no timer will bring: there is no timer left to move the clock to.");
    }
    throw new Error(`The work didn't finish within ${MOST_TIMERS} timers.`);
  }
}
