// The agents' thinking in the chat's thinking block (§10.7, as the setting `progress.thinking` lets it go there): each piece of a
// turn's agents' thinking goes to the sink as the model writes it, a stretch at a time, one agent's call from its first piece to its
// end. A call that thinks while another's stretch is shown is held, then given whole once that stretch ends, and goes on as it is
// written if it has not ended by then, so no stretch's pieces come inside another's and none is given twice. A progress line between
// two pieces of a stretch heads its next piece again; after the reply has begun to go out, nothing more is given.
import type { AgentRef, ReplySink } from "../contract";

/** Whose thinking goes to the chat: none (the progress lines alone), the lead's, or every agent's of the turn. */
export type ThinkingShown = "lines" | "lead" | "all";

export interface ThinkingFeedOptions {
  /** Where the pieces go: the turn's sink, as the silence clock wraps it. */
  sink: Required<Pick<ReplySink, "thinking">>;
  shown: ThinkingShown;
  /** The lead's handle: its thinking alone goes, where the setting says the lead's. */
  lead: string;
  /** Whether the chat still takes thinking: false once the reply has begun to go out. */
  open(): boolean;
}

/** A call's thinking, held while another's stretch is shown, and whether its call has ended. */
interface Held {
  agent: AgentRef;
  text: string;
  ended: boolean;
}

const keyOf = (agent: AgentRef, call: number): string => `${agent.id}\u0000${call}`;

export class ThinkingFeed {
  readonly #o: ThinkingFeedOptions;
  /** The call whose stretch is shown now; null: none. */
  #shown: string | null = null;
  /** Whether the shown stretch's next piece is headed: a progress line came since its last. */
  #lined = false;
  /** The calls held, in the order their first piece came. */
  readonly #held = new Map<string, Held>();

  constructor(options: ThinkingFeedOptions) {
    this.#o = options;
  }

  /** A piece of an agent's thinking, as it streams. */
  piece(agent: AgentRef, call: number, text: string): void {
    if (text === "" || !this.#takes(agent) || !this.#o.open()) return;
    const key = keyOf(agent, call);
    if (this.#shown === null) {
      this.#shown = key;
      this.#give(agent, text, true);
    } else if (this.#shown === key) this.#give(agent, text, this.#lined);
    else {
      const held = this.#held.get(key);
      if (held === undefined) this.#held.set(key, { agent, text, ended: false });
      else held.text += text;
    }
  }

  /** A call ended (its answer, or its failure): its stretch is over, and the next held one is given. */
  ended(agent: AgentRef, call: number): void {
    const key = keyOf(agent, call);
    if (this.#shown === key) {
      this.#shown = null;
      this.#next();
    } else {
      const held = this.#held.get(key);
      if (held !== undefined) held.ended = true;
    }
  }

  /** An agent ended: every call of it is over. */
  agentEnded(agent: AgentRef): void {
    for (const held of this.#held.values()) if (held.agent.id === agent.id) held.ended = true;
    if (this.#shown?.startsWith(`${agent.id}\u0000`) === true) {
      this.#shown = null;
      this.#next();
    }
  }

  /** A progress line went to the sink: the shown stretch's next piece is headed again. */
  lined(): void {
    this.#lined = true;
  }

  #takes(agent: AgentRef): boolean {
    return this.#o.shown === "all" || (this.#o.shown === "lead" && agent.id === this.#o.lead);
  }

  /** The held calls in the order they began, each given whole, until one whose call goes on: its stretch is shown from there. */
  #next(): void {
    while (this.#shown === null) {
      const first = this.#held.entries().next();
      if (first.done === true) return;
      const [key, held] = first.value;
      this.#held.delete(key);
      if (!this.#o.open()) continue;
      this.#give(held.agent, held.text, true);
      if (!held.ended) this.#shown = key;
    }
  }

  #give(agent: AgentRef, text: string, first: boolean): void {
    this.#lined = false;
    this.#o.sink.thinking({ agent, text, first });
  }
}
