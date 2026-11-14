// Sends a reply on as it is written. When a rule that interrupts covers the reply, the sentence in
// progress is held back (§5.4, Appendix D.1), so a match stops the call before that sentence is
// shown; with no such rule nothing is held at all. The reply is claimed as its first text goes out,
// never sooner: one cut or failed before anything of it showed takes nothing from the other ways.
import { sentenceEnds } from "./sentences";

export class Release {
  readonly #send: (text: string) => void;
  readonly #heldSentences: number;
  readonly #claim: (() => boolean) | undefined;
  #held = "";
  #shown = "";

  /**
   * `heldSentences` is how many sentences stay behind the model: 0 sends every piece at once; 1
   * holds the sentence in progress; 2 holds the last whole sentence as well, and so on. `claim` is
   * asked just before the first text is sent: false when the reply is not this one's to show.
   */
  constructor(send: (text: string) => void, heldSentences: number, claim?: () => boolean) {
    if (!Number.isInteger(heldSentences) || heldSentences < 0) throw new Error(`How many sentences a reply is held back by must be a whole number, 0 or more; it is ${heldSentences}.`);
    this.#send = send;
    this.#heldSentences = heldSentences;
    this.#claim = claim;
  }

  /** Everything sent on so far. */
  get shown(): string {
    return this.#shown;
  }

  /** Written and not yet sent on. */
  get held(): string {
    return this.#held;
  }

  /** Takes text in; nothing is sent until `flush`, so a rule can look at it first. */
  hold(text: string): void {
    this.#held += text;
  }

  /**
   * Sends on what may be shown now, or everything when `all`. False when the first text was to go
   * out and the claim said no: nothing was sent, and what was held is dropped.
   */
  flush(all = false): boolean {
    let upTo = this.#held.length;
    if (!all && this.#heldSentences > 0) {
      const ends = sentenceEnds(this.#held);
      // Whole sentences kept back besides the one in progress.
      const kept = this.#heldSentences - 1;
      upTo = ends.length > kept ? (ends[ends.length - 1 - kept] ?? 0) : 0;
    }
    if (upTo === 0) return true;
    if (this.#shown === "" && this.#claim?.() === false) {
      this.#held = "";
      return false;
    }
    const text = this.#held.slice(0, upTo);
    this.#held = this.#held.slice(upTo);
    this.#shown += text;
    this.#send(text);
    return true;
  }

  /** Drops what was held: it will never be shown. Gives back what was dropped. */
  drop(): string {
    const dropped = this.#held;
    this.#held = "";
    return dropped;
  }
}
