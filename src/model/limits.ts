// A model's figures (STANDALONE-PLAN P19, §13.3; §4.2 l.252): how many tokens it reads in one call
// (its context window), the longest reply it writes in one, and whether it takes pictures. pi's
// catalogue lists all three for every model it knows, and those are the defaults. Each one is
// resolved on its own, from the first of these that gives it:
//
// 1. what the user entered for the model on its connection: an entry governs wherever it is set;
// 2. pi's catalogue, for a model it lists (a number above 0: pi-ai writes 0 for "not known");
// 3. what the connection's server reported when it listed its models;
// 4. nobody: the figure is unknown, listed as asked for so the Connections page asks for it, and
//    whoever needs it must handle that. The layer never puts a figure of its own in its place: a
//    model nobody has said takes pictures is not known to (C26).

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelFigure, ModelLimit, ModelLimits, ModelLimitsEntry, ModelPictures } from "../contract";
import { isRecord, isTokenCount } from "./json";

function firstOf(entered: number | undefined, listed: number | undefined, reported: number | undefined): ModelLimit | null {
  if (isTokenCount(entered)) return { tokens: entered, from: "user" };
  if (isTokenCount(listed)) return { tokens: listed, from: "pi" };
  if (isTokenCount(reported)) return { tokens: reported, from: "connection" };
  return null;
}

/**
 * A model's figures (see the head of this file): `listed`, pi's catalogue entry for it, if pi lists
 * it; `reported`, what its connection's server said; `entered`, what the user entered.
 */
export function limitsOf(listed: Pick<Model<Api>, "contextWindow" | "maxTokens" | "input"> | undefined, reported: ModelLimitsEntry | undefined, entered: ModelLimitsEntry | undefined): ModelLimits {
  const contextWindow = firstOf(entered?.contextWindow, listed?.contextWindow, reported?.contextWindow);
  const maxTokens = firstOf(entered?.maxTokens, listed?.maxTokens, reported?.maxTokens);
  const pictures: ModelPictures | null =
    entered?.pictures !== undefined ? { takes: entered.pictures, from: "user" } : listed !== undefined ? { takes: listed.input.includes("image"), from: "pi" } : reported?.pictures !== undefined ? { takes: reported.pictures, from: "connection" } : null;
  const asked: ModelFigure[] = [...(contextWindow === null ? ["contextWindow" as const] : []), ...(maxTokens === null ? ["maxTokens" as const] : []), ...(pictures === null ? ["pictures" as const] : [])];
  return { contextWindow, maxTokens, pictures, asked };
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

/** What one model's entry in a server's list of models says of its figures; empty where it says nothing. Whether it takes pictures, from OpenRouter's list of what it takes in (`architecture.input_modalities`). */
export function reportedOf(entry: Record<string, unknown>): ModelLimitsEntry {
  const top = isRecord(entry.top_provider) ? entry.top_provider : {};
  const contextWindow = countIn(entry, WINDOW_FIELDS) ?? countIn(top, ["context_length"]);
  const maxTokens = countIn(entry, REPLY_FIELDS) ?? countIn(top, REPLY_FIELDS);
  const takesIn = isRecord(entry.architecture) ? entry.architecture.input_modalities : undefined;
  const pictures = Array.isArray(takesIn) ? takesIn.includes("image") : undefined;
  return { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}), ...(pictures !== undefined ? { pictures } : {}) };
}
