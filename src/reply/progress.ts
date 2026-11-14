// Keeps a long turn alive (§10.7): when nothing has been shown for the set interval, a progress
// line goes to the chat's thinking block. The chat application may end a generation that sends no
// text for a while, and only real text resets its clock, so the line is real text, from
// `.prompts/progress.md`. The interval is a setting.
import type { ReplySink } from "../contract";
import type { LoopClock } from "../loop/types";

export interface KeepAliveOptions {
  /** Where the reply and its progress lines go. */
  sink: ReplySink;
  clock: LoopClock;
  /** How long nothing may be shown before a progress line is sent, in milliseconds. */
  silenceMs: number;
  /** `.prompts/progress.md`'s `still` row, filled with how long the turn has been going (minutes and seconds). */
  still(fields: { elapsed: string }): string;
}

export class KeepAlive {
  /** What the reply writes to: the turn's sink, with the silence clock started over by every piece that reaches it. */
  readonly sink: ReplySink;
  readonly #o: KeepAliveOptions;
  #startedAt = 0;
  #timer: unknown;
  #on = false;

  constructor(options: KeepAliveOptions) {
    if (!(options.silenceMs > 0)) throw new Error(`The silence before a progress line must be more than 0 ms; it is ${options.silenceMs}.`);
    this.#o = options;
    const outer = options.sink;
    this.sink = {
      progress: (line) => {
        outer.progress(line);
        this.#shown();
      },
      content: (delta) => {
        // An empty piece is not text: it would not reset the chat application's clock either.
        if (delta === "") return;
        outer.content(delta);
        this.#shown();
      },
      finish: (usage) => {
        this.stop();
        outer.finish(usage);
      },
      error: (error) => {
        this.stop();
        outer.error(error);
      },
    };
  }

  /** The turn began: the silence is counted from now. */
  start(): void {
    this.#on = true;
    this.#startedAt = this.#o.clock.now();
    this.#arm();
  }

  /** The reply's stream is over: no more lines. */
  stop(): void {
    this.#on = false;
    if (this.#timer !== undefined) this.#o.clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #shown(): void {
    if (this.#on) this.#arm();
  }

  #arm(): void {
    if (this.#timer !== undefined) this.#o.clock.clearTimeout(this.#timer);
    this.#timer = this.#o.clock.setTimeout(() => {
      this.#timer = undefined;
      if (!this.#on) return;
      const seconds = Math.floor((this.#o.clock.now() - this.#startedAt) / 1000);
      const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      this.sink.progress(this.#o.still({ elapsed }));
    }, this.#o.silenceMs);
  }
}
