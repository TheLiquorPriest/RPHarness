// Facts (§5.4): RPH's own and the host's in one registry, and the small expression a rule's `fact:`
// holds: a name, the groups to count, and a comparison with a number, true or false.

import { describe, expect, test } from "bun:test";
import type { FactsPort, FactValue } from "../../src/contract/index";
import { createFacts, OWN_FACTS } from "../../src/files/index";
import { holds, parseFactTest } from "../../src/files/facts";
import { author, scope } from "./support";

const STAGE: FactValue = { count: 3, by: { principal: 1, supporting: 0, extra: 2 } };

function check(text: string, value: FactValue): boolean {
  const test = parseFactTest(text);
  if ("error" in test) throw new Error(test.error);
  return holds(test, value);
}

describe("`fact:`", () => {
  test("compares the count, or the sum of the groups it picks, with a number", () => {
    expect(check("stage.unperceived > 0", STAGE)).toBe(true);
    expect(check("stage.unperceived(principal, supporting) > 0", STAGE)).toBe(true);
    expect(check("stage.unperceived(supporting) > 0", STAGE)).toBe(false);
    expect(check("stage.unperceived(extra)==2", STAGE)).toBe(true);
    expect(check("stage.unperceived <= 2", STAGE)).toBe(false);
    expect(check("stage.unperceived != 3", STAGE)).toBe(false);
    expect(check("stage.unperceived(nobody) < 1", STAGE)).toBe(true);
  });

  test("takes true and false as a count that is or is not 0, and a name alone as one that is not", () => {
    expect(check("reply.released == false", { count: 0 })).toBe(true);
    expect(check("reply.released == false", { count: 1 })).toBe(false);
    expect(check("reply.released != false", { count: 1 })).toBe(true);
    expect(check("todo.open", { count: 2 })).toBe(true);
    expect(check("todo.open", { count: 0 })).toBe(false);
  });

  test("says what is wrong with one it cannot read", () => {
    for (const text of ["stage.unperceived >", "stage.unperceived() > 0", "stage.unperceived > lots", "reply.released > false", "> 0"]) {
      expect(parseFactTest(text)).toEqual({ error: expect.stringContaining("") });
    }
    expect(parseFactTest("reply.released > false")).toEqual({ error: "`reply.released > false` compares with false by >; true and false take == or != only." });
  });
});

describe("the registry", () => {
  const host: FactsPort = {
    defs: () => [
      { name: "stage.unperceived", counts: "On stage with no perception.", by: ["principal", "supporting", "extra"] },
      { name: "todo.open", counts: "A host's fact of an own fact's name." },
    ],
    read: async (_scope, names) => Object.fromEntries((names ?? []).map((n) => [n, { count: n === "stage.unperceived" ? 3 : 99 }])),
  };

  test("lists RPH's own facts first, then the host's, and an own fact's name is RPH's", () => {
    const facts = createFacts(host, () => ({}));
    expect(facts.defs().map((d) => d.name)).toEqual([...OWN_FACTS.map((d) => d.name), "stage.unperceived"]);
  });

  test("reads each from its own source, and gives none for a fact with no value or no name", async () => {
    const asked: string[][] = [];
    const facts = createFacts({ ...host, read: async (s, names) => (asked.push(names ?? []), host.read(s, names)) }, (_scope, agent) => (agent.definition === "author" ? { "todo.open": { count: 2 } } : {}));
    expect(await facts.read(scope, author, ["todo.open", "reply.released", "stage.unperceived", "no.such"])).toEqual({ "todo.open": { count: 2 }, "stage.unperceived": { count: 3 } });
    expect(asked).toEqual([["stage.unperceived"]]);
  });
});
