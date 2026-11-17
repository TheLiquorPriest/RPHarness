// The limits on jobs (§13.5, §10.11), under `jobs` in a config file: how many run at once (one past it
// waits for a place) and how many may be started in a day, of every job of the user's and, under
// `connections.<connection>.jobs`, of those whose agent runs on one connection (by its name or id);
// how many the agents of one run may start; the tokens all of the user's jobs may spend in a day; and
// what one job's run may spend across its agents (`seconds` its time) and the sub-agents it may start.
//
// How many run at once is today's build's own (LumiAH's `jobs.atOnce`, two): it queues work and cuts
// none. No default cuts a job's work short (§2.1 point 4, 17 Nov): the jobs one run may start, the
// jobs' tokens in a day, and a job's run's calls, tokens and time have none; one he sets is held.
// The weight of a token read again from a provider's cache is `limits.cachedWeight`, against every limit.

import { worded } from "./entry";
import { JOBS_WORDS } from "./jobs-words";

const NO_LIMIT = "no limit";
const NONE_OF_ITS_OWN = "no limit of its own";

export const JOBS = worded(
  {
    atOnce: { key: "jobs.atOnce", takes: { type: "whole", least: 1 }, default: 2, perConnection: false, at: "jobs.atOnce" },
    perDay: { key: "jobs.perDay", takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "jobs.perDay" },
    // `perRun: 0` starts no job at all.
    perRun: { key: "jobs.perRun", takes: { type: "whole", least: 0 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "jobs.perRun" },
    tokensPerDay: { key: "jobs.tokensPerDay", takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "jobs.tokensPerDay" },
    // Every connection `connections` names with a mapping counts its jobs, a limit set or not.
    connectionAtOnce: { key: "connections.<connection>.jobs.atOnce", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NONE_OF_ITS_OWN, perConnection: true, at: "jobs.byConnection.<connection>.atOnce" },
    connectionPerDay: { key: "connections.<connection>.jobs.perDay", takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NONE_OF_ITS_OWN, perConnection: true, at: "jobs.byConnection.<connection>.perDay" },
    runCalls: { key: "jobs.run.calls", takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "jobs.run.calls" },
    runTokensIn: { key: "jobs.run.tokensIn", takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "jobs.run.tokensIn" },
    runTokensOut: { key: "jobs.run.tokensOut", takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "jobs.run.tokensOut" },
    runTime: { key: "jobs.run.seconds", takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "jobs.run.timeMs", ms: true },
    // `agents: 0` starts no sub-agent at all.
    runAgents: { key: "jobs.run.agents", takes: { type: "whole", least: 0 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "jobs.run.agents" },
    // How long a job's record is kept: the Jobs page lists them a page at a time, and the oldest go as a job starts.
    keepDays: { key: "jobs.keepDays", takes: { type: "whole", least: 1 }, default: 90, perConnection: false, at: "jobs.keepDays" },
    // In a job, the Author's connection judges a rule's question where neither the rule nor `rules.judge` names one; this names the Author.
    lead: { key: "turn.lead", takes: { type: "text" }, default: null, orNone: true, none: "the asking agent's own", perConnection: false, levels: ["shipped", "global", "chat"], at: "lead" },
  },
  JOBS_WORDS,
);
