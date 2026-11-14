// One reply per generation (§10.7): whichever form begins the reply owns it, and once it went out
// no form shows another. The forms ask before they show anything; the reply tools ask before they
// call a writer or release a file.
import type { ReleaseForm } from "../contract";

export class ReplyDesk {
  #form: ReleaseForm | undefined;
  #out = false;

  /** A form is about to show the reply: true when no other form has begun one and none went out yet. */
  claim(form: ReleaseForm): boolean {
    if (this.#out) return false;
    this.#form ??= form;
    return this.#form === form;
  }

  /** A reply has begun to show, or went out: any further attempt is a second reply. */
  get taken(): boolean {
    return this.#form !== undefined || this.#out;
  }

  get released(): boolean {
    return this.#out;
  }

  /** The form that began the reply, if one did. */
  get form(): ReleaseForm | undefined {
    return this.#form;
  }

  /** The reply went out. */
  out(): void {
    this.#out = true;
  }
}
