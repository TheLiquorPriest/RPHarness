// The wait for the intent record (§10.3, the setting `reply.intentWait`): what acts on the lead's
// intent record (a tool that runs, the reply as it shows) waits until the host has taken every
// intent record told before it, so the Live page and the turn's record hold it first; never longer
// than the user's bound, and nothing is refused. A reply that went out with no intent record taken
// before it says so on its release, for the Turn page and the next briefing.
import type { Clock, ReplyError, ReplySink, Usage } from "../contract";

export class IntentWait {
  readonly #clock: Pick<Clock, "setTimeout" | "clearTimeout">;
  /** The user's bound, in milliseconds, read when a wait begins. */
  readonly #bound: () => number;
  readonly #told: Promise<unknown>[] = [];

  constructor(clock: Pick<Clock, "setTimeout" | "clearTimeout">, bound: () => number) {
    this.#clock = clock;
    this.#bound = bound;
  }

  /** An intent record was handed to the host: `taking` settles once the host took it (or failed to). */
  told(taking: Promise<unknown>): void {
    this.#told.push(taking);
  }

  /** Whether any intent record was told. */
  get any(): boolean {
    return this.#told.length > 0;
  }

  /** Resolves true once every intent record told so far was taken; false when the bound passed first. */
  taken(): Promise<boolean> {
    if (this.#told.length === 0) return Promise.resolve(true);
    const all = Promise.allSettled(this.#told);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = this.#clock.setTimeout(() => resolve(false), this.#bound());
    void all.then(() => {
      this.#clock.clearTimeout(timer);
      resolve(true);
    });
    return promise;
  }
}

/**
 * The turn's sink with the reply held, from its first text, until the intent records told before it
 * were taken (`IntentWait.taken`), in the order it came. Progress lines are not the reply and pass
 * at once; an error with nothing of a reply held passes at once too.
 */
export class HeldSink implements ReplySink {
  readonly #sink: ReplySink;
  readonly #wait: IntentWait;
  /** The turn's end waits for what is held. */
  readonly #track: (held: Promise<unknown>) => void;
  readonly #queue: (() => void)[] = [];
  #out: Promise<boolean> | undefined;
  #open = false;

  constructor(sink: ReplySink, wait: IntentWait, track: (held: Promise<unknown>) => void) {
    this.#sink = sink;
    this.#wait = wait;
    this.#track = track;
  }

  /** Begins the hold if the reply has not: resolves once the reply shows, true when an intent record was told before it and taken. */
  out(): Promise<boolean> {
    if (this.#out === undefined) {
      const told = this.#wait.any;
      this.#out = this.#wait.taken().then((taken) => {
        this.#open = true;
        for (const send of this.#queue.splice(0)) send();
        return told && taken;
      });
      this.#track(this.#out);
    }
    return this.#out;
  }

  progress(line: string): void {
    this.#sink.progress(line);
  }

  content(delta: string): void {
    this.#send(() => this.#sink.content(delta));
  }

  finish(usage: Usage): void {
    this.#send(() => this.#sink.finish(usage));
  }

  error(e: ReplyError): void {
    if (this.#out === undefined) this.#sink.error(e);
    else this.#send(() => this.#sink.error(e));
  }

  #send(send: () => void): void {
    if (this.#open) return send();
    this.#queue.push(send);
    void this.out();
  }
}
