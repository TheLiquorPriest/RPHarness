// The reply's settings and their defaults (Appendix D.1). Each is a setting the user can change;
// these are the values used where none was set.
export const REPLY_DEFAULTS = {
  /** Sentences a reply is held back by while a rule that interrupts covers it. */
  heldSentences: 1,
  /** How many of the last sentences shown go with the line an agent goes on under after a rule stopped it. */
  tailSentences: 3,
  /** Silence, in milliseconds, before a progress line goes to the chat's thinking block. */
  silenceMs: 60_000,
} as const;
