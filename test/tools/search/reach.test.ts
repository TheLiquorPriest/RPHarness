// What a definition says of the tools beyond its list (§6.8): it can pin a searchable tool into its
// fixed list, or keep a family out of its reach, and then the search does not find it for that agent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { TOOL_SEARCH, TOOL_USE } from "../../../src/tools/search";
import { type Bench, bench, play, textOf } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(async () => {
  await b.close();
});

function answered(messages: readonly Message[], callId: string): string {
  const result = messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
  return result?.role === "toolResult" ? textOf(result) : "";
}

describe("a definition's reach", () => {
  test("a pinned tool is in the fixed list and called directly; a family kept out of reach is not found, and tool_use does not call it", async () => {
    const lines = await b.guidance.part("tool-search");
    if (lines?.format !== "lines") throw new Error("The shipped tool-search.md is a lines part.");
    const p = await play(b, {
      // map_lay is pinned; apply_credit is pinned though its family is kept out of reach, and stays held.
      fixed: [TOOL_SEARCH, TOOL_USE, "map_lay", "apply_credit"],
      outOfReach: ["money"],
      answers: [
        { pieces: [{ call: TOOL_SEARCH, args: { words: "map grid squares" }, id: "search-maps" }] },
        { pieces: [{ call: TOOL_SEARCH, args: { words: "money account bank" }, id: "search-money" }] },
        { pieces: [{ call: TOOL_USE, args: { name: "open_account", args: { holder: "Mira", bank: "Thornbury Savings" } }, id: "use-money" }] },
        { pieces: [{ call: "map_lay", args: { place: "the tavern", rows: ["#..#"] }, id: "lay" }] },
        { pieces: [{ text: "The tavern has its grid." }] },
      ],
    });

    expect((await p.work("Lay out the tavern.")).status).toBe("done");

    const requests = p.scripted.requests;
    expect(requests[0]!.tools.map((tool) => tool.name)).toEqual([TOOL_SEARCH, TOOL_USE, "map_lay", "apply_credit"]);
    const maps = answered(requests[1]!.messages, "search-maps");
    expect(maps).toContain("map_measure (maps)");
    expect(maps).not.toContain("map_lay");
    expect(answered(requests[2]!.messages, "search-money")).toBe(lines.line("none_found", { words: "money account bank" }) ?? "");
    expect(answered(requests[3]!.messages, "use-money")).toBe(lines.line("no_tool", { tool: "open_account" }) ?? "");
    expect(p.ran).toEqual(['map_lay {"place":"the tavern","rows":["#..#"]}']);
  });
});
