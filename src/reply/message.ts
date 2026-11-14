// The reply as the plain text of a message (§10.6, §10.7): the two-step form for a connection that
// does not keep to the tags, and the narrator's live reply.
//
// Shown whole: the text of a message that ends with no work left (every call it makes is closing,
// or it makes none) is the reply, sent at the message's end; any other message's text was working
// text, and nothing of it is shown. Streamed (the narrator live, or a two-step connection set to
// stream anyway): the text goes out as it is written, held back by sentences while a rule that
// interrupts covers it, as the tag form does, and the message's end releases it.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JsonValue, ReplySink } from "../contract";
import type { TextChannel } from "../loop/channel";
import { isClosing } from "../loop/runner";
import { Release } from "./release";
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
   * it showed takes nothing): false when the reply is another form's, or went out already; this one
   * is then not shown. Absent: always this form's.
   */
  claim?(): boolean;
  /** The line, from a file, that answers a reply that was not shown because one was already given. Absent: nothing is said. */
  second?: string;
  /** The reply begins to show: its first text is about to go out. */
  onBegin?(): void;
  /** The reply is complete and was sent on: once. */
  onReleased?(reply: string): void;
}

export class MessageReply implements TextChannel {
  readonly #o: MessageReplyOptions;
  readonly #release: Release;
  #state: "none" | "open" | "released" = "none";
  /** The text of the message under way. */
  #message = "";
  /** This message is a reply that cannot be shown. */
  #refused = false;
  /**
   * A reply was not shown: the agent is told after the message, once in the generation, so text after
   * the reply never buys it call after call (each answer is a further call).
   */
  #second: "unsaid" | "due" | "said" = "unsaid";

  constructor(options: MessageReplyOptions) {
    this.#o = options;
    this.#release = new Release((text) => options.sink.content(text), options.heldSentences, () => this.#claim());
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
    this.#refused = false;
  }

  write(piece: string): void {
    this.#message += piece;
    if (!this.#o.stream || this.#refused || piece === "") return;
    if (this.#state === "released") {
      this.#refuse();
      return;
    }
    this.#state = "open";
    this.#release.hold(piece);
  }

  release(): void {
    if (this.#state === "open" && !this.#refused) this.#flush(false);
  }

  cut(): string {
    const written = this.#message;
    this.#message = "";
    // Shown whole, nothing of the message was shown: all of it is dropped.
    return this.#o.stream ? this.#release.drop() : written;
  }

  end(message: AssistantMessage): void {
    if (this.#o.stream) {
      if (this.#state === "open" && !this.#refused && this.#flush(true)) this.#finish();
      return;
    }
    const replies = this.#message.trim() !== "" && message.content.every((part) => part.type !== "toolCall" || isClosing(part.arguments as JsonValue));
    if (!replies) return;
    if (this.#state === "released") {
      this.#refuse();
      return;
    }
    this.#release.hold(this.#message);
    if (this.#flush(true)) this.#finish();
  }

  /** Sends on what may be shown. False when the reply was not this form's as its first text was to go out: none of this message is shown, and the agent is told. */
  #flush(all: boolean): boolean {
    if (this.#release.flush(all)) return true;
    this.#state = "none";
    this.#refuse();
    return false;
  }

  /** Just before the first text goes out: whether the reply is this form's; if it is, it begins to show. */
  #claim(): boolean {
    if (this.#o.claim?.() === false) return false;
    this.#o.onBegin?.();
    return true;
  }

  answers(): string[] {
    if (this.#second !== "due") return [];
    this.#second = "said";
    return this.#o.second !== undefined ? [this.#o.second] : [];
  }

  #refuse(): void {
    this.#refused = true;
    if (this.#second === "unsaid") this.#second = "due";
  }

  #finish(): void {
    this.#state = "released";
    this.#o.onReleased?.(this.#release.shown);
  }
}
