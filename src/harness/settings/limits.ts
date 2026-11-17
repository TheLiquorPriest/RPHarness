// The limits on one turn (§10.11: "every one is a setting"; Appendix D.1), shared by every agent of
// the turn, under `limits.turn` in a config file, and the limits every agent is held to where its
// definition sets none of its own, under `limits`. `time` is in seconds. No default cuts an agent's
// work short (§2.1 point 4): calls, tool rounds, tokens and time have none, and one he sets is held.
// What waits for a place (sub-agents and tool calls at once) queues work and cuts none.

import { worded } from "./entry";
import { LIMITS_WORDS } from "./limits-words";

const NO_LIMIT = "no limit";

export const LIMITS = worded(
  {
    // §2.1 point 4 (17 Nov): no default limit on the calls of a turn; D.1's 40 gives way to it.
    calls: { key: "limits.turn.calls", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.calls" },
    // Every limit whose default is none takes `~` too, so a chat lifts for itself a limit the global
    // file sets (§5.4: limits per chat and global; §5.2: the nearer level's value is the one in force).
    tokensIn: { key: "limits.turn.tokensIn", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.tokensIn" },
    tokensOut: { key: "limits.turn.tokensOut", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.tokensOut" },
    time: { key: "limits.turn.time", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.time", ms: true },
    // Today's build's own (LumiAH's `turn.toolTurns`, none): the answers that call tools, across all the turn's agents.
    toolRounds: { key: "limits.turn.toolRounds", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "turn.toolRounds" },
    // Today's build's own (LumiAH's `delegation.depth` and `delegation.perRun`), kept as §10.11 says;
    // the count of sub-agents a turn starts has no default (§2.1 point 4).
    // `depth: 0` and `agents: 0` start no sub-agent at all.
    depth: { key: "limits.turn.depth", takes: { type: "whole", least: 0 }, default: 2, perConnection: false, at: "subAgents.depth" },
    agents: { key: "limits.turn.agents", takes: { type: "whole", least: 0 }, default: null, orNone: true, none: NO_LIMIT, perConnection: false, at: "subAgents.agents" },
    // Today's build's own (LumiAH's `delegation.atOnce`, 3): one more waits for a place.
    agentsAtOnce: { key: "limits.turn.agentsAtOnce", takes: { type: "whole", least: 1 }, default: 3, perConnection: false, at: "subAgents.agentsAtOnce" },
    // Today's build's own (LumiAH's `concurrency`, 4): an answer's tools that run at once, for an agent whose definition sets none; one more waits for a place.
    toolsAtOnce: { key: "limits.toolsAtOnce", takes: { type: "whole", least: 1 }, default: 4, perConnection: false, at: "toolsAtOnce" },
    // The same call with the same arguments this many times in a row, nothing written between, ends the agent's run: the one guard against a run that loops, at 10 so it does not end a run that was working (§2.1, 17 Nov).
    repeats: { key: "limits.repeats", takes: { type: "whole", least: 2 }, default: 10, orNone: true, none: NO_LIMIT, perConnection: false, at: "repeats" },
    // Today's build's own (LumiAH's `spend.cachedWeight`, a tenth): a share of a token; 1 counts it in full.
    cachedWeight: { key: "limits.cachedWeight", takes: { type: "number", least: 0, most: 1 }, default: 0.1, perConnection: false, at: "cachedWeight" },
  },
  LIMITS_WORDS,
);
