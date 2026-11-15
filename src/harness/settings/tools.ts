// The settings of the tools agents call (§6.8, §13.2): how much of a tool's answer the model reads,
// under `results` in a config file, and what one call of a tool gives and shows, under `tools`.

import { GAP_HITS } from "../../tools/base/gap";
import { SEARCH_HITS } from "../../tools/search/tools";
import { worded } from "./entry";
import { TOOLS_WORDS } from "./tools-words";

export const TOOLS = worded(
  {
    // A long message of a story, or a lore entry, runs from 6,000 to 12,000 characters, and an agent should read one in one go.
    clip: { key: "results.clip", takes: { type: "whole", least: 1 }, default: 12_000, perConnection: false },
    // Tool search's own (`SEARCH_HITS`): a handful an agent reads at a glance.
    search: { key: "tools.search", takes: { type: "whole", least: 1 }, default: SEARCH_HITS, perConnection: false },
    // The gap check's own (`GAP_HITS`): about the characters of a result the model reads whole, over three places.
    gapCheck: { key: "tools.gapCheck", takes: { type: "whole", least: 1 }, default: GAP_HITS, perConnection: false },
    // The longest stretch the history window holds under Appendix D.1's settings (40 messages, a step
    // of 20, and 40 more held for the story's record), and five times the hits a gap check takes from
    // a place by default.
    perCall: { key: "tools.perCall", takes: { type: "whole", least: 1 }, default: 100, perConnection: false },
    // About 190 tokens: the schema of a tool of two or three arguments with their descriptions, as RPH's
    // own file tools are; a tool of many arguments, whose schema costs more to read than the call cost
    // to write, is answered with what did not fit alone.
    schemaShown: { key: "tools.schemaShown", takes: { type: "whole", least: 0 }, default: 600, perConnection: false },
  },
  TOOLS_WORDS,
);
