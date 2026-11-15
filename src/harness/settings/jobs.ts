// The limits on jobs (§13.5, §10.11), under `jobs` in a config file: how many run at once (one past it
// waits for a place) and how many may be started in a day, of every job of the user's and of those
// whose agent runs on one connection (by its name or id); how many the agents of one run may start;
// the tokens all of the user's jobs may spend in a day; and what one job's run may spend across its
// agents (`time` in seconds).
//
// Today's build's own (LumiAH's `jobs.atOnce`, `jobs.perRun`, `jobs.tokensPerDay`, `spend.cachedWeight`
// and `jobs.budget`: two at once, six a turn, 12,000,000 tokens a day with a token read again from a
// provider's cache counted as a tenth of one, and for each job 60 rounds of calls, 600,000 tokens in,
// 60,000 out and 15 minutes), kept as §10.11 says. Today's build counted no jobs a day: it counted
// their tokens. It weighed a cached token so against every limit on tokens sent; here only the day's
// job tokens do, and every other limit counts it in full.

import { worded } from "./entry";
import { JOBS_WORDS } from "./jobs-words";

const NO_LIMIT = "no limit";
const NONE_OF_ITS_OWN = "no limit of its own";

export const JOBS = worded(
  {
    atOnce: { key: "jobs.atOnce", takes: { type: "whole", least: 1 }, default: 2, perConnection: false },
    perDay: { key: "jobs.perDay", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false },
    // `perRun: 0` starts no job at all.
    perRun: { key: "jobs.perRun", takes: { type: "whole", least: 0 }, default: 6, orNone: true, none: NO_LIMIT, perConnection: false },
    tokensPerDay: { key: "jobs.tokensPerDay", takes: { type: "whole", least: 1 }, default: 12_000_000, orNone: true, none: NO_LIMIT, perConnection: false },
    // A share of a token: 1 counts it in full.
    cachedWeight: { key: "jobs.cachedWeight", takes: { type: "number", least: 0, most: 1 }, default: 0.1, perConnection: false },
    connectionAtOnce: { key: "jobs.connections.<connection>.atOnce", takes: { type: "whole", least: 1 }, default: null, none: NONE_OF_ITS_OWN, perConnection: true },
    connectionPerDay: { key: "jobs.connections.<connection>.perDay", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NONE_OF_ITS_OWN, perConnection: true },
    runCalls: { key: "jobs.run.calls", takes: { type: "whole", least: 1 }, default: 60, orNone: true, none: NO_LIMIT, perConnection: false },
    runTokensIn: { key: "jobs.run.tokensIn", takes: { type: "whole", least: 1 }, default: 600_000, orNone: true, none: NO_LIMIT, perConnection: false },
    runTokensOut: { key: "jobs.run.tokensOut", takes: { type: "whole", least: 1 }, default: 60_000, orNone: true, none: NO_LIMIT, perConnection: false },
    runTime: { key: "jobs.run.time", takes: { type: "whole", least: 1 }, default: 900, orNone: true, none: NO_LIMIT, perConnection: false },
  },
  JOBS_WORDS,
);
