// What a session keeps from turn to turn (§11), under `sessions` in a config file: the scratch files its cache keeps as they stand (R-111, D-155).

import { worded } from "./entry";
import { SESSIONS_WORDS } from "./sessions-words";

export const SESSIONS = worded(
  {
    // The scene sheet, which the shipped sandbox skill and the GM's definition name.
    carried: { key: "sessions.carried", takes: { type: "texts" }, default: ["scratch/scene.md"], perConnection: false, at: "sessions.carried" },
  },
  SESSIONS_WORDS,
);
