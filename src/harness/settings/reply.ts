// The settings of the reply (§10.6, §10.7, Appendix D.1), under `reply` in a config file, and of the
// progress lines in the chat's thinking block, under `progress`. Times are in seconds.

import { REPLY_DEFAULTS } from "../../reply/defaults";
import { worded } from "./entry";
import { REPLY_WORDS } from "./reply-words";

const FORMS = ["tags", "two-step"] as const;

export const REPLY = worded(
  {
    // Appendix D.1: by tags, in two steps where a connection was measured not to keep them.
    form: { key: "reply.form", takes: { type: "oneOf", values: FORMS }, default: "tags", perConnection: false },
    forms: { key: "reply.forms.<connection>", takes: { type: "oneOf", values: FORMS }, default: null, none: "as reply.form says", perConnection: true },
    streamAnyway: { key: "reply.streamAnyway", takes: { type: "texts" }, default: [], perConnection: false },
    heldSentences: { key: "reply.heldSentences", takes: { type: "whole", least: 0 }, default: REPLY_DEFAULTS.heldSentences, perConnection: false },
    tailSentences: { key: "reply.tailSentences", takes: { type: "whole", least: 1 }, default: REPLY_DEFAULTS.tailSentences, perConnection: false },
    // Appendix D.1: the lead's sampling is its own.
    leadSampling: { key: "reply.leadSampling", takes: { type: "oneOf", values: ["own", "preset"] }, default: "own", perConnection: false },
    // The host takes an intent record in the same process: this is room for a slow disk, and short
    // enough that a host that stalls costs a reply no more than a moment.
    intentWait: { key: "reply.intentWait", takes: { type: "whole", least: 0 }, default: 2, perConnection: false },
    // Appendix D.1: progress lines in the thinking block.
    show: { key: "progress.show", takes: { type: "oneOf", values: ["all", "least"] }, default: "all", perConnection: false },
    // §10.7: a generation that sends no text for ten minutes is ended, so a line must come inside them;
    // nine minutes at most leaves the last line a minute to arrive.
    silence: { key: "progress.silence", takes: { type: "whole", least: 1, most: 540 }, default: REPLY_DEFAULTS.silenceMs / 1000, perConnection: false },
  },
  REPLY_WORDS,
);
