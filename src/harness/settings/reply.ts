// The settings of the reply (§10.6, §10.7, Appendix D.1), under `reply` in a config file, and of the
// progress lines in the chat's thinking block, under `progress`. Times are in seconds.

import { worded } from "./entry";
import { REPLY_WORDS } from "./reply-words";

const FORMS = ["tags", "two-step"] as const;

export const REPLY = worded(
  {
    // Appendix D.1: by tags, in two steps where a connection was measured not to keep them.
    form: { key: "reply.form", takes: { type: "oneOf", values: FORMS }, default: "tags", perConnection: false, at: "form" },
    forms: { key: "connections.<connection>.reply.form", takes: { type: "oneOf", values: FORMS }, default: null, orNone: true, none: "as reply.form says", perConnection: true, at: "forms.<connection>" },
    // §18.1 row 0.2: the tags kept in at least 28 of 30 turns. A tag check plays `turns` and sets the tag form at `kept` or more.
    checkTurns: { key: "reply.check.turns", takes: { type: "whole", least: 1 }, default: 30, perConnection: false, at: "checkTurns" },
    checkKept: { key: "reply.check.kept", takes: { type: "whole", least: 1 }, default: 28, perConnection: false, at: "checkKept" },
    streamAnyway: { key: "reply.streamAnyway", takes: { type: "texts" }, default: [], perConnection: false, at: "streamAnyway" },
    // Appendix D.1: a reply is held back by one sentence while a rule that interrupts covers it, and an
    // agent that goes on after a rule stopped it is shown its last three sentences again.
    heldSentences: { key: "reply.heldSentences", takes: { type: "whole", least: 0 }, default: 1, perConnection: false, at: "heldSentences" },
    tailSentences: { key: "reply.tailSentences", takes: { type: "whole", least: 0 }, default: 3, perConnection: false, at: "tailSentences" },
    // Appendix D.1: the lead's sampling is its own.
    leadSampling: { key: "reply.leadSampling", takes: { type: "oneOf", values: ["own", "preset"] }, default: "own", perConnection: false, at: "leadSampling" },
    // Appendix D.1: progress lines in the thinking block.
    show: { key: "progress.show", takes: { type: "oneOf", values: ["all", "least"] }, default: "all", perConnection: false, at: "progress" },
    // Appendix D.1: a line when nothing has been shown for a minute. §10.7: a generation that sends no
    // text for ten minutes is ended, so a line should come inside them; past nine minutes the page
    // says so, and the value is taken (§2.1 point 5: no hard cap).
    silence: { key: "progress.silenceSeconds", takes: { type: "whole", least: 1 }, advise: { above: 540 }, default: 60, perConnection: false, at: "silenceMs", ms: true },
  },
  REPLY_WORDS,
);
