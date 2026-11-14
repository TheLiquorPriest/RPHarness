// The kit's check of fact values: what a host author sees when a fact read would mislead a rule.

import { describe, expect, test } from "bun:test";
import type { FactDef } from "../../src/contract/index";
import { factProblems } from "../../src/testing/kit/index";

const defs: FactDef[] = [
  { name: "stage.unperceived", counts: "Characters on stage with no perception recorded.", by: ["principal", "supporting"] },
  { name: "history.leaving.uncovered", counts: "Messages about to leave the prompt uncovered.", fields: ["range"] },
];

describe("fact values against the facts a host declares", () => {
  test("values as declared pass", () => {
    expect(
      factProblems(defs, {
        "stage.unperceived": { count: 2, names: ["Wren Alder", "Tamsin"], by: { principal: 1, supporting: 1 }, namesBy: { principal: ["Wren Alder"], supporting: ["Tamsin"] } },
        "history.leaving.uncovered": { count: 3, fields: { range: { from: 12, to: 15 } } },
      }),
    ).toEqual([]);
  });

  test("a fact, a group or a field the host never declared is caught", () => {
    expect(
      factProblems(defs, {
        "kit.unknown": { count: 1 },
        "stage.unperceived": { count: 1, names: ["Wren Alder"], by: { extra: 1 }, namesBy: { extra: ["Wren Alder"] } },
        "history.leaving.uncovered": { count: 1, fields: { from: 12 } },
      }),
    ).toEqual([
      "kit.unknown is read but not declared",
      "stage.unperceived.by.extra is not a group its definition declares",
      "stage.unperceived.namesBy.extra is not a group its definition declares",
      "history.leaving.uncovered.fields.from is not a field its definition declares",
    ]);
  });

  test("a group's name that is not among the fact's names, a count that is not one, and a field that is not JSON are caught", () => {
    expect(
      factProblems(defs, {
        "stage.unperceived": { count: -1, names: ["Tamsin"], namesBy: { principal: ["Wren Alder"] } },
        "history.leaving.uncovered": { count: 0, fields: { range: Number.POSITIVE_INFINITY } },
      }),
    ).toEqual([
      "stage.unperceived.count is not a count",
      'stage.unperceived.namesBy.principal names "Wren Alder", which is not among its names',
      "history.leaving.uncovered.fields.range is a number JSON cannot hold",
    ]);
  });
});
