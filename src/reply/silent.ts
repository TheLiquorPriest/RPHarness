// The draft writer's channel (§10.6, §5.4): a reply written as a draft shows nothing while it is
// written; the lead reads it whole once its writer is done. The rules on the reply still look at it
// as it is written, so a rule that interrupts stops the draft at its match, before the lead ever
// reads it.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChannelMarks, TextChannel } from "../loop/channel";

export class SilentReply implements TextChannel {
  /** A draft is the plain text of the writer's message. */
  readonly marks: ChannelMarks = { form: { two_step: true } };
  /** The text of the message under way: the draft as far as it is written. */
  #message = "";

  /** What a rule on the reply looks at: the draft so far. */
  get reply(): string {
    return this.#message;
  }

  begin(): void {
    this.#message = "";
  }

  write(piece: string): void {
    this.#message += piece;
  }

  release(): void {
    // A draft is never shown: the lead reads it whole from the writer's answer.
  }

  cut(): string {
    const written = this.#message;
    this.#message = "";
    return written;
  }

  end(_message: AssistantMessage): void {
    // The draft is the writer's last message, which its work's outcome carries.
  }

  /** Nothing of a draft is shown. */
  get shown(): string {
    return "";
  }

  tail(): string {
    return "";
  }
}
