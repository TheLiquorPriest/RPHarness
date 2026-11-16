// The reply as the plain text of a message (§10.6, §10.7): the two-step form for a connection that
// does not keep to the tags, and the narrator's live reply.
//
// Shown whole: the text of a message that ends with no work left (every call it makes is closing,
// or it makes none) is the reply, sent at the message's end; any other message's text was working
// text, and nothing of it is shown. Streamed (the narrator live, or a two-step connection set to
// stream anyway): the text goes out as it is written, held back by sentences while a rule that
// interrupts covers it, as the tag form does, and the message's end releases it.
//
// Once the reply went out, this way or another, a message's text is never shown. A message that
// would have been the reply (its text, with no work left after it) is an attempt at a second reply:
// the agent is told so after the message, in a file's words, once in the generation, as in the tag
// form, so a second reply never buys it call after call. Any other message's text is working text.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JsonValue, ReplySink } from "../contract";
import type { TextChannel } from "../loop/channel";
import { isClosing } from "../loop/runner";
import { HELD_WHOLE, Release, type ReleaseCheck } from "./release";
import { lastSentences } from "./sentences";

export interface MessageReplyOptions {
  /** Where the reply's text goes. */
  sink: Pick<ReplySink, "content">;
  /** Sent as written (true), or whole at the end of the message that is the reply. */
  stream: boolean;
  /** Sentences held back behind the model while streaming (see `heldSentences`). */
  heldSentences: number;
  /** Of what was shown, how many of the last sentences go with the line an agent goes on under after a rule stopped it. */
  tailSentences: number;
  /**
   * Asked just before the reply's first text is shown, never sooner (a reply cut before anything of
   * it showed takes nothing): false when the reply is another form's, or went out already; none of
   * this message is then shown, and if it would have been the reply, the agent is told so.
   * Absent: always this form's.
   */
  claim?(): boolean;
  /** The line, from a file, that answers a reply that was not shown because one was already given. Absent: nothing is said. */
  second?: string;
  /** The reply begins to show: its first text is about to go out. */
  onBegin?(): void;
  /** The reply is complete and was sent on: once. */
  onReleased?(reply: string): void;
  /** His before-release hooks, when one is in force: the reply goes out at its message's end, once they have seen it whole. */
  beforeRelease?: ReleaseCheck;
}

export class MessageReply implements TextChannel {
  readonly #o: MessageReplyOptions;
  readonly #release: Release;
  /** `checking`: the reply is complete, and his before-release hooks are reading it. */
  #state: "none" | "open" | "checking" | "released" = "none";
  /** The text of the message under way. */
  #message = "";
  /** This message's text is not the reply's to show: the reply went out another way, or another way has it. */
  #unshown = false;
  /** A reply was attempted that could not be shown: the agent is told after the message, once in the generation. */
  #second: "unsaid" | "due" | "said" = "unsaid";
  /** Each check by his before-release hooks, numbered: one a cut took back since answers nothing. */
  #checks = 0;
  #checking: Promise<void> | undefined;
  /** The reasons his before-release hooks kept a reply back with, for the agent after the message. */
  #kept: string[] = [];

  constructor(options: MessageReplyOptions) {
    this.#o = options;
    this.#release = new Release((text) => options.sink.content(text), options.beforeRelease !== undefined ? HELD_WHOLE : options.heldSentences, () => this.#claim());
  }

  /** Whether the reply was released. */
  get released(): boolean {
    return this.#state === "released";
  }

  /** What the chat has been sent. */
  get shown(): string {
    return this.#release.shown;
  }

  /** What a rule on the reply looks at: what was shown and held, or, shown whole, the message that would be the reply. */
  get reply(): string {
    return this.#o.stream ? this.#release.shown + this.#release.held : this.#message;
  }

  tail(): string {
    return lastSentences(this.#release.shown, this.#o.tailSentences);
  }

  begin(): void {
    this.#message = "";
    this.#unshown = false;
  }

  write(piece: string): void {
    this.#message += piece;
    if (!this.#o.stream || this.#state === "released" || this.#state === "checking" || this.#unshown || piece === "") return;
    this.#state = "open";
    this.#release.hold(piece);
  }

  release(): void {
    if (this.#state === "open") this.#flush(false);
  }

  cut(): string {
    const written = this.#message;
    this.#message = "";
    if (this.#state === "checking") {
      this.#checks += 1;
      this.#state = "none";
    }
    // Shown whole, nothing of the message was shown: all of it is dropped.
    return this.#o.stream ? this.#release.drop() : written;
  }

  end(message: AssistantMessage): void {
    // The message's text with no work left after it: the reply, or an attempt at a second one.
    const replies = this.#message.trim() !== "" && message.content.every((part) => part.type !== "toolCall" || isClosing(part.arguments as JsonValue));
    if (this.#state === "released" || this.#state === "checking" || this.#unshown) {
      if (replies) this.#notShown();
      return;
    }
    if (this.#o.stream) {
      if (this.#state !== "open") return;
    } else {
      if (!replies) return;
      this.#release.hold(this.#message);
    }
    if (this.#o.beforeRelease !== undefined) this.#check(this.#o.beforeRelease, replies);
    else this.#out(replies);
  }

  settled(): Promise<void> {
    return this.#checking ?? Promise.resolve();
  }

  answers(): string[] {
    const kept = this.#kept.splice(0);
    if (this.#second !== "due") return kept;
    this.#second = "said";
    return this.#o.second !== undefined ? [...kept, this.#o.second] : kept;
  }

  /** Sends the reply on whole, and it is released; not this form's, it is not shown, and a message that would have been the reply is told so. */
  #out(replies: boolean): void {
    if (this.#flush(true)) this.#finish();
    else if (replies) this.#notShown();
  }

  /** His before-release hooks read the whole reply: it goes out once they let it; a block drops it, and the agent is told why. */
  #check(hooks: ReleaseCheck, replies: boolean): void {
    this.#state = "checking";
    const at = ++this.#checks;
    hooks.waits();
    this.#checking = hooks
      .check(this.#release.held)
      .catch(() => undefined)
      .then((reason) => {
        if (at !== this.#checks || this.#state !== "checking") return;
        if (reason === undefined) {
          this.#state = "open";
          this.#out(replies);
          return;
        }
        this.#release.drop();
        this.#state = "none";
        this.#kept.push(reason);
      });
  }

  /** A reply this form does not show: the agent is told after the message, once in the generation. */
  #notShown(): void {
    if (this.#second === "unsaid") this.#second = "due";
  }

  /** Sends on what may be shown. False when the reply was not this form's as its first text was to go out: none of this message is shown. */
  #flush(all: boolean): boolean {
    if (this.#release.flush(all)) return true;
    this.#state = "none";
    this.#unshown = true;
    return false;
  }

  /** Just before the first text goes out: whether the reply is this form's; if it is, it begins to show. */
  #claim(): boolean {
    if (this.#o.claim?.() === false) return false;
    this.#o.onBegin?.();
    return true;
  }

  #finish(): void {
    this.#state = "released";
    this.#o.onReleased?.(this.#release.shown);
  }
}
