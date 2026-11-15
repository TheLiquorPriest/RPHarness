// A count of places, with a line for one past it (§10.11: tool calls at once, sub-agents at once):
// a place is taken at once where one is free, else in line, first come first served; a stop takes
// its waiter out of the line; a place freed goes to the first in line.

export class PlaceLine {
  #free: number;
  readonly #line: ((free: () => void) => void)[] = [];

  constructor(places: number) {
    this.#free = places;
  }

  /**
   * Takes a place, at once where one is free and nobody is in line before it, else in line, after
   * `waits` is told. Gives what frees the place, or undefined where the signal stopped it first.
   */
  async take(signal: AbortSignal | undefined, waits: () => void): Promise<(() => void) | undefined> {
    if (signal?.aborted === true) return undefined;
    if (this.#free > 0 && this.#line.length === 0) {
      this.#free -= 1;
      return this.#freer();
    }
    waits();
    const { promise, resolve } = Promise.withResolvers<(() => void) | undefined>();
    const stop = (): void => {
      const at = this.#line.indexOf(given);
      if (at >= 0) this.#line.splice(at, 1);
      resolve(undefined);
    };
    const given = (free: () => void): void => {
      signal?.removeEventListener("abort", stop);
      resolve(free);
    };
    this.#line.push(given);
    signal?.addEventListener("abort", stop, { once: true });
    return promise;
  }

  /** What frees a place once: to the first in line, or back to the count. */
  #freer(): () => void {
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const next = this.#line.shift();
      if (next !== undefined) next(this.#freer());
      else this.#free += 1;
    };
  }
}
