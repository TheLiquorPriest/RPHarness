// Each connection's throttle (§13.2: "throttles are rebuilt around the model call"), as today's
// build kept them (LumiAH provider.ts:606-660, 718-735): the requests sent on it and the tokens sent
// and written over the last minute, and its calls under way at once, across every agent, turn and
// job of the user's. A call takes its hold before it is sent and settles it once it ends: its entry
// in the minute holds its estimate until then, and what it spent after. It waits for a place among
// the calls at once first, in line, first come first served, so a call in line holds nothing of the
// minute; then for room in the minute. Only a call bigger than the whole minute is refused. Kept in
// memory, one desk's for its user: a restart starts every minute afresh.

/** A minute, in milliseconds: the unit providers state their limits in, which the throttle's settings are in. Not a value of its own. */
const MINUTE_MS = 60_000;

/** A connection's throttle as the user's settings give it; each absent is no limit. */
export interface Throttle {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  atOnce?: number;
}

/** What a waiting call is told: the wait has begun, for room in its minute or for a place among its calls at once; what it gives back is told when the wait ends. */
export type Waiting = (wait: "minute" | "place") => () => void;

/** A call's hold on its connection. `settle`: it has ended, its place is let go and its entry in the minute holds what it spent (absent: nothing was reported, and the estimate stands). */
export interface Hold {
  settle(tokens?: number): void;
}

/** A call's hold; or the minute it is bigger than whole; or nothing, its signal having stopped it first. */
export type Taken = { hold: Hold } | { tooBig: { max: number; value: number } } | undefined;

interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * A connection's calls under way at once. A place that frees goes straight to the first in line, so
 * a call that comes just then never takes it ahead of one that waited; one whose signal aborts while
 * it waits leaves the line, holding nothing.
 */
class Line {
  #running = 0;
  /** The count as the call that came last read it. */
  #most = 0;
  readonly #waiting: (() => void)[] = [];

  /** A place: at once while there is room and nobody waits, else when the line reaches it; false when `signal` stopped it first. */
  async take(most: number, signal: AbortSignal, waiting: Waiting): Promise<boolean> {
    this.#most = most;
    // A count raised since the line formed lets those in it through before this call.
    this.#fill();
    if (this.#waiting.length === 0 && this.#running < most) {
      this.#running += 1;
      return true;
    }
    if (signal.aborted) return false;
    const done = waiting("place");
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const wake = (): void => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    };
    const abort = (): void => {
      const at = this.#waiting.indexOf(wake);
      if (at >= 0) this.#waiting.splice(at, 1);
      resolve(false);
    };
    this.#waiting.push(wake);
    signal.addEventListener("abort", abort, { once: true });
    const taken = await promise;
    done();
    return taken;
  }

  free(): void {
    this.#running -= 1;
    this.#fill();
  }

  /** Hands the free places to the calls in line, the first to come first: each wakes holding its place. */
  #fill(): void {
    while (this.#waiting.length > 0 && this.#running < this.#most) {
      this.#running += 1;
      this.#waiting.shift()?.();
    }
  }
}

export class Throttles {
  readonly #clock: Clock;
  /** Each connection's requests over the last minute: when, and their tokens. */
  readonly #minutes = new Map<string, { at: number; tokens: number }[]>();
  readonly #lines = new Map<string, Line>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Takes a hold for a call on `connection` that is estimated at `tokens`, sent and written: a place
   * among its calls at once, then room in its minute, each waited for as long as it takes, `waiting`
   * told of each wait. A connection with no throttle holds nothing and keeps no minute.
   */
  async take(connection: string, throttle: Throttle, tokens: number, signal: AbortSignal, waiting: Waiting): Promise<Taken> {
    const { requestsPerMinute, tokensPerMinute, atOnce } = throttle;
    if (tokensPerMinute !== undefined && tokens > tokensPerMinute) return { tooBig: { max: tokensPerMinute, value: tokens } };
    let line: Line | undefined;
    if (atOnce !== undefined) {
      line = this.#lines.get(connection) ?? new Line();
      this.#lines.set(connection, line);
      if (!(await line.take(atOnce, signal, waiting))) return undefined;
    }
    const held = line;
    const free = (): void => held?.free();
    if (requestsPerMinute === undefined && tokensPerMinute === undefined) return { hold: { settle: free } };
    if (!(await this.#roomIn(connection, requestsPerMinute, tokensPerMinute, tokens, signal, waiting))) {
      free();
      return undefined;
    }
    const entry = { at: this.#clock.now(), tokens };
    this.#minutes.get(connection)?.push(entry);
    let settled = false;
    return {
      hold: {
        settle: (spent) => {
          if (settled) return;
          settled = true;
          if (spent !== undefined) entry.tokens = spent;
          free();
        },
      },
    };
  }

  /** Waits until the connection's last minute has room for one more request of `tokens`; false when `signal` stopped it first. */
  async #roomIn(connection: string, requests: number | undefined, perMinute: number | undefined, tokens: number, signal: AbortSignal, waiting: Waiting): Promise<boolean> {
    let done: (() => void) | undefined;
    try {
      for (;;) {
        if (signal.aborted) return false;
        const now = this.#clock.now();
        const recent = (this.#minutes.get(connection) ?? []).filter((entry) => entry.at > now - MINUTE_MS);
        this.#minutes.set(connection, recent);
        const used = recent.reduce((sum, entry) => sum + entry.tokens, 0);
        const oldest = recent[0];
        if (oldest === undefined || ((requests === undefined || recent.length < requests) && (perMinute === undefined || used + tokens <= perMinute))) return true;
        done ??= waiting("minute");
        if (!(await this.#sleep(oldest.at + MINUTE_MS - now, signal))) return false;
      }
    } finally {
      done?.();
    }
  }

  /** Resolves true once `ms` have passed on the clock, false the moment `signal` aborts. */
  #sleep(ms: number, signal: AbortSignal): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const abort = (): void => {
      this.#clock.clearTimeout(timer);
      resolve(false);
    };
    const timer = this.#clock.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, Math.max(0, ms));
    signal.addEventListener("abort", abort, { once: true });
    return promise;
  }
}
