// The reply in the tag form (§10.7): whatever the lead writes inside the reply tag streams to the
// chat as it is written, held back by sentences only while a rule that interrupts covers it; the
// intent record and all other text never reach the chat. One reply per generation: a reply tag
// opened once a reply was given is not shown, and the agent is told so, in a file's words.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ReplySink } from "../contract";
import type { TextChannel } from "../loop/channel";
import type { StreamRules } from "../loop/rules";
import { Release } from "./release";
import { lastSentences } from "./sentences";
import { type ReplyTags, type TagPart, TagParser } from "./tags";

/** How many sentences the reply is held back by: the setting while a rule that interrupts covers the reply, else none (§5.4, Appendix D.1). */
export function heldSentences(rules: StreamRules | undefined, setting: number): number {
  return rules?.coverReply === true ? setting : 0;
}

export interface TagReplyOptions {
  /** The names the reply contract's header gives. */
  tags: ReplyTags;
  /** Where the reply's text goes. */
  sink: Pick<ReplySink, "content">;
  /** Sentences held back behind the model (see `heldSentences`). */
  heldSentences: number;
  /** Of what was shown, how many of the last sentences go with the line an agent goes on under after a rule stopped it. */
  tailSentences: number;
  /** Asked as a reply tag opens: false when the reply is another form's, or went out already; that reply is then not shown. Absent: always this form's. */
  claim?(): boolean;
  /** The line, from a file, that answers a reply that was not shown because one was already given. Absent: nothing is said. */
  second?: string;
  /** The reply begins: its first tag opened. */
  onBegin?(): void;
  /** An intent record, whole, each time one ends: for the live view and the turn's record, never for the chat. */
  onIntent?(text: string): void;
  /** The reply is complete and was sent on whole: once per generation. */
  onReleased?(reply: string): void;
}

export class TagReply implements TextChannel {
  readonly #o: TagReplyOptions;
  readonly #parser: TagParser;
  readonly #release: Release;
  /**
   * `open`: being written. `closing`: its closing tag was read, and it is complete once the rules
   * have looked. `released`: sent on whole. A rule that stops the call while the reply is open
   * leaves it open, and the agent's next reply tag goes on with it.
   */
  #state: "none" | "open" | "closing" | "released" = "none";
  #intent = "";
  /** Inside a reply tag opened after the reply was released, or while another form has it: not shown. */
  #extra = false;
  /** A reply tag was opened that could not be shown: the agent is told, once. */
  #second = false;
  /** This message wrote reply text: only then does its end close a reply its closing tag left open. */
  #wrote = false;

  constructor(options: TagReplyOptions) {
    this.#o = options;
    this.#parser = new TagParser(options.tags);
    this.#release = new Release((text) => options.sink.content(text), options.heldSentences);
  }

  /** Whether the reply was released. */
  get released(): boolean {
    return this.#state === "released";
  }

  /** What the chat has been sent. */
  get shown(): string {
    return this.#release.shown;
  }

  get reply(): string {
    return this.#release.shown + this.#release.held;
  }

  tail(): string {
    return lastSentences(this.#release.shown, this.#o.tailSentences);
  }

  begin(): void {
    this.#parser.reset();
    this.#intent = "";
    this.#extra = false;
    this.#wrote = false;
  }

  write(piece: string): void {
    for (const part of this.#parser.push(piece)) this.#take(part);
  }

  release(): void {
    if (this.#state === "open") this.#release.flush();
    else if (this.#state === "closing") {
      this.#release.flush(true);
      this.#state = "released";
      this.#o.onReleased?.(this.#release.shown);
    }
  }

  cut(): string {
    this.#parser.reset();
    this.#intent = "";
    this.#extra = false;
    this.#wrote = false;
    if (this.#state === "closing") this.#state = "open";
    return this.#release.drop();
  }

  end(_message: AssistantMessage): void {
    const inIntent = this.#parser.inside === "intent";
    for (const part of this.#parser.end()) this.#take(part);
    if (inIntent) this.#endIntent();
    // A reply this message wrote and left open is complete: the closing tag was left off. A message
    // that wrote none of it (tool calls after a rule stopped the reply) leaves it open for the next.
    if (this.#state === "open" && this.#wrote) this.#state = "closing";
    this.release();
  }

  answers(): string[] {
    const second = this.#second;
    this.#second = false;
    return second && this.#o.second !== undefined ? [this.#o.second] : [];
  }

  #take(part: TagPart): void {
    if (part.kind === "open") {
      if (part.role !== "reply") return;
      if (this.#state === "released" || this.#state === "closing" || this.#o.claim?.() === false) {
        this.#extra = true;
        this.#second = true;
        return;
      }
      if (this.#state === "none") this.#o.onBegin?.();
      this.#state = "open";
      return;
    }
    if (part.kind === "close") {
      if (part.role === "intent") this.#endIntent();
      else if (this.#extra) this.#extra = false;
      else this.#state = "closing";
      return;
    }
    if (part.role === "intent") this.#intent += part.text;
    else if (part.role === "reply" && !this.#extra) {
      this.#release.hold(part.text);
      if (part.text !== "") this.#wrote = true;
    }
    // Text outside every tag, and a second reply, are working text: the trace has them.
  }

  #endIntent(): void {
    if (this.#intent !== "") this.#o.onIntent?.(this.#intent);
    this.#intent = "";
  }
}
