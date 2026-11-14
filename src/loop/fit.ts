// A call's arguments against what its tool takes, by pi's own check (`validateToolArguments`, the
// one pi's loop runs before any call of an agent's own list, coercion and all): the arguments as the
// tool takes them, or each argument that did not fit, and whether it was sent at all. The check's own
// words for why are pi's, and reach no model.
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "../contract";
import type { LoopTool } from "./types";

/** One argument that did not fit its tool: where (a dotted path), and whether the call left it out. A plain shape, so it goes into a file's fields as it is. */
export type Misfit = { argument: string; missing: boolean };

/** The arguments as the tool takes them, or what of them did not fit. */
export type Fit = { args: JsonValue } | { misfits: Misfit[] };

export function fit(tool: Pick<LoopTool, "name" | "description" | "parameters">, args: JsonValue, callId: string): Fit {
  try {
    // The check names a call whose arguments are not an object for what they are, as it does any other misfit.
    return { args: validateToolArguments(tool, { type: "toolCall", id: callId, name: tool.name, arguments: args as JsonObject }) as JsonValue };
  } catch (error) {
    return { misfits: misfitsIn(error instanceof Error ? error.message : String(error), args) };
  }
}

/**
 * What did not fit, as the check's message lists it (one `  - <argument>: <why>` line each, before
 * the arguments it received), each argument once, with whether `args` holds it. The arguments as a
 * whole (`root`) are the line's own to say. A message that lists none gives none.
 */
export function misfitsIn(message: string, args: JsonValue): Misfit[] {
  const lines = message.split("\n");
  const received = lines.indexOf("Received arguments:");
  const seen = new Set<string>();
  return lines.slice(1, received < 0 ? undefined : received).flatMap((line) => {
    const at = line.indexOf(": ", 4);
    const argument = line.startsWith("  - ") && at >= 0 ? line.slice(4, at) : "";
    if (argument === "" || argument === "root" || seen.has(argument)) return [];
    seen.add(argument);
    let value: JsonValue | undefined = args;
    for (const step of argument.split(".")) value = typeof value === "object" && value !== null && Object.hasOwn(value, step) ? (value as Record<string, JsonValue>)[step] : undefined;
    return [{ argument, missing: value === undefined || value === null }];
  });
}
