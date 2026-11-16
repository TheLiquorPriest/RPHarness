// The settings of the rules that trigger (§5.4 "Rules"), under `rules` in a config file.

import { worded } from "./entry";
import { RULES_WORDS } from "./rules-words";

const MODES = ["stop", "remind"] as const;

export const RULES = worded(
  {
    // R-55: a pattern may see the whole of what is written; he narrows it here if he wants.
    window: { key: "rules.window", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: "the whole text", perConnection: false, at: "ruleWindow" },
    // R-55, D-127: a pattern runs where it can be stopped. 1,000 checks of a 2,000-character text take some 15 ms in all on Bun, so 50 ms stops only a runaway.
    patternTime: { key: "rules.patternTime", takes: { type: "whole", least: 1 }, default: 50, perConnection: false, at: "patternTime" },
    // §18.1 row 0.2's fallback: a stream rule that interrupts stops the call, or, on a connection where a stopped reply cannot go on cleanly, reminds instead.
    interrupt: { key: "rules.interrupt", takes: { type: "oneOf", values: MODES }, default: "stop", perConnection: false, at: "ruleInterrupt" },
    interrupts: { key: "rules.interrupts.<connection>", takes: { type: "oneOf", values: MODES }, default: null, orNone: true, none: "as rules.interrupt says", perConnection: true, at: "ruleInterrupts.<connection>" },
    // §5.4: the judging model for `question:` rules is a connection the user chooses. None by default:
    // the asking agent's own (Appendix D.1: the Author's connection, until you choose another).
    judge: { key: "rules.judge", takes: { type: "text" }, default: null, orNone: true, none: "the asking agent's own connection", perConnection: false, at: "judge" },
    // A rule's command answers yes or no about the moment; ten seconds is long for that and short of holding a turn up.
    commandTimeout: { key: "rules.commandTimeout", takes: { type: "whole", least: 1 }, default: 10, perConnection: false, at: "ruleCommandTimeout", ms: true },
  },
  RULES_WORDS,
);
