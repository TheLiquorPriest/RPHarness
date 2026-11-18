// The reply as the plain text of a message (§10.6, §10.7): the two-step form for a connection that
// does not keep to the tags, and the narrator's live reply.
//
// Shown whole: the text of a message that ends with no work left (it makes no tool call, and so ends
// the run) is the reply, sent at the message's end; any other message's text was working
// text, and nothing of it is shown. Streamed (the narrator live, or a two-step connection set to
// stream anyway): the text goes out as it is written, held back by sentences while a rule that
// interrupts covers it, as the tag form does, and the message's end releases it.
//
// Once the reply went out, this way or another, a message's text is never shown: it is working text,
// kept in the trace, as the tag form keeps text after its reply's closing tag, and nothing answers it,
// so it costs no call. A message of text with no call after the reply ends the run as any such
// message does; a second reply is refused only where one is asked for, by a call that releases one.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ReplySink } from "../contract";
import type { ChannelMarks, TextChannel } from "../loop/channel";
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
   * this message is then shown, and its text is working text. Absent: always this form's.
   */
  claim?(): boolean;
  /** The reply begins to show: its first text is about to go out. */
  onBegin?(): void;
  /** The reply is complete and was sent on: once. */
  onReleased?(reply: string): void;
  /** His before-release hooks, when one is in force: the reply goes out at its message's end, once they have seen it whole. */
  beforeRelease?: ReleaseCheck;
}

export class MessageReply implements TextChannel {
  /** The reply is the plain text of a message; streamed, a message's text after a cut goes on with it. */
  readonly marks: ChannelMarks = { form: { two_step: true } };
  readonly #o: MessageReplyOptions;
  readonly #release: Release;
  /** `checking`: the reply is complete, and his before-release hooks are reading it. */
  #state: "none" | "open" | "checking" | "released" = "none";
  /** The text of the message under way. */
  #message = "";
  /** This message's text is not the reply's to show: the reply went out another way, or another way has it. */
  #unshown = false;
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
    return this.#state === "released" ? "" : lastSentences(this.#release.shown, this.#o.tailSentences);
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
    if (this.#state === "released" || this.#state === "checking" || this.#unshown) return;
    if (this.#o.stream) {
      if (this.#state !== "open") return;
    } else {
      // The message's text with no work left after it (no tool call) is the reply; any other message's is working text.
      if (this.#message.trim() === "" || message.content.some((part) => part.type === "toolCall")) return;
      this.#release.hold(this.#message);
    }
    if (this.#o.beforeRelease !== undefined) this.#check(this.#o.beforeRelease);
    else this.#out();
  }

  settled(): Promise<void> {
    return this.#checking ?? Promise.resolve();
  }

  answers(): string[] {
    return this.#kept.splice(0);
  }

  /** Sends the reply on whole, and it is released; not this form's, none of it is shown. */
  #out(): void {
    if (this.#flush(true)) this.#finish();
  }

  /** His before-release hooks read the whole reply: it goes out once they let it; a block drops it, and the agent is told why. */
  #check(hooks: ReleaseCheck): void {
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
          this.#out();
          return;
        }
        this.#release.drop();
        this.#state = "none";
        this.#kept.push(reason);
      });
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
