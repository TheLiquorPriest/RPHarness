// `tool_search` (§6.8): every tool an agent may reach beyond its fixed list, found by words in its
// name, its family and its description, each given with a line on what it does and what it takes,
// in a plain, stable order.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JsonValue } from "../../../src/contract";
import type { LoopToolResult } from "../../../src/loop/types";
import { TOOL_SEARCH, TOOL_USE, toolSearch } from "../../../src/tools/search";
import { type Bench, bench, ctxOf, fixtureTools, standIn, textOf } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(async () => {
  await b.close();
});

const FIXED = [TOOL_SEARCH, TOOL_USE, "world_query"];

async function search(args: JsonValue, fixed: readonly string[] = FIXED): Promise<LoopToolResult> {
  return toolSearch(b.deps(standIn(fixtureTools([]), { fixed }))).run(args, ctxOf());
}

function found(result: LoopToolResult): JsonValue {
  const details = result.details;
  return typeof details === "object" && details !== null && !Array.isArray(details) ? (details["found"] ?? null) : null;
}

async function lines() {
  const part = await b.guidance.part("tool-search");
  if (part?.format !== "lines") throw new Error("The shipped tool-search.md is a lines part.");
  return part;
}

describe("tool_search", () => {
  test("a tool is found by a word of its name, of its description, or its family, and the answer says what it does and what it takes", async () => {
    const byName = await search({ words: "weather" });
    expect(found(byName)).toEqual(["weather_clear", "weather_set"]);
    const line = textOf(byName)
      .split("\n")
      .find((l) => l.startsWith("weather_set"));
    expect(line).toContain("(time)");
    expect(line).toContain("Sets the weather over a region for a while.");
    // A line on what it does: the description's second line is not given.
    expect(line).not.toContain("how the sky now stands");
    expect(line).toContain("{region: string, state: string, minutes?: number}");

    expect(found(await search({ words: "deposit" }))).toEqual(["open_account"]);
    expect(found(await search({ words: "money" }))).toEqual(["apply_credit", "open_account"]);
    expect(textOf(await search({ words: "line of sight" }))).toContain('{from: string, to: string, through?: "walls"|"doors", waypoints?: string[]}');
  });

  test("a tool of the fixed list is not found, nor are tool_search and tool_use themselves", async () => {
    expect(found(await search({ words: "world tree" }))).toEqual([]);
    expect(found(await search({ words: "world tree" }, [TOOL_SEARCH, TOOL_USE]))).toEqual(["world_query"]);
    const withSearch = [...fixtureTools([]), toolSearch(b.deps(standIn([])))];
    const own = await toolSearch(b.deps(standIn(withSearch, { fixed: [] }))).run({ words: "tool_search finds tools" }, ctxOf());
    expect(found(own)).not.toContain(TOOL_SEARCH);
  });

  test("ranking: a tool named exactly comes first, then name over family over description, a word many tools share counting for little; the same words give the same list", async () => {
    // map_measure scores higher on these words, but map_lay is named exactly.
    expect(found(await search({ words: "map_lay measure distance squares sight" }))).toEqual(["map_lay", "map_measure"]);
    expect(found(await search({ words: "measure distance squares sight" }))).toEqual(["map_measure", "map_lay"]);
    // "drive" is a part of one tool's name, "sum" a word of another's description.
    expect(found(await search({ words: "sum drive" }))).toEqual(["vehicles_drive", "apply_credit"]);
    // "a" starts a word of nearly every tool, so it finds them all and counts for little: the two named for the weather come first, and equal scores keep name order.
    expect(found(await search({ words: "a weather" }))).toEqual(["weather_clear", "weather_set", "apply_credit", "open_account", "map_lay", "map_measure", "vehicles_drive"]);
    const first = found(await search({ words: "map region sky account" }));
    expect(found(await search({ words: "map region sky account" }))).toEqual(first);
  });

  test("the answer gives at most the limit, and says how many more were found", async () => {
    const result = await search({ words: "weather money maps", limit: 2 });
    expect(found(result)).toHaveLength(2);
    expect(textOf(result).split("\n").at(-1)).toBe((await lines()).line("more", { count: 4 }) ?? "");
  });

  test("nothing found, and no words, are answered in the lines of the file", async () => {
    const none = await search({ words: "submarine" });
    expect([textOf(none), none.error]).toEqual([(await lines()).line("none_found", { words: "submarine" }) ?? "", undefined]);
    const empty = await search({ words: "  " });
    expect([textOf(empty), empty.error]).toEqual([(await lines()).line("no_words") ?? "", true]);
  });
});
