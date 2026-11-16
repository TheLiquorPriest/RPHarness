// The reply in the tag form (§10.7): whatever the lead writes inside the reply tag streams to the
// chat as it is written, held back by sentences only while a rule that interrupts covers it; the
// intent record and all other text never reach the chat. One reply per generation: a reply tag
// opened once a reply was given is not shown, and the agent is told so, in a file's words.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ReplySink } from "../contract";
import type { TextChannel } from "../loop/channel";
import type { StreamRules } from "../loop/rules";
import { HELD_WHOLE, Release, type ReleaseCheck } from "./release";
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
  /**
   * Asked just before the reply's first text is shown, never sooner (a reply cut before anything of
   * it showed takes nothing): false when the reply is another form's, or went out already; that
   * reply is then not shown. Absent: always this form's.
   */
  claim?(): boolean;
  /** The line, from a file, that answers a reply that was not shown because one was already given. Absent: nothing is said. */
  second?: string;
  /** The reply begins to show: its first text is about to go out, never sooner (a tag opened for a reply another form holds says nothing). */
  onBegin?(): void;
  /** An intent record begins: its opening tag was read. */
  onIntentBegan?(): void;
  /** An intent record, whole, each time one ends: for the live view and the turn's record, never for the chat. */
  onIntent?(text: string): void;
  /** The reply is complete and was sent on whole: once per generation. */
  onReleased?(reply: string): void;
  /** His before-release hooks, when one is in force: the reply goes out at its message's end, once they have seen it whole. */
  beforeRelease?: ReleaseCheck;
}

export class TagReply implements TextChannel {
  readonly #o: TagReplyOptions;
  readonly #parser: TagParser;
  readonly #release: Release;
  /**
   * `open`: being written. `closing`: its closing tag was read, and it is complete once the rules
   * have looked. `checking`: complete, and his before-release hooks are reading it. `released`: sent
   * on whole. A rule that stops the call while the reply is open leaves it open, and the agent's next
   * reply tag goes on with it.
   */
  #state: "none" | "open" | "closing" | "checking" | "released" = "none";
  #intent = "";
  /** Inside a reply tag opened after the reply was released, or while another form has it: not shown. */
  #extra = false;
  /**
   * A reply tag was opened that could not be shown: the agent is told after the message, once in the
   * generation, so a second reply never buys it call after call (each answer is a further call).
   */
  #second: "unsaid" | "due" | "said" = "unsaid";
  /** This message wrote reply text: only then does its end close a reply its closing tag left open. */
  #wrote = false;
  /** Each check by his before-release hooks, numbered: one a cut took back since answers nothing. */
  #checks = 0;
  #checking: Promise<void> | undefined;
  /** The reasons his before-release hooks kept a reply back with, for the agent after the message. */
  #kept: string[] = [];

  constructor(options: TagReplyOptions) {
    this.#o = options;
    this.#parser = new TagParser(options.tags);
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
    if (this.#state === "open") this.#flush(false);
    // With his before-release hooks in force, a complete reply waits for its message's end.
    else if (this.#state === "closing" && this.#o.beforeRelease === undefined) this.#out();
  }

  cut(): string {
    this.#parser.reset();
    this.#intent = "";
    this.#extra = false;
    this.#wrote = false;
    if (this.#state === "closing" || this.#state === "checking") {
      this.#checks += 1;
      this.#state = "open";
    }
    return this.#release.drop();
  }

  end(_message: AssistantMessage): void {
    const inIntent = this.#parser.inside === "intent";
    for (const part of this.#parser.end()) this.#take(part);
    if (inIntent) this.#endIntent();
    // A reply this message wrote and left open is complete: the closing tag was left off. A message
    // that wrote none of it (tool calls after a rule stopped the reply) leaves it open for the next.
    if (this.#state === "open" && this.#wrote) this.#state = "closing";
    if (this.#state === "closing" && this.#o.beforeRelease !== undefined) this.#check(this.#o.beforeRelease);
    else this.release();
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

  /** Sends the complete reply on whole, and it is released. */
  #out(): void {
    if (!this.#flush(true)) return;
    this.#state = "released";
    this.#o.onReleased?.(this.#release.shown);
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
          this.#state = "closing";
          this.#out();
          return;
        }
        this.#release.drop();
        this.#state = "none";
        this.#kept.push(reason);
      });
  }

  #take(part: TagPart): void {
    if (part.kind === "open") {
      if (part.role === "intent") this.#o.onIntentBegan?.();
      if (part.role !== "reply") return;
      if (this.#state === "released" || this.#state === "closing" || this.#state === "checking") {
        this.#extra = true;
        this.#notShown();
        return;
      }
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

  /**
   * Sends on what may be shown. False when the reply was not this form's as its first text was to go
   * out (another way has it, or it went out): none of it is shown, the rest of its tag is skipped, and
   * the agent is told.
   */
  #flush(all: boolean): boolean {
    if (this.#release.flush(all)) return true;
    if (this.#state === "open") this.#extra = true;
    this.#state = "none";
    this.#notShown();
    return false;
  }

  /** A reply this form does not show: the agent is told after the message, once in the generation. */
  #notShown(): void {
    if (this.#second === "unsaid") this.#second = "due";
  }

  /** Just before the first text goes out: whether the reply is this form's; if it is, it begins to show. */
  #claim(): boolean {
    if (this.#o.claim?.() === false) return false;
    this.#o.onBegin?.();
    return true;
  }

  #endIntent(): void {
    if (this.#intent !== "") this.#o.onIntent?.(this.#intent);
    this.#intent = "";
  }
}
