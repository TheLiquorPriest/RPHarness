// Sends a reply on as it is written. When a rule that interrupts covers the reply, the sentence in
// progress is held back (§5.4, Appendix D.1), so a match stops the call before that sentence is
// shown; with no such rule nothing is held at all. The reply is claimed as its first text goes out,
// never sooner: one cut or failed before anything of it showed takes nothing from the other ways.
import { sentenceEnds } from "./sentences";

/** His before-release hooks (§5.4 "Hooks"), when one is in force for the reply: nothing of it shows before its message ends and they have seen it whole. */
export interface ReleaseCheck {
  /** Sees the whole reply: a reason keeps it back, and the agent is told it; none lets it go out. */
  check(reply: string): Promise<string | undefined>;
  /** The reply waits for the hooks: the UI is told. */
  waits(): void;
}

/** Sentences held back while a release check is in force: all of them, so nothing goes out before the hooks have seen it. */
export const HELD_WHOLE = Number.MAX_SAFE_INTEGER;

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
