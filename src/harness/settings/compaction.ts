// When a session's earlier turns are summarized (§11), under `compaction` in a config file: the tokens
// kept free for the answer, how many of the newest turns are kept as they were, the tokens of carried
// records past which the records mode folds them into the summary, and the model calls the lead makes
// in its call at the moment before a compaction.

import { worded } from "./entry";
import { COMPACTION_WORDS } from "./compaction-words";

export const COMPACTION = worded(
  {
    // Appendix D.1: the reserve pi's coding agent keeps (16,384 tokens), the newest 3 turns kept as they
    // are, and records folded once they pass 6,000 tokens. §11: the lead gets one call with the rule's
    // text before anything is summarized.
    reserve: { key: "compaction.reserve", takes: { type: "whole", least: 0 }, default: 16_384, perConnection: false, at: "compaction.reserve" },
    keepTurns: { key: "compaction.keepTurns", takes: { type: "whole", least: 0 }, default: 3, perConnection: false, at: "compaction.keepTurns" },
    records: { key: "compaction.records", takes: { type: "whole", least: 1 }, default: 6_000, perConnection: false, at: "compaction.records" },
    saveCalls: { key: "compaction.saveCalls", takes: { type: "whole", least: 1 }, default: 1, perConnection: false, at: "compaction.saveCalls" },
    // pi's coding agent compacts and sends a refused call again once, and keeps its newest 20,000 tokens whole (`keepRecentTokens`).
    overflowTries: { key: "compaction.overflowTries", takes: { type: "whole", least: 0 }, default: 1, perConnection: false, at: "compaction.overflowTries" },
    keepRecent: { key: "compaction.keepRecent", takes: { type: "whole", least: 0 }, default: 20_000, perConnection: false, at: "compaction.keepRecent" },
  },
  COMPACTION_WORDS,
);
