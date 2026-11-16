// JSON as the contract carries it: values that come through `JSON.stringify` and `JSON.parse`
// unchanged, so a host can keep them anywhere and give them back as they were.

/** A value JSON can hold. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** A plain object (not null, not an array): its fields are still to be checked. The one such check of RPH and its folder host. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON Schema (draft 2020-12) as a plain object. A tool's parameters are an object schema:
 * `{ "type": "object", "properties": { … }, "required": [ … ] }`. RPH checks a call's arguments
 * against it before the tool runs, whether the tool was in the agent's fixed list or found by
 * `tool_search` (§6.8).
 */
export type JsonSchema = JsonObject;
