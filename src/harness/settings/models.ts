// The settings of the models agents run on: the effort every agent on a connection thinks at, by the
// connection's name or its id, whatever its definition says; none by default, so each agent thinks at
// the effort its definition gives, or its model's own.

import type { Effort } from "../../contract";
import { worded } from "./entry";
import { MODELS_WORDS } from "./models-words";

/** Every effort a definition's `effort:` takes, which `effort.connections` takes too. */
const EFFORTS: Record<Effort, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };

export const MODELS = worded(
  {
    // Not under `models`: a host keeps the model layer's connections there, and saving one rewrites that key whole.
    effort: { key: "effort.connections.<connection>", takes: { type: "oneOf", values: Object.keys(EFFORTS) as Effort[] }, default: null, orNone: true, none: "as each agent's definition says", perConnection: true, at: "efforts.<connection>" },
  },
  MODELS_WORDS,
);
