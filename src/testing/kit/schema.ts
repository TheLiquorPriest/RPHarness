// A check that a tool's parameters are a JSON Schema a model can be given: JSON throughout, an
// object schema at the top, and every keyword the kit knows holding the kind of value JSON Schema
// (draft 2020-12) gives it. Keywords it does not know are allowed, as JSON Schema allows them.

const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_ONE = ["not", "if", "then", "else", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties"];
const SCHEMA_OR_BOOLEAN = ["items", "additionalProperties", "additionalItems"];
const NUMBERS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
const COUNTS = ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"];
const TEXTS = ["title", "description", "$ref", "$id", "$schema", "$comment", "pattern", "format"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a value is not JSON (undefined, a function, a number that is not finite, or another kind of thing), each pushed to `out`. */
export function notJson(value: unknown, at: string, out: string[]): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${at} is a number JSON cannot hold`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => notJson(v, `${at}[${i}]`, out));
    return;
  }
  if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) notJson(v, `${at}.${k}`, out);
    return;
  }
  out.push(`${at} is not JSON`);
}

function schema(value: unknown, at: string, out: string[]): void {
  if (typeof value === "boolean") return;
  if (!isObject(value)) {
    out.push(`${at} is not a schema`);
    return;
  }
  const type = value.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0 || !types.every((t) => typeof t === "string" && TYPES.includes(t))) out.push(`${at}.type is not a JSON Schema type`);
  }
  for (const k of SCHEMA_LISTS) {
    const v = value[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0) out.push(`${at}.${k} is not a list of schemas`);
    else v.forEach((s, i) => schema(s, `${at}.${k}[${i}]`, out));
  }
  for (const k of SCHEMA_MAPS) {
    const v = value[k];
    if (v === undefined) continue;
    if (!isObject(v)) out.push(`${at}.${k} is not an object of schemas`);
    else for (const [name, s] of Object.entries(v)) schema(s, `${at}.${k}.${name}`, out);
  }
  for (const k of [...SCHEMA_ONE, ...SCHEMA_OR_BOOLEAN]) if (value[k] !== undefined) schema(value[k], `${at}.${k}`, out);
  for (const k of NUMBERS) if (value[k] !== undefined && typeof value[k] !== "number") out.push(`${at}.${k} is not a number`);
  for (const k of COUNTS) {
    const v = value[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) out.push(`${at}.${k} is not a count`);
  }
  for (const k of TEXTS) if (value[k] !== undefined && typeof value[k] !== "string") out.push(`${at}.${k} is not text`);
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) out.push(`${at}.enum is not a list of values`);
  const required = value.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string") || new Set(required).size !== required.length) out.push(`${at}.required is not a list of distinct names`);
    else if (isObject(value.properties)) {
      const props = value.properties;
      for (const r of required as string[]) if (!Object.hasOwn(props, r)) out.push(`${at}.required names ${JSON.stringify(r)}, which is not among its properties`);
    }
  }
}

/** What is wrong with a tool's parameters as a JSON Schema; none when nothing is. */
export function schemaProblems(parameters: unknown): string[] {
  const out: string[] = [];
  notJson(parameters, "parameters", out);
  if (!isObject(parameters)) return [...out, "parameters is not an object schema"];
  if (parameters.type !== "object") out.push(`parameters.type is ${JSON.stringify(parameters.type)}, not "object"`);
  schema(parameters, "parameters", out);
  return out;
}
