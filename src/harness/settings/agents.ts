// Each agent's effort and limits, by its definition (§2.1 point 5, 17 Nov: "each agent's effort and
// limits included"), under `agents.<definition>` in a config file, read at every level. A value a
// level sets stands over the definition's own header (`effort:`, `limits:`), `~` included: `~` lifts
// the header's limit, and for the effort leaves the agent at its connection's. With none set, the
// header's holds. `time` and `callTime` are in seconds, as the header writes them.
//
// Beside them, the effort every agent on a connection thinks at, by the connection's name or id
// (`effort.connections`; plan §20: "low effort on the floor model, set per connection, the shipped
// definitions unchanged"): it stands over each definition's `effort:`, and an agent's own setting
// stands over it. Not under `models`: a host keeps the model layer's connections there.

import type { Effort } from "../../contract";
import { AGENTS_WORDS } from "./agents-words";
import { CONNECTION, DEFINITION, worded } from "./entry";

/** Every effort a definition's `effort:` takes, which the setting takes too. */
const EFFORTS: Record<Effort, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };

const OWN = `agents.${DEFINITION}` as const;
const LIMIT = `${OWN}.limits` as const;
const NO_LIMIT = "no limit";
const AS_ITS_DEFINITION = "as its definition says";

export const AGENTS = worded(
  {
    effort: { key: `${OWN}.effort`, takes: { type: "oneOf", values: Object.keys(EFFORTS) as Effort[] }, default: null, orNone: true, none: "its connection's", unset: AS_ITS_DEFINITION, perConnection: false, at: `${OWN}.effort`, noneKept: true },
    connection: { key: `effort.connections.${CONNECTION}`, takes: { type: "oneOf", values: Object.keys(EFFORTS) as Effort[] }, default: null, orNone: true, none: "as each agent's definition says", perConnection: true, at: `efforts.${CONNECTION}` },
    calls: { key: `${LIMIT}.calls`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.calls`, noneKept: true },
    tokensIn: { key: `${LIMIT}.tokensIn`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.tokensIn`, noneKept: true },
    tokensOut: { key: `${LIMIT}.tokensOut`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.tokensOut`, noneKept: true },
    time: { key: `${LIMIT}.time`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.time`, ms: true, noneKept: true },
    callTokensIn: { key: `${LIMIT}.callTokensIn`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.callTokensIn`, noneKept: true },
    callTokensOut: { key: `${LIMIT}.callTokensOut`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.callTokensOut`, noneKept: true },
    callTime: { key: `${LIMIT}.callTime`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.callTime`, ms: true, noneKept: true },
    toolRounds: { key: `${LIMIT}.toolRounds`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.toolRounds`, noneKept: true },
    toolsPerAnswer: { key: `${LIMIT}.toolsPerAnswer`, takes: { type: "whole", least: 0 }, advise: { below: 1 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.toolsPerAnswer`, noneKept: true },
    // None here is `limits.toolsAtOnce`, every agent's; 0 would run no tool at all.
    toolsAtOnce: { key: `${LIMIT}.toolsAtOnce`, takes: { type: "whole", least: 1 }, default: null, orNone: true, none: "as limits.toolsAtOnce says", unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.toolsAtOnce`, noneKept: true },
    // 0: a sub-agent is sent no message after its first answer.
    messages: { key: `${LIMIT}.messages`, takes: { type: "whole", least: 0 }, default: null, orNone: true, none: NO_LIMIT, unset: AS_ITS_DEFINITION, perConnection: false, at: `${LIMIT}.messages`, noneKept: true },
  },
  AGENTS_WORDS,
);
