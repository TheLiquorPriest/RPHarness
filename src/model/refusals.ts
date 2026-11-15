// Which of a user's connections' models were seen refusing native tools, and when (tools-text.ts):
// such a model is offered its tools as text for `calls.toolRefusalMinutes` after its refusal, then
// native tools are tried again. Kept for the life of the layer, one user's apart from another's, by
// a key that names the connection and its model.

export class Refusals {
  readonly #seen = new Map<string, number>();

  /** The model refused native tools at `now`. */
  note(key: string, now: number): void {
    this.#seen.set(key, now);
  }

  /** Whether a refusal seen less than `ms` before `now` stands; one that old is forgotten, so native tools are tried again. */
  stands(key: string, now: number, ms: number): boolean {
    const at = this.#seen.get(key);
    if (at === undefined) return false;
    if (now - at < ms) return true;
    this.#seen.delete(key);
    return false;
  }
}
