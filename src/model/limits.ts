// A model's limits (STANDALONE-PLAN P19, §13.3): how many tokens it reads in one call (its context
// window) and the longest reply it writes in one. pi's catalogue lists both for every model it
// knows, and those are the defaults. Each one is resolved on its own, from the first of these that
// gives it:
//
// 1. what the user entered for the model on its connection: an entry governs wherever it is set;
// 2. pi's catalogue, for a model it lists (a number above 0: pi-ai writes 0 for "not known");
// 3. what the connection's server reported when it listed its models;
// 4. nobody: the limit is unknown, and whoever needs it must handle that. The layer never puts a
//    number of its own in its place.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelLimit, ModelLimits, ModelLimitsEntry } from "../contract";
import { isRecord, isTokenCount } from "./json";

function firstOf(entered: number | undefined, listed: number | undefined, reported: number | undefined): ModelLimit | null {
  if (isTokenCount(entered)) return { tokens: entered, from: "user" };
  if (isTokenCount(listed)) return { tokens: listed, from: "pi" };
  if (isTokenCount(reported)) return { tokens: reported, from: "connection" };
  return null;
}

/**
 * A model's limits (see the head of this file): `listed`, pi's catalogue entry for it, if pi lists
 * it; `reported`, what its connection's server said; `entered`, what the user entered.
 */
export function limitsOf(listed: Pick<Model<Api>, "contextWindow" | "maxTokens"> | undefined, reported: ModelLimitsEntry | undefined, entered: ModelLimitsEntry | undefined): ModelLimits {
  return {
    contextWindow: firstOf(entered?.contextWindow, listed?.contextWindow, reported?.contextWindow),
    maxTokens: firstOf(entered?.maxTokens, listed?.maxTokens, reported?.maxTokens),
  };
}

/** The first of a model entry's fields that holds a number of tokens. */
function countIn(entry: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = entry[field];
    if (isTokenCount(value)) return value;
  }
  return undefined;
}

/** The fields a server's list of models gives a model's context window in: OpenRouter's and Together's, Groq's, vLLM's, Mistral's. */
const WINDOW_FIELDS = ["context_length", "context_window", "max_model_len", "max_context_length"];
/** The fields it gives the longest reply in: Groq's; OpenRouter gives it under `top_provider`. */
const REPLY_FIELDS = ["max_completion_tokens", "max_output_tokens"];

/** What one model's entry in a server's list of models says of its limits; empty where it says nothing. */
export function reportedOf(entry: Record<string, unknown>): ModelLimitsEntry {
  const top = isRecord(entry.top_provider) ? entry.top_provider : {};
  const contextWindow = countIn(entry, WINDOW_FIELDS) ?? countIn(top, ["context_length"]);
  const maxTokens = countIn(entry, REPLY_FIELDS) ?? countIn(top, REPLY_FIELDS);
  return { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) };
}
