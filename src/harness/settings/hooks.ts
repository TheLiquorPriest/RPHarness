// The settings his hooks run under (§5.4 "Hooks", P6, P15), under `hooks` in a config file.

import { worded } from "./entry";
import { HOOKS_WORDS } from "./hooks-words";

export const HOOKS = worded(
  {
    // §16: a command he writes answers in seconds or has hung; the same half minute a command tool has.
    timeout: { key: "hooks.timeoutSeconds", takes: { type: "whole", least: 1 }, default: 30, perConnection: false, at: "hookTimeout", ms: true },
    // The exit code that blocks in the coding harnesses' hooks, so a hook written for one blocks here too.
    blockExit: { key: "hooks.blockExit", takes: { type: "whole", least: 1 }, default: 2, perConnection: false, at: "hookBlockExit" },
    // 1 MiB: a command tool's ceiling, far past any context a hook adds.
    answerMax: { key: "hooks.maxAnswerBytes", takes: { type: "whole", least: 1 }, default: 1_048_576, perConnection: false, at: "hookAnswerMax" },
    // A few lines of stderr: enough to say why, short enough for the live view.
    reasonChars: { key: "hooks.reasonChars", takes: { type: "whole", least: 0 }, default: 2_000, perConnection: false, at: "hookReasonChars" },
  },
  HOOKS_WORDS,
);
