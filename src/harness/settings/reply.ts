// The settings of the reply (§10.6, §10.7, Appendix D.1), under `reply` in a config file, and of the
// progress lines in the chat's thinking block, under `progress`. Times are in seconds.

import { worded } from "./entry";
import { REPLY_WORDS } from "./reply-words";

const FORMS = ["tags", "two-step"] as const;

export const REPLY = worded(
  {
    // Appendix D.1: by tags, in two steps where a connection was measured not to keep them.
    form: { key: "reply.form", takes: { type: "oneOf", values: FORMS }, default: "tags", perConnection: false, at: "form" },
    forms: { key: "reply.forms.<connection>", takes: { type: "oneOf", values: FORMS }, default: null, orNone: true, none: "as reply.form says", perConnection: true, at: "forms.<connection>" },
    streamAnyway: { key: "reply.streamAnyway", takes: { type: "texts" }, default: [], perConnection: false, at: "streamAnyway" },
    // Appendix D.1: a reply is held back by one sentence while a rule that interrupts covers it, and an
    // agent that goes on after a rule stopped it is shown its last three sentences again.
    heldSentences: { key: "reply.heldSentences", takes: { type: "whole", least: 0 }, default: 1, perConnection: false, at: "heldSentences" },
    tailSentences: { key: "reply.tailSentences", takes: { type: "whole", least: 1 }, default: 3, perConnection: false, at: "tailSentences" },
    // Appendix D.1: the lead's sampling is its own.
    leadSampling: { key: "reply.leadSampling", takes: { type: "oneOf", values: ["own", "preset"] }, default: "own", perConnection: false, at: "leadSampling" },
    // Appendix D.1: progress lines in the thinking block.
    show: { key: "progress.show", takes: { type: "oneOf", values: ["all", "least"] }, default: "all", perConnection: false, at: "progress" },
    // Appendix D.1: a line when nothing has been shown for a minute. §10.7: a generation that sends no
    // text for ten minutes is ended, so a line must come inside them; nine minutes at most leaves the
    // last line a minute to arrive.
    silence: { key: "progress.silence", takes: { type: "whole", least: 1, most: 540 }, default: 60, perConnection: false, at: "silenceMs", ms: true },
  },
  REPLY_WORDS,
);
