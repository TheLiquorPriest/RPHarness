// The limits on one turn (§10.11: "every one is a setting"; Appendix D.1), shared by every agent of
// the turn, under `limits.turn` in a config file, and the limits every agent is held to where its
// definition sets none of its own, under `limits`. `time` is in seconds.

import { worded } from "./entry";
import { LIMITS_WORDS } from "./limits-words";

const NO_LIMIT = "no limit";

export const LIMITS = worded(
  {
    // Appendix D.1: calls in a turn across all agents, at most 40.
    calls: { key: "limits.turn.calls", takes: { type: "whole", least: 1 }, default: 40, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.calls" },
    // Every limit whose default is none takes `~` too, so a chat lifts for itself a limit the global
    // file sets (§5.4: limits per chat and global; §5.2: the nearer level's value is the one in force).
    tokensIn: { key: "limits.turn.tokensIn", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.tokensIn" },
    tokensOut: { key: "limits.turn.tokensOut", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.tokensOut" },
    time: { key: "limits.turn.time", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.time", ms: true },
    // Today's build's own (LumiAH's `turn.toolTurns`, none): the answers that call tools, across all the turn's agents.
    toolRounds: { key: "limits.turn.toolRounds", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.toolRounds" },
    // Today's build's own (LumiAH's `delegation.depth` and `delegation.perRun`), kept as §10.11 says.
    // `depth: 0` and `agents: 0` start no sub-agent at all.
    depth: { key: "limits.turn.depth", takes: { type: "whole", least: 0 }, default: 2, perConnection: false, at: "subAgents.depth" },
    agents: { key: "limits.turn.agents", takes: { type: "whole", least: 0 }, default: 24, orNone: true, none: NO_LIMIT, perConnection: false, at: "subAgents.agents" },
    // Today's build's own (LumiAH's `delegation.atOnce`, 3): one more waits for a place.
    agentsAtOnce: { key: "limits.turn.agentsAtOnce", takes: { type: "whole", least: 1 }, default: 3, perConnection: false, at: "subAgents.agentsAtOnce" },
    // Today's build's own (LumiAH's `concurrency`, 4): an answer's tools that run at once, for an agent whose definition sets none; one more waits for a place.
    toolsAtOnce: { key: "limits.toolsAtOnce", takes: { type: "whole", least: 1 }, default: 4, perConnection: false, at: "toolsAtOnce" },
    // Today's build's own (LumiAH's `loop.repeats`, 3): the same call with the same arguments this many times in a row, nothing written between, ends the agent's run.
    repeats: { key: "limits.repeats", takes: { type: "whole", least: 2 }, default: 3, orNone: true, none: NO_LIMIT, perConnection: false, at: "repeats" },
    // Today's build's own (LumiAH's `spend.cachedWeight`, a tenth): a share of a token; 1 counts it in full.
    cachedWeight: { key: "limits.cachedWeight", takes: { type: "number", least: 0, most: 1 }, default: 0.1, perConnection: false, at: "cachedWeight" },
  },
  LIMITS_WORDS,
);
