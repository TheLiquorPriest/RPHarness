// `lore_read` and `lore_search` over the folder host's seeded lore: entries in full by id, marked
// with who may know them for the lead; a character's agent given only what its character may know;
// an id the lore does not have said rather than thrown.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentRef } from "../../../src/contract";
import { KIT_SEED } from "../../../src/testing/kit";
import { type Bench, bench, textOf } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(() => b.close());

const entry = (id: string) => KIT_SEED.lore.find((e) => e.id === id)!;
const LIGHTHOUSE = entry("e-101");
const BELL = entry("w-7");

/** A character's agent: Tamsin, who is not among those the bell's entry is known to. */
const TAMSIN: AgentRef = { id: "tamsin", definition: "character", parent: "lead", plays: "Tamsin" };

describe("lore_read", () => {
  test("gives each entry asked for in full, in the order asked, with its title, source and keys", async () => {
    const result = await b.call("lore_read", { ids: ["w-7", "e-101"] });
    const answer = textOf(result);

    expect(result.error).toBeUndefined();
    expect(answer).toContain(BELL.text);
    expect(answer).toContain(LIGHTHOUSE.text);
    expect(answer.indexOf(BELL.text)).toBeLessThan(answer.indexOf(LIGHTHOUSE.text));
    expect(answer).toContain(`[e-101] ${LIGHTHOUSE.title} (${LIGHTHOUSE.source})`);
    for (const key of LIGHTHOUSE.keys) expect(answer).toContain(key);
  });

  test("the lead sees an entry known only to some characters, marked with who they are", async () => {
    const answer = textOf(await b.call("lore_read", { ids: ["w-7"] }));

    expect(answer).toContain(BELL.text);
    expect(answer).toContain("Wren Alder");
  });

  test("a character's agent is not given an entry its character may not know, and is told there is no such entry", async () => {
    const result = await b.call("lore_read", { ids: ["e-101", "w-7"] }, { agent: TAMSIN });
    const answer = textOf(result);

    expect(answer).toContain(LIGHTHOUSE.text);
    expect(answer).not.toContain(BELL.text);
    expect(answer).toContain("w-7");
  });

  test("an id the lore does not have is said, not thrown", async () => {
    const result = await b.call("lore_read", { ids: ["e-999"] });

    expect(result.error).toBe(true);
    expect(textOf(result)).toContain("e-999");
  });
});

describe("lore_search", () => {
  test("finds the entries that hold the words, with their ids and titles", async () => {
    const answer = textOf(await b.call("lore_search", { query: "drowned bell" }));

    expect(answer).toContain(`[w-7] ${BELL.title}`);
    expect(answer).toContain("[e-102]");
    expect(answer).not.toContain("[e-101]");
  });

  test("searches only the sources named", async () => {
    const answer = textOf(await b.call("lore_search", { query: "drowned bell", sources: ["Kit World"] }));

    expect(answer).toContain("[w-7]");
    expect(answer).not.toContain("[e-102]");
  });

  test("a character's agent finds nothing its character may not know", async () => {
    const answer = textOf(await b.call("lore_search", { query: "bronze bell" }, { agent: TAMSIN }));

    expect(answer).not.toContain("[w-7]");
  });
});
