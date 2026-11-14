// Things that run a command or call out (§16) are found and called only while the host's switches
// say they are on, through the harness as a turn runs: the host's tools through the registry, tool
// search over the harness's own reach, and every call through the turn's gate. One that waits is
// named as waiting in the search's answer, in words from a file, and is not run, pinned or found.
import { afterEach, describe, expect, test } from "bun:test";
import type { SwitchState, ToolResult } from "../../../src/contract";
import { loadGuidance } from "../../../src/files";
import type { LinesPart } from "../../../src/files/api";
import { type HostToolFixture, request, type Stage, stage, textOf } from "../../harness/support";
import { DICE_SERVER, PAGE_ADDRESS, switches } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** A lead that pins the page tool, which calls out, beside tool search's two. */
const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [tool_search, tool_use, page_fetch]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";

/** Every call a host tool ran, as `name args`. */
type Ran = string[];

/** The host's tools: two of a dice server and one of a page address, all calling out, and one that does not. */
function hostTools(ran: Ran): Record<string, HostToolFixture> {
  const tool = (description: string, result: string, extra: Partial<HostToolFixture> = {}): HostToolFixture => ({
    tier: "external",
    family: "dice",
    description,
    parameters: { properties: { formula: { type: "string" } } },
    run: async (args): Promise<ToolResult> => {
      ran.push(`${description.split(" ")[0]} ${JSON.stringify(args)}`);
      return { content: [{ type: "text", text: result }] };
    },
    ...extra,
  });
  return {
    dice_roll: tool("Rolls dice by a formula on the dice tower and gives each die.", "17", { switchable: DICE_SERVER }),
    dice_stats: tool("Gives the odds of a dice formula.", "Even odds.", { switchable: DICE_SERVER }),
    page_fetch: tool("Fetches a page by its address and gives its text.", "A page.", { family: "web", parameters: { properties: { address: { type: "string" } } }, switchable: PAGE_ADDRESS }),
    world_query: tool("Reads the world tree at any place and depth.", "The tavern holds three people.", { tier: "read", family: "state", parameters: { properties: { at: { type: "string" } } } }),
  };
}

/** One turn: the lead searches for dice, calls a dice tool through `tool_use` and its pinned page tool, then replies. */
async function played(states: Readonly<Record<string, SwitchState>> | undefined, files: Record<string, string> = {}): Promise<{ s: Stage; ran: Ran }> {
  const ran: Ran = [];
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ...files },
    tools: hostTools(ran),
    ...(states !== undefined ? { switches: switches(states) } : {}),
    answers: [
      {
        pieces: [
          { call: "tool_search", args: { words: "dice roll" }, id: "search-dice" },
          { call: "tool_use", args: { name: "dice_stats", args: { formula: "3d6" } }, id: "use-dice" },
          { call: "page_fetch", args: { address: "https://pages.example.invalid/tide" }, id: "pinned-page" },
        ],
      },
      { pieces: [{ text: "<reply>The tide turns.</reply>" }] },
    ],
  }));
  const { outcome } = await s.turn(request("t1", { lead: "lead" }));
  expect(outcome.status).toBe("released");
  return { s, ran };
}

/** The answer a call got, as the model read it in the request after it. */
function answerTo(s: Stage, callId: string): string {
  for (const req of s.model.requests) {
    const found = req.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    if (found !== undefined) return textOf(found);
  }
  return "";
}

/** A lines part as the turn's guidance has it. */
async function lines(s: Stage, name: string): Promise<LinesPart> {
  const part = await loadGuidance(s.env.files, request("t1").scope).part(name);
  if (part?.format !== "lines") throw new Error(`${name} is a lines part.`);
  return part;
}

describe("switches", () => {
  test("a thing that waits is named as waiting in the search's answer; neither a found tool of it nor a pinned one runs", async () => {
    const { s, ran } = await played({});

    const search = await lines(s, "tool-search");
    const notices = await lines(s, "tool-notices");
    expect(answerTo(s, "search-dice")).toBe(search.line("waiting", { name: "dice-tower", tools: ["dice_roll", "dice_stats"] }) ?? "");
    expect(answerTo(s, "use-dice")).toBe(search.line("not_switched_on", { tool: "dice_stats", name: "dice-tower" }) ?? "");
    expect(answerTo(s, "pinned-page")).toBe(notices.line("not_switched_on", { tool: "page_fetch", name: "page_fetch", waiting: true }) ?? "");
    expect(ran).toEqual([]);
  });

  test("switched on, its tools are found and run, found or pinned", async () => {
    const { s, ran } = await played({ "dice-tower": "on", page_fetch: "on" });

    expect(answerTo(s, "search-dice")).toContain("dice_roll (dice)");
    expect(answerTo(s, "use-dice")).toBe("Even odds.");
    expect(answerTo(s, "pinned-page")).toBe("A page.");
    expect([...ran].sort()).toEqual(['Fetches {"address":"https://pages.example.invalid/tide"}', 'Gives {"formula":"3d6"}']);
  });

  test("switched off, or with no switches at all, its tools are neither found nor named, and a pinned one is refused", async () => {
    for (const states of [{ "dice-tower": "off", page_fetch: "off" } as const, undefined]) {
      const { s, ran } = await played(states);

      const search = await lines(s, "tool-search");
      const notices = await lines(s, "tool-notices");
      expect(answerTo(s, "search-dice")).toBe(search.line("none_found", { words: "dice roll" }) ?? "");
      expect(answerTo(s, "use-dice")).toBe(search.line("no_tool", { tool: "dice_stats" }) ?? "");
      expect(answerTo(s, "pinned-page")).toBe(notices.line("not_switched_on", { tool: "page_fetch", name: "page_fetch" }) ?? "");
      expect(ran).toEqual([]);
      await s.close();
      open = undefined;
    }
  });

  test("the words are the files': changed in the player's own files, the answers follow", async () => {
    const { s } = await played(
      {},
      {
        ".prompts/tool-search.md": "---\ndescription: Fixture - tool search's words, changed.\nformat: lines\n---\nwaiting: Fixture: {{name}} is off until switched on ({{tools}}).\n",
        ".prompts/tool-notices.md": "---\ndescription: Fixture - the tool answers' words, changed.\nformat: lines\n---\nnot_switched_on: Fixture: {{tool}} waits on {{name}}.\n",
      },
    );

    expect(answerTo(s, "search-dice")).toBe("Fixture: dice-tower is off until switched on (dice_roll, dice_stats).");
    expect(answerTo(s, "pinned-page")).toBe("Fixture: page_fetch waits on page_fetch.");
  });
});
