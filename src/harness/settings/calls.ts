// The settings that hold each model call (§10.2 l.1165, §10.11, Appendix D.1 l.2419, l.2421): the
// least room an answer is given, under which no call is made (`limits.answerFloor`); the characters
// per token every estimate before a provider counts is made at (`tokens.charsPerToken`); and an
// agent definition's own sampling (`sampling.<definition>`), on every call of that agent, none set
// by default, so each provider's own defaults hold. The Author's own sampling is its definition's;
// a preset's goes only where the reply's settings say.

import { CALLS_WORDS } from "./calls-words";
import { DEFINITION, worded } from "./entry";

/** Where a definition's own sampling is set: each parameter a number its provider takes or leaves out (§10.2: "as each provider takes them"). */
const SAMPLED = `sampling.${DEFINITION}` as const;

/** What an unset sampling parameter means, on the Settings page. */
const PROVIDERS_OWN = "the provider's own";

export const CALLS = worded(
  {
    // Today's answer floor (LumiAH settings.ts:124-125,386): a call with less room left than this is not made.
    answerFloor: { key: "limits.answerFloor", takes: { type: "whole", least: 1 }, default: 256, perConnection: false, at: "answerFloor" },
    // Today's `loop.charsPerToken`.
    charsPerToken: { key: "tokens.charsPerToken", takes: { type: "number", least: 0.5 }, default: 3.2, perConnection: false, at: "tokens.charsPerToken" },
    // Each unset by default: the provider's own. `~` lifts in a chat what the global file sets.
    temperature: { key: `${SAMPLED}.temperature`, takes: { type: "number", least: 0, most: 2 }, default: null, orNone: true, none: PROVIDERS_OWN, perConnection: false, at: `${SAMPLED}.temperature` },
    topP: { key: `${SAMPLED}.top_p`, takes: { type: "number", least: 0, most: 1 }, default: null, orNone: true, none: PROVIDERS_OWN, perConnection: false, at: `${SAMPLED}.top_p` },
    topK: { key: `${SAMPLED}.top_k`, takes: { type: "whole", least: 0 }, default: null, orNone: true, none: PROVIDERS_OWN, perConnection: false, at: `${SAMPLED}.top_k` },
    frequencyPenalty: { key: `${SAMPLED}.frequency_penalty`, takes: { type: "number", least: -2, most: 2 }, default: null, orNone: true, none: PROVIDERS_OWN, perConnection: false, at: `${SAMPLED}.frequency_penalty` },
    presencePenalty: { key: `${SAMPLED}.presence_penalty`, takes: { type: "number", least: -2, most: 2 }, default: null, orNone: true, none: PROVIDERS_OWN, perConnection: false, at: `${SAMPLED}.presence_penalty` },
    repetitionPenalty: { key: `${SAMPLED}.repetition_penalty`, takes: { type: "number", least: 0 }, default: null, orNone: true, none: PROVIDERS_OWN, perConnection: false, at: `${SAMPLED}.repetition_penalty` },
  },
  CALLS_WORDS,
);
