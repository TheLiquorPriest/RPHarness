// The settings of the rules that trigger (§5.4 "Rules"), under `rules` in a config file.

import { worded } from "./entry";
import { RULES_WORDS } from "./rules-words";

export const RULES = worded(
  {
    // Wide enough for any phrase a rule looks for, with room to spare; narrow enough that a pattern of
    // the kinds the rules let in takes at most some tens of milliseconds on it.
    window: { key: "rules.window", takes: { type: "whole", least: 1 }, default: 500, perConnection: false },
    // §5.4: the judging model for `question:` rules is a connection the user chooses. None by default:
    // the asking agent's own (Appendix D.1: the Author's connection, until you choose another).
    judge: { key: "rules.judge", takes: { type: "text" }, default: null, none: "the asking agent's own connection", perConnection: false },
  },
  RULES_WORDS,
);
