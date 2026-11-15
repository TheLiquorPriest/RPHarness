// The settings of the prompt map (§4.8 "What makes a marker evergreen"), under `prompt` in a config file: how the map finds a slice again in a later prompt.

import { worded } from "./entry";
import { PROMPT_WORDS } from "./prompt-words";

export const PROMPT = worded(
  {
    // The start of a slice's text its signature keeps, to find the text again: 64 characters, the size the first build fixed in code. Each signature keeps its own start, so a map learned under another value is still found.
    signatureHead: { key: "prompt.signatureHead", takes: { type: "whole", least: 1 }, default: 64, perConnection: false, at: "signatureHead" },
  },
  PROMPT_WORDS,
);
