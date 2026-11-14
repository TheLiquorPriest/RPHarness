// What a tool takes, in one line (§6.8): its arguments' schema written the way a type is written,
// `{region: string, minutes?: number, state: "fog"|"rain"}`. Read from the schema alone, so it says
// what the schema says and nothing more: names, types, which are needed, the values allowed. An
// argument's own description stays in the schema, which the answer to a call that does not fit gives
// whole.
import type { JsonObject, JsonValue } from "../../contract";

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A property's name as written: bare when it is one word, else quoted. */
function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function objectOf(schema: JsonObject): string {
  const properties = schema.properties;
  if (!isObject(properties)) return "object";
  const needed = new Set(Array.isArray(schema.required) ? schema.required : []);
  return `{${Object.entries(properties)
    .map(([name, inner]) => `${key(name)}${needed.has(name) ? "" : "?"}: ${typeOf(inner)}`)
    .join(", ")}}`;
}

function arrayOf(schema: JsonObject): string {
  const item = typeOf(schema.items);
  return item.includes("|") ? `(${item})[]` : `${item}[]`;
}

function typeOf(schema: JsonValue | undefined): string {
  if (!isObject(schema)) return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join("|");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union !== undefined) return union.map(typeOf).join("|");
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === "string") : [];
  if (types.length === 0) {
    if (isObject(schema.properties)) return objectOf(schema);
    if (schema.items !== undefined) return arrayOf(schema);
    return "any";
  }
  return types.map((type) => (type === "object" ? objectOf(schema) : type === "array" ? arrayOf(schema) : type)).join("|");
}

/** What a tool takes, from its parameters' schema. */
export function takes(parameters: JsonValue): string {
  return typeOf(parameters);
}
