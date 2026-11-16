// The settings of the tools agents call (§6.8, §13.2): how much of a tool's answer the model reads,
// under `results` in a config file, and what one call of a tool gives and shows, under `tools`.

import { worded } from "./entry";
import { TOOLS_WORDS } from "./tools-words";

export const TOOLS = worded(
  {
    // A tool's answer is cut only where the whole would not fit the call that reads it (§10.2); this is the owner's own ceiling, none by default.
    clip: { key: "results.clip", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: "no ceiling", perConnection: false, at: "clipChars" },
    // A handful of tools an agent reads at a glance.
    search: { key: "tools.search", takes: { type: "whole", least: 1 }, default: 8, perConnection: false, at: "searchHits" },
    // At about 200 characters a hit, a check of three places comes to about the 12,000 characters of a
    // result the model reads whole by default.
    gapCheck: { key: "tools.gapCheck", takes: { type: "whole", least: 1 }, default: 20, perConnection: false, at: "gapHits" },
    // The longest stretch the history window holds under Appendix D.1's settings (40 messages, a step
    // of 20, and 40 more held for the story's record), and five times the hits a gap check takes from
    // a place by default.
    perCall: { key: "tools.perCall", takes: { type: "whole", least: 1 }, default: 100, perConnection: false, at: "perCall" },
    // About 190 tokens: the schema of a tool of two or three arguments with their descriptions, as RPH's
    // own file tools are; a tool of many arguments, whose schema costs more to read than the call cost
    // to write, is answered with what did not fit alone.
    schemaShown: { key: "tools.schemaShown", takes: { type: "whole", least: 0 }, default: 600, perConnection: false, at: "schemaShown" },
    // Appendix D.1: the fixed list's tools under 8,000 tokens. A list over it is marked, never refused.
    fixedTokens: { key: "tools.fixedTokens", takes: { type: "whole", least: 1 }, default: 8_000, perConnection: false, at: "fixedTokens" },
  },
  TOOLS_WORDS,
);
