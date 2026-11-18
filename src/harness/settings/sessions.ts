// What a session keeps from turn to turn (§11), under `sessions` in a config file: the scratch files its cache keeps as they stand (R-111, D-155).

import { worded } from "./entry";
import { SESSIONS_WORDS } from "./sessions-words";

export const SESSIONS = worded(
  {
    // The scene sheet, which the shipped sandbox skill and the GM's definition name.
    carried: { key: "sessions.carried", takes: { type: "texts" }, default: ["scratch/scene.md"], perConnection: false, at: "sessions.carried" },
    // Sessions whose file the harness keeps read in memory between their turns, the one used least recently let go first; 0 reads each turn's file afresh.
    held: { key: "sessions.held", takes: { type: "whole", least: 0 }, default: 8, perConnection: false, at: "sessions.held" },
    // Sessions in one page of the Sessions page's list when the page asks for no number.
    page: { key: "sessions.page", takes: { type: "whole", least: 1 }, default: 50, perConnection: false, at: "sessions.page" },
    // Mebibytes of session lines held in memory, every session's, while their files cannot be written (a full disk, a folder taken away, a host that refuses); past them, a turn or a job whose own file cannot be written stops and ends failed, and what is held stays held. A bound of the process, so a chat's own file does not set it.
    unwrittenMost: { key: "sessions.maxUnwrittenMiB", takes: { type: "whole", least: 1 }, default: 64, perConnection: false, levels: ["shipped", "global"], at: "sessions.unwrittenMost" },
  },
  SESSIONS_WORDS,
);
