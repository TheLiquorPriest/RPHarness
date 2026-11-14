// What every one of RPH's own tools is made from: its description and its arguments' descriptions,
// read from its file in `.tools/` (§5.4, §6.8: a tool's description is an editable file and says
// only what the tool does and what it takes), and its answers, each a line of a file. A tool never
// says anything in words of its own: an answer whose line the file does not have is given empty.
import type { JsonObject, JsonSchema, JsonValue, ToolTier } from "../contract";
import type { Fields } from "../files/api";
import type { Misfit } from "../loop/fit";
import type { LoopTool, LoopToolResult } from "../loop/types";

/** One of RPH's own tools as an agent holds it: a tool for the runner, with what the user's permissions are judged by. */
export interface OwnTool extends LoopTool {
  family: string;
  tier: ToolTier;
  lane?: string;
}

/** A tool's file: its description for the model, and each argument's, by name. */
export interface ToolText {
  description: string;
  arguments: Readonly<Record<string, string>>;
}

/** A line of the tool answers' file, filled in; undefined when the file has no line of that name. */
export type Words = (name: string, fields?: Fields) => string | undefined;

/** An answer from a line of the file: its text, or nothing when the file has no such line. `error`: the call did not do what was asked. */
export function answer(text: string | undefined, error = false): LoopToolResult {
  return { content: text === undefined ? [] : [{ type: "text", text }], ...(error ? { error: true as const } : {}) };
}

/** An object schema for a tool's arguments, each property carrying the description its file gives, where it gives one. */
export function argumentsOf(properties: Readonly<Record<string, JsonObject>>, required: readonly string[], text: ToolText | undefined): JsonSchema {
  const described: Record<string, JsonValue> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const description = text?.arguments[name];
    described[name] = description === undefined ? schema : { ...schema, description };
  }
  return { type: "object", properties: described, ...(required.length > 0 ? { required: [...required] } : {}) };
}

/** The arguments a model sent, as an object; anything else is no arguments. */
export function fieldsOf(args: JsonValue): Readonly<Record<string, JsonValue>> {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
}

/** A text argument, when the model sent one. */
export function text(args: Readonly<Record<string, JsonValue>>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

/** A whole-number argument, when the model sent one. */
export function whole(args: Readonly<Record<string, JsonValue>>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** A call that does not fit its tool, as the tool answers' `invalid` line is given it. */
export interface InvalidCall {
  tool: string;
  /** What was sent, as JSON. */
  arguments: string;
  /** The tool's whole schema, as JSON. */
  parameters: string;
  misfits: readonly Misfit[];
}

/**
 * The fields of the tool answers' `invalid` line: the tool, what was sent, each argument that did
 * not fit and why as the check found them (`misfits`, each an `argument` and a `why`), and the
 * tool's whole schema (`parameters`) only where it is no longer than the user's `tools.schemaShown`.
 */
export function invalidFields(call: InvalidCall, schemaShown: number): Fields {
  return {
    tool: call.tool,
    arguments: call.arguments,
    ...(call.misfits.length > 0 ? { misfits: call.misfits.map(({ argument, why }) => ({ argument, why })) } : {}),
    ...(call.parameters.length <= schemaShown ? { parameters: call.parameters } : {}),
  };
}
