// What every agent of the user's spends over any 24 hours (§10.11 "with daily caps", READINGS R-35;
// plan/CONTRACT.md condition 5: a day is the last 24 hours), turns and jobs alike, as today's build
// capped every agent's tokens a day (`spend.tokensPerDay`, none by default); and how many finished
// runs' usage is kept to be asked for after a restart (today's 1,000, held in memory there).

import { worded } from "./entry";
import { USAGE_WORDS } from "./usage-words";

export const USAGE = worded(
  {
    dayTokens: { key: "limits.day.tokens", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: "no limit", perConnection: false, at: "day.tokens" },
    // The user's runs, read where no chat is in view: the levels every chat shares.
    keptRuns: { key: "usage.keptRuns", takes: { type: "whole", least: 1 }, default: 1_000, perConnection: false, levels: ["shipped", "global"], at: "usage.keptRuns" },
  },
  USAGE_WORDS,
);
