// Things that run a command or call out (§16) are found and called only while the host's switches
// say they are on. One that waits is named as waiting in the search's answer, in words from a file,
// and is not run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { JsonValue, SwitchState } from "../../../src/contract";
import type { LoopToolResult } from "../../../src/loop/types";
import { TOOL_SEARCH, TOOL_USE, toolSearch, toolUse } from "../../../src/tools/search";
import { type Bench, bench, ctxOf, fixtureTools, play, type Ran, standIn, switches, textOf } from "./support";

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

function details(result: LoopToolResult): JsonValue {
  return result.details ?? null;
}

async function lines(on: Bench) {
  const part = await on.guidance.part("tool-search");
  if (part?.format !== "lines") throw new Error("tool-search.md is a lines part.");
  return part;
}

describe("switches", () => {
  test("a thing that waits is named as waiting in the search's answer, and its tools are not run", async () => {
    const p = await play(b, {
      fixed: [TOOL_SEARCH, TOOL_USE],
      switches: switches({ "dice-tower": "waiting" }),
      answers: [
        { pieces: [{ call: TOOL_SEARCH, args: { words: "dice roll" }, id: "search-dice" }] },
        { pieces: [{ call: TOOL_USE, args: { name: "dice_roll", args: { formula: "3d6" } }, id: "use-dice" }] },
        { pieces: [{ text: "No dice tonight." }] },
      ],
    });

    expect((await p.work("Roll for it.")).status).toBe("done");

    const shipped = await lines(b);
    const requests = p.scripted.requests;
    expect(answered(requests[1]!.messages, "search-dice")).toBe(shipped.line("waiting", { name: "dice-tower", tools: ["dice_roll", "dice_stats"] }) ?? "");
    expect(answered(requests[2]!.messages, "use-dice")).toBe(shipped.line("not_switched_on", { tool: "dice_roll", name: "dice-tower" }) ?? "");
    expect(p.ran).toEqual([]);
  });

  test("the waiting words are the file's: changed in the player's own file, the answer follows", async () => {
    const changed = await bench({ ".prompts/tool-search.md": "---\ndescription: Fixture - tool search's words, changed.\nformat: lines\n---\nwaiting: Fixture: {{name}} is off until switched on ({{tools}}).\n" });
    try {
      const result = await toolSearch(changed.deps(standIn(fixtureTools([])), { switches: switches({}) })).run({ words: "page address" }, ctxOf());
      expect(textOf(result)).toBe("Fixture: page_fetch is off until switched on (page_fetch).");
    } finally {
      await changed.close();
    }
  });

  test("switched on, its tools are found and called; switched off, or with no switches at all, they are neither found nor named", async () => {
    const search = async (states: Readonly<Record<string, SwitchState>> | undefined) => {
      const ran: Ran = [];
      const deps = b.deps(standIn(fixtureTools(ran)), states !== undefined ? { switches: switches(states) } : {});
      const found = await toolSearch(deps).run({ words: "dice" }, ctxOf());
      const used = await toolUse(deps).run({ name: "dice_stats", args: { formula: "2d6" } }, ctxOf());
      return { found: details(found), used: [textOf(used), used.error ?? false], ran };
    };
    const shipped = await lines(b);

    expect(await search({ "dice-tower": "on" })).toEqual({ found: { found: ["dice_roll", "dice_stats"], waiting: [] }, used: ["Even odds.", false], ran: ['dice_stats {"formula":"2d6"}'] });
    const unreached = { found: { found: [], waiting: [] }, used: [shipped.line("no_tool", { tool: "dice_stats" }) ?? "", true], ran: [] };
    expect(await search({ "dice-tower": "off" })).toEqual(unreached);
    expect(await search(undefined)).toEqual(unreached);
  });
});
