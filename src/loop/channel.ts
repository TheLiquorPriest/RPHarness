// Where an agent's text goes as it streams, for the agent that writes the reply (§10.7). The reply's
// forms implement it; the runner feeds it each piece, lets the rules look, then has it send on what
// may be shown.
import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface TextChannel {
  /** A model call begins: a new message. */
  begin(): void;
  /** A piece of the message's text. Nothing is sent on until `release`. */
  write(piece: string): void;
  /** Sends on what may be shown now. */
  release(): void;
  /** A rule stopped the call: what was written and not yet shown is dropped, and given back. */
  cut(): string;
  /** The message ended, whole. */
  end(message: AssistantMessage): void;
  /** The reply so far, shown and held: what a rule on the reply looks at. */
  readonly reply: string;
  /** The end of what has been shown, for the line an agent goes on under after a rule stopped it. */
  tail(): string;
}
