// Keeps a long turn alive (§10.7): when nothing has been shown for the set interval, a progress
// line goes to the chat's thinking block. The chat application may end a generation that sends no
// text for a while, and only real text resets its clock, so the line is real text, from
// `.prompts/progress.md`. The interval is a setting, and the most it may be is that setting's own
// bound in RPH's list of settings, read from there. With no line to send, nothing is sent: the
// line's words are the file's alone.
import type { ReplySink } from "../contract";
import { REPLY } from "../harness/settings/reply";
import type { LoopClock } from "../loop/types";

/** The most the silence before a progress line may be, in milliseconds: `progress.silence`'s bound in the list of settings, which the turn's own time is held at when no line can keep it alive. */
export const SILENCE_MOST_MS = REPLY.silence.takes.most * 1000;

export interface KeepAliveOptions {
  /** Where the reply and its progress lines go. */
  sink: ReplySink;
  clock: LoopClock;
  /** How long nothing may be shown before a progress line is sent, in milliseconds. */
  silenceMs: number;
  /** `.prompts/progress.md`'s `still` row, filled with how long the turn has been going (minutes and seconds); undefined when the file has no such row, and then nothing is sent. */
  still(fields: { elapsed: string }): string | undefined;
  /** The silence came and the file has no line to send: once in the turn. */
  missing?(): void;
}

export class KeepAlive {
  /** What the reply writes to: the turn's sink, with the silence clock started over by every piece that reaches it. */
  readonly sink: ReplySink;
  readonly #o: KeepAliveOptions;
  #startedAt = 0;
  #timer: unknown;
  #on = false;
  #missed = false;

  constructor(options: KeepAliveOptions) {
    if (!(options.silenceMs > 0) || options.silenceMs > SILENCE_MOST_MS) throw new Error(`The silence before a progress line (${REPLY.silence.key}) must be more than 0 ms and at most ${SILENCE_MOST_MS} ms; it is ${options.silenceMs}.`);
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
      const line = this.#o.still({ elapsed });
      if (line !== undefined && line.trim() !== "") this.sink.progress(line);
      else if (!this.#missed) {
        this.#missed = true;
        this.#o.missing?.();
      }
    }, this.#o.silenceMs);
  }
}
