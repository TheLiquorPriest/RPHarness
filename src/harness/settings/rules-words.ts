export const RULES_WORDS = {
  "rules.windowChars": { name: "What a pattern looks at", about: "Characters a rule's pattern looks at at a time, the newest of what is written and stretches of a tool's arguments or result; none: the whole text." },
  "rules.patternMs": { name: "Time a rule's pattern may run", about: "Milliseconds one rule's pattern may run on one text; past it the run is stopped, counts as no match, and is shown on the Turn page." },
  "rules.interrupt": { name: "A stream rule that interrupts", about: "What a stream rule that interrupts does: stop the call where it matched, or remind the agent after it instead." },
  "connections.<connection>.rules.interrupt": { name: "A stream rule that interrupts, on a connection", about: "Stop or remind, for one connection whose stopped reply cannot go on cleanly." },
  "rules.judge": { name: "Connection that judges questions", about: "The connection that answers a rule's question, by its name or id, where the rule names none." },
  "rules.commandTimeoutSeconds": { name: "Time a rule's command may take", about: "Seconds a rule's command may take to answer yes or no; past them it is stopped and the rule is shown as unable to work, never as a no." },
};
