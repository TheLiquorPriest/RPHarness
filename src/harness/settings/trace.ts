// The settings of what is kept of each turn: which calls' requests the turn's folder keeps, under
// `trace` in a config file; and how far a page following runs live may fall behind them, under
// `live`. How many turns' prompts are compared is the host's: RPH compares a turn with the one before
// while the host keeps that turn's folder (§4.8, §5.5).

import { worded } from "./entry";
import { TRACE_WORDS } from "./trace-words";

export const TRACE = worded(
  {
    // What the floor test and the Turn page read (§17.1: the Author's first request), at one file per agent a turn.
    requests: { key: "trace.requests", takes: { type: "oneOf", values: ["first", "all", "none"] }, default: "first", perConnection: false, at: "requests" },
    // A page that has left more of one run's items untaken than this is cut off and told so (§14, the live view), so no run waits on it; each run reads it for itself.
    liveBacklog: { key: "live.backlog", takes: { type: "whole", least: 1 }, default: 5000, perConnection: false, at: "liveBacklog" },
  },
  TRACE_WORDS,
);

/** Keys this group once read and reads no longer, each with what holds in its place: a file that still sets one is told so in the log. */
export const TRACE_GONE: Readonly<Record<string, string>> = {
  "prompt.kept": "a turn's prompt is compared with the turn before while the host keeps that turn's folder",
};
