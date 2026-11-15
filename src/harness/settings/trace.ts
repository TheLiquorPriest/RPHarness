// The settings of what is kept of each turn: which calls' requests the turn's folder keeps, under
// `trace` in a config file, and how many turns' prompts are kept to compare the next one with (§4.8),
// under `prompt`; and how far a page following runs live may fall behind them, under `live`.

import { worded } from "./entry";
import { TRACE_WORDS } from "./trace-words";

export const TRACE = worded(
  {
    // What the floor test and the Turn page read (§17.1: the Author's first request), at one file per agent a turn.
    requests: { key: "trace.requests", takes: { type: "oneOf", values: ["first", "all", "none"] }, default: "first", perConnection: false },
    // Appendix D.1's 50 turn folders kept whole per chat (§5.5): a turn older than that is compared with none.
    promptKept: { key: "prompt.kept", takes: { type: "whole", least: 1 }, default: 50, perConnection: false },
    // A page that has not taken this many of one run's items is cut off and told so (§5.6), so no run waits on it; each run reads it for itself.
    liveBacklog: { key: "live.backlog", takes: { type: "whole", least: 1 }, default: 5000, perConnection: false },
  },
  TRACE_WORDS,
);
