// A call's arguments against what its tool takes, by pi's own check (`validateToolArguments`, the
// one pi's loop runs before any call of an agent's own list, coercion and all): the arguments as the
// tool takes them, or each argument that did not fit and why, as the check found them.
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "../contract";
import type { LoopTool } from "./types";

/** One argument that did not fit its tool: where (a dotted path; `root` for the arguments as a whole) and why, in the check's own short phrase. A plain shape, so it goes into a file's fields as it is. */
export type Misfit = { argument: string; why: string };

/** The arguments as the tool takes them, or what of them did not fit. */
export type Fit = { args: JsonValue } | { misfits: Misfit[] };

export function fit(tool: Pick<LoopTool, "name" | "description" | "parameters">, args: JsonValue, callId: string): Fit {
  try {
    // The check names a call whose arguments are not an object for what they are, as it does any other misfit.
    return { args: validateToolArguments(tool, { type: "toolCall", id: callId, name: tool.name, arguments: args as JsonObject }) as JsonValue };
  } catch (error) {
    return { misfits: misfitsIn(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * What did not fit, as the check's message lists it: one `  - <argument>: <why>` line each, before
 * the arguments it received. A message that lists none (arguments that did not parse) gives none.
 */
export function misfitsIn(message: string): Misfit[] {
  const lines = message.split("\n");
  const received = lines.indexOf("Received arguments:");
  return lines.slice(1, received < 0 ? undefined : received).flatMap((line) => {
    if (!line.startsWith("  - ")) return [];
    const at = line.indexOf(": ", 4);
    return at < 0 ? [] : [{ argument: line.slice(4, at), why: line.slice(at + 2) }];
  });
}
