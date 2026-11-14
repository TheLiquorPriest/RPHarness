// The kit's check of a tool's parameters: what a host author sees when a tool's schema would not
// reach a model whole.

import { describe, expect, test } from "bun:test";
import { schemaProblems } from "../../src/testing/kit/index";

describe("a tool's parameters as a JSON Schema", () => {
  test("an object schema with nested parts passes", () => {
    expect(
      schemaProblems({
        type: "object",
        description: "Where to move.",
        properties: {
          to: { type: "string", enum: ["north", "south"] },
          steps: { type: "integer", minimum: 1, maxItems: 3 },
          path: { type: "array", items: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
          note: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["to"],
        additionalProperties: false,
      }),
    ).toEqual([]);
    expect(schemaProblems({ type: "object" })).toEqual([]);
  });

  test("a schema that is not an object at the top, or not JSON, is caught", () => {
    expect(schemaProblems({ type: "string" })).toEqual(['parameters.type is "string", not "object"']);
    expect(schemaProblems([])).toContain("parameters is not an object schema");
    expect(schemaProblems({ type: "object", properties: { n: { type: "number", default: Number.NaN } } })).toEqual(["parameters.properties.n.default is a number JSON cannot hold"]);
    expect(schemaProblems({ type: "object", properties: { f: { type: "string", default: () => "x" } } })).toEqual(["parameters.properties.f.default is not JSON"]);
  });

  test("keywords holding the wrong kind of value are caught, wherever they are", () => {
    expect(
      schemaProblems({
        type: "object",
        properties: {
          a: { type: "text" },
          b: { type: "array", items: "string" },
          c: { type: "string", minLength: -1 },
          d: { type: "string", enum: [] },
          e: { oneOf: [] },
        },
        required: ["a", "missing", "a"],
      }),
    ).toEqual([
      "parameters.properties.a.type is not a JSON Schema type",
      "parameters.properties.b.items is not a schema",
      "parameters.properties.c.minLength is not a count",
      "parameters.properties.d.enum is not a list of values",
      "parameters.properties.e.oneOf is not a list of schemas",
      "parameters.required is not a list of distinct names",
    ]);
    expect(schemaProblems({ type: "object", properties: { a: { type: "string" } }, required: ["b"] })).toEqual(['parameters.required names "b", which is not among its properties']);
  });
});
