// Where an agent's text goes as it streams, for the agent that writes the reply (§10.7). The reply's
// forms implement it; the runner feeds it each piece, lets the rules look, then has it send on what
// may be shown.
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * How the reply a channel takes is marked, for the line an agent goes on under after a rule stopped
 * it: in the tag form, between the reply contract's tags, named as its header names them; in the
 * plain text of a message otherwise. Laid out as the reply contract is rendered (`form.tags`,
 * `form.two_step`), so the two files can say it alike.
 */
export type ChannelMarks = { form: { tags: true }; tags: { reply: string; intent: string } } | { form: { two_step: true } };

export interface TextChannel {
  /** How the reply this channel takes is marked. */
  readonly marks: ChannelMarks;
  /** A model call begins: a new message. */
  begin(): void;
  /** A piece of the message's text. Nothing is sent on until `release`. */
  write(piece: string): void;
  /** Sends on what may be shown now. */
  release(): void;
  /**
   * A rule stopped the call, or the message did not end whole (its provider failed): what was written
   * and not yet shown is dropped, and given back.
   */
  cut(): string;
  /** The message ended, whole. */
  end(message: AssistantMessage): void;
  /** The reply so far, shown and held: what a rule on the reply looks at. */
  readonly reply: string;
  /**
   * The end of what has been shown, for the line an agent goes on under after a rule stopped it.
   * What the agent writes next is joined to all that was shown, any repeat of its end taken off.
   */
  tail(): string;
  /**
   * Once a message has ended: what the agent is to be told about it, each a text from a file (a
   * second reply that was not shown, §10.7, told once in the generation however often it comes), or
   * the reason his before-release hook kept the reply back with. It goes in with the agent's next
   * call, which it gets for it if its work would otherwise have ended.
   */
  answers?(): string[];
  /** Once a reply that waits for his before-release hooks went out or was kept back (§5.4 "Hooks"): asked before `answers`. */
  settled?(): Promise<void>;
}
