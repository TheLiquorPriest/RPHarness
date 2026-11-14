// The tool list an agent's requests carry never changes within a session (§6.8): tool_search and
// tool_use are two fixed entries, and finding a tool adds nothing to the list, so the cached front
// of every prompt holds.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOOL_SEARCH, TOOL_USE } from "../../../src/tools/search";
import { type Bench, bench, play } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(async () => {
  await b.close();
});

describe("the tool list in a session", () => {
  test("is byte-identical in every request of a session in which three different tools were found and used", async () => {
    const p = await play(b, {
      fixed: [TOOL_SEARCH, TOOL_USE, "world_query"],
      answers: [
        { pieces: [{ call: TOOL_SEARCH, args: { words: "weather" }, id: "search-1" }] },
        { pieces: [{ call: TOOL_USE, args: { name: "weather_set", args: { region: "Thornbury", state: "fog" } }, id: "use-1" }] },
        { pieces: [{ call: TOOL_SEARCH, args: { words: "measure distance" }, id: "search-2" }] },
        { pieces: [{ call: TOOL_USE, args: { name: "map_measure", args: { from: "B4", to: "F9" } }, id: "use-2" }] },
        { pieces: [{ text: "Fog rolls over the square." }] },
        // The next stretch of the same session.
        { pieces: [{ call: TOOL_SEARCH, args: { words: "drive a vehicle" }, id: "search-3" }] },
        { pieces: [{ call: TOOL_USE, args: { name: "vehicles_drive", args: { vehicle: "the cart", to: "Thornbury" } }, id: "use-3" }] },
        { pieces: [{ text: "The cart rolls into town." }] },
      ],
    });

    expect((await p.work("Fog comes down on Thornbury.")).status).toBe("done");
    expect((await p.work("Drive the cart into town.")).status).toBe("done");

    expect(p.ran.map((run) => run.split(" ")[0])).toEqual(["weather_set", "map_measure", "vehicles_drive"]);
    const lists = p.scripted.requests.map((request) => JSON.stringify(request.tools));
    expect(lists).toHaveLength(8);
    expect(new Set(lists).size).toBe(1);
    expect(p.scripted.requests[0]!.tools.map((tool) => tool.name)).toEqual([TOOL_SEARCH, TOOL_USE, "world_query"]);
  });
});
