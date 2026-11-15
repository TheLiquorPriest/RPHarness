// The limits on one turn (§10.11: "every one is a setting"; Appendix D.1), shared by every agent of
// the turn, under `limits.turn` in a config file. `time` is in seconds.

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
    // Today's build's own (LumiAH's `delegation.depth` and `delegation.perRun`), kept as §10.11 says.
    // `depth: 0` and `agents: 0` start no sub-agent at all.
    depth: { key: "limits.turn.depth", takes: { type: "whole", least: 0 }, default: 2, perConnection: false, at: "subAgents.depth" },
    agents: { key: "limits.turn.agents", takes: { type: "whole", least: 0 }, default: 24, orNone: true, none: NO_LIMIT, perConnection: false, at: "subAgents.agents" },
  },
  LIMITS_WORDS,
);
