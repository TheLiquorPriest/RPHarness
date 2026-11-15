// A call's arguments against what its tool takes, by pi's own check (`validateToolArguments`, the
// one pi's loop runs before any call of an agent's own list, coercion and all): the arguments as the
// tool takes them, or each argument that did not fit, and whether it was sent at all; or, where the
// model's arguments were not a JSON object, the text it sent. The check's own words for why are
// pi's, and reach no model.
//
// What did not fit is read from the check's message, in the form pi-ai 1.5.2 writes it (§13.7: pi is
// pinned exactly, and an upgrade is a task gated by the suite): `test/loop/fit.test.ts` runs pi's own
// check and fails the day that form changes.
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "../contract";
import type { LoopTool } from "./types";

/** One argument that did not fit its tool: where (a dotted path), and whether the call left it out. A plain shape, so it goes into a file's fields as it is. */
export type Misfit = { argument: string; missing: boolean };

/**
 * The arguments as the tool takes them, or what of them did not fit. `unparsed`: the model's
 * arguments were not a JSON object, and this is the text it sent; nothing of it could be checked, so
 * it names no misfit.
 */
export type Fit = { args: JsonValue } | { misfits: Misfit[]; unparsed?: string };

/** What comes before the arguments as sent, in both of the check's messages. */
const RECEIVED = "\n\nReceived arguments:\n";

/**
 * pi's check of `args` for `tool`, as pi's loop ran it: `argumentsError` is what pi-ai keeps beside
 * a call whose arguments were not a JSON object (`ToolCall.argumentsError`), which fails the check.
 */
export function fit(tool: Pick<LoopTool, "name" | "description" | "parameters">, args: JsonValue, callId: string, argumentsError?: string): Fit {
  try {
    // The check names a call whose arguments are not an object for what they are, as it does any other misfit.
    return { args: validateToolArguments(tool, { type: "toolCall", id: callId, name: tool.name, arguments: args as JsonObject, ...(argumentsError !== undefined ? { argumentsError } : {}) }) as JsonValue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unparsed = unparsedIn(message, tool.name);
    return unparsed !== undefined ? { misfits: [], unparsed } : { misfits: misfitsIn(message, tool.name, args) };
  }
}

/**
 * The text the model sent, from pi-ai 1.5.2's message for arguments that were not a JSON object:
 * `Invalid arguments for tool "<tool>": <why>`, then the text as received. Undefined for a message
 * of any other form.
 */
function unparsedIn(message: string, tool: string): string | undefined {
  if (!message.startsWith(`Invalid arguments for tool "${tool}": `)) return undefined;
  const at = message.indexOf(RECEIVED);
  return at < 0 ? "" : message.slice(at + RECEIVED.length);
}

/**
 * What did not fit, from pi-ai 1.5.2's message for arguments that do not fit: `Validation failed for
 * tool "<tool>":`, one `  - <argument>: <why>` line each, then the arguments as received. Each
 * argument once, with whether `args` holds it. The arguments as a whole (`root`) are the line's own
 * to say. A message of any other form gives none.
 */
function misfitsIn(message: string, tool: string, args: JsonValue): Misfit[] {
  const lines = message.split("\n");
  if (lines[0] !== `Validation failed for tool "${tool}":`) return [];
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
