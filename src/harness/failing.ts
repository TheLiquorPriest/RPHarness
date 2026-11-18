// What a run writes beside its work (its agents' transcripts, a read's saved result, a clipped
// answer's whole) can fail write after write while a disk is full, a folder is taken away or a host
// refuses. Each such failure is said once while it lasts: at the first failure for its file (or
// folder), at warn, with where and why; not again while it goes on failing; and once more, at info,
// when a write there lands again, with how many failed in between. The session file says its own
// (`sessions/book.ts`), as it holds its lines.
import type { JsonValue, Log } from "../contract";

/** The places one run's writes are failing at now, each said once. */
export class FailingWrites {
  readonly #log: Log;
  /** Each place failing now, with how many of its writes failed since the first. */
  readonly #failing = new Map<string, number>();

  constructor(log: Log) {
    this.#log = log;
  }

  /** A write at `place` failed: said (warn) only where it is the first since the last that landed. */
  failed(place: string, message: string, fields: Record<string, JsonValue>): void {
    const count = this.#failing.get(place);
    if (count === undefined) this.#log.warn(message, fields);
    this.#failing.set(place, (count ?? 0) + 1);
  }

  /** A write at `place` landed: where some had failed before it, said (info), with how many (`missed`). */
  landed(place: string, message: string, fields: Record<string, JsonValue>): void {
    const count = this.#failing.get(place);
    if (count === undefined) return;
    this.#failing.delete(place);
    this.#log.info(message, { ...fields, missed: count });
  }
}
