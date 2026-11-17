// A thinking level a provider refuses (17 Nov, the lead's ask on effort `max`). A model pi-ai has no
// level map for is sent its levels up to `high` (pi-ai's `clampThinkingLevel`: `xhigh` and `max` only
// where a map names them), which every chat-completions provider that takes `reasoning_effort` takes.
// Where a provider still refuses the level a call asked for, the call is made again at once at the
// next level down its model has, `off` at the last, and the agent's run is told (call.ts).

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The levels, lowest first, as pi-ai orders them. */
const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * A provider's words refusing the thinking level or effort a call asked for: OpenAI's
 * ("Unsupported value: 'reasoning_effort' does not support 'minimal'"), OpenRouter's
 * (`reasoning.effort`), DeepSeek's and other compatible servers' (`reasoning_effort`), Anthropic's
 * (`thinking.budget_tokens`, `output_config.effort`), Gemini's (`thinkingLevel`, `thinking_budget`).
 */
const EFFORT_REFUSALS: readonly RegExp[] = [
  /\breasoning[_. ]?effort\b/i,
  /\bthinking[_. ]?(?:level|budget|config)\b/i,
  /\bthinking\.budget_tokens\b/i,
  /\boutput_config\.effort\b/i,
  /\beffort\b[^.\n]{0,60}\b(?:not supported|unsupported|invalid|must be|is not one of|not allowed|not a valid)\b/i,
  /\b(?:invalid|unsupported|unknown)\b[^.\n]{0,40}\b(?:effort|thinking level)\b/i,
];

/** Whether a failed call's words are its provider refusing the thinking level it was asked for. */
export function refusesEffort(words: string | undefined): boolean {
  return words !== undefined && EFFORT_REFUSALS.some((pattern) => pattern.test(words));
}

/** The next level below `level` that `model` has, `off` at the last. */
export function levelBelow(model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel {
  const has = getSupportedThinkingLevels(model);
  return LEVELS.slice(0, LEVELS.indexOf(level)).findLast((below) => has.includes(below)) ?? "off";
}
