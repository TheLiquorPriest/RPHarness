// What the runner asks of the user's triggered rules (§5.4). Loading rule files, testing their
// conditions and keeping to their `repeat:` is the rules' own work; the runner only says what was
// written and when a run would end, and does what a firing says.
import type { AgentRef, RuleFiring } from "../contract";

/** A rule that fired, as the rules give it to the runner. */
export interface Fired {
  /** The firing, less what the runner adds: the agent, what was done and what was dropped. */
  firing: Omit<RuleFiring, "agent" | "action" | "dropped" | "then">;
  /** The rule's text, ready to put in front of the agent. */
  text: string;
}

/** A rule that fired on what an agent is writing. */
export interface StreamFired extends Fired {
  /** Stop the call and go on (`cut`); or, with `interrupt: never`, let the message finish and add the text after it (`remind`). */
  interrupt: boolean;
}

/** What an agent has written so far in the call under way. */
export interface Written {
  agent: AgentRef;
  call: number;
  /** Where the newest piece went. */
  piece: "text" | "thinking";
  text: string;
  thinking: string;
  /** The reply so far, shown and held, for the agent that writes it. */
  reply?: string;
}

export interface StreamRules {
  /** Whether a rule that interrupts looks at the reply, so the reply is held back by sentences (§5.4). */
  readonly coverReply: boolean;
  /** Looks at what was written after each piece, and gives back a rule that fires. */
  check(written: Written): StreamFired | undefined;
}

/** The moment an agent's work would end: its last message has no calls left to answer. */
export interface RunEndMoment {
  agent: AgentRef;
  /** The call that ended with that message. */
  call: number;
}

export interface RunEndRules {
  /** The rules due at this moment; their texts go in as follow-ups and the agent gets another call. */
  due(moment: RunEndMoment): Fired[] | Promise<Fired[]>;
}

/** A message an agent finished whole, for the `question:` rules: its text and its thinking. */
export interface Finished {
  agent: AgentRef;
  call: number;
  text: string;
  thinking: string;
}

/** A `question:` rule that fired: its text goes in front of the agent (`now`), or was held for the next briefing because the reply it is about was already shown (`briefing`). */
export interface Judged {
  fired: Fired;
  deliver: "now" | "briefing";
}

/** One question put to the judging model about a message. */
export interface Judgment {
  /** The agent waits for the answer before its next call (`interrupt: always`); otherwise it goes on. */
  wait: boolean;
  /** Settles with the rule that fired, or undefined when it does not. */
  answer: Promise<Judged | undefined>;
}

/** The `question:` rules (§5.4): put to a judging model about each message an agent finishes. */
export interface QuestionRules {
  /** The questions due on a message just finished. */
  ask(message: Finished): Judgment[];
  /** A rule that fired once the agent's work had ended or stopped: its text has no way in front of the agent in this work. */
  late(agent: AgentRef, judged: Judged): void;
}
