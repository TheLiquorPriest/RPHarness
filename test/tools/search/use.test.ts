// `tool_use` (§6.8): a found tool is called, and treated as itself: its arguments are checked
// against its own schema, and its lane, the player's permission, the rules and the trace all see the
// tool that was found.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ApprovalsPort } from "../../../src/contract";
import { TOOL_SEARCH, TOOL_USE, toolUse } from "../../../src/tools/search";
import { type Bench, bench, ctxOf, fixtureTools, play, type Ran, standIn, textOf } from "./support";

const RULE = "---\ndescription: Fixture - reminds when an account comes back marked unsourced.\nagents: all\nscope: [result:open_account]\ncondition: marked unsourced\n---\nFixture rule: say where that money came from.\n";

let b: Bench;
beforeAll(async () => {
  b = await bench({ ".rules/found-write.md": RULE });
});
afterAll(async () => {
  await b.close();
});

/** The answer a call got, as the model read it on a later request. */
function answered(messages: readonly Message[], callId: string): string {
  const result = messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
  return result?.role === "toolResult" ? textOf(result) : "";
}

function confirming(): ApprovalsPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    permission: async () => "confirm",
    ask: async (_scope, ask) => {
      asked.push(`${ask.tool}:${ask.lane}`);
      return { go: true };
    },
  };
}

describe("tool_use", () => {
  test("a tool found by its own words is called through tool_use as itself: checked by its own schema, asked about on its own lane, ruled on and traced under its own name", async () => {
    const approvals = confirming();
    const p = await play(b, {
      fixed: [TOOL_SEARCH, TOOL_USE, "world_query"],
      approvals,
      answers: [
        { pieces: [{ call: TOOL_SEARCH, args: { words: "bank deposit" }, id: "search-1" }] },
        { pieces: [{ call: TOOL_USE, args: { name: "open_account", args: { holder: "Mira", bank: "Thornbury Savings", deposit: "40" } }, id: "use-1" }] },
        { pieces: [{ text: "Done." }] },
      ],
    });

    expect((await p.work("Open Mira an account.")).status).toBe("done");

    const requests = p.scripted.requests;
    expect(answered(requests[1]!.messages, "search-1")).toContain("open_account (money): Opens an account for someone at a bank, with a first deposit.");
    // Its own schema took the deposit the model sent as text, as a whole number.
    expect(p.ran).toEqual(['open_account {"holder":"Mira","bank":"Thornbury Savings","deposit":40}']);
    expect(approvals.asked).toEqual(["open_account:engine"]);
    expect(p.recorder.of("approval_asked").map((record) => record.event.tool)).toEqual(["open_account"]);
    // The rule on that tool's result fired for it, and its text came back with the answer.
    expect(p.recorder.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.tool])).toEqual([["found-write", "open_account"]]);
    const answer = answered(requests[2]!.messages, "use-1");
    expect(answer).toContain('Account opened: {"holder":"Mira","bank":"Thornbury Savings","deposit":40}');
    expect(answer).toContain("Fixture rule: say where that money came from.");
    const found = p.recorder.of("tool_started").filter((record) => record.event.via === TOOL_USE);
    expect(found.map((record) => [record.event.tool, record.event.callId])).toEqual([["open_account", "use-1"]]);
    expect(p.recorder.of("tool_ended").filter((record) => record.event.tool === "open_account")).toHaveLength(1);
  });

  test("arguments that do not fit the found tool's own schema get the tool answers' line, naming that tool and what it takes, and it does not run", async () => {
    const ran: Ran = [];
    const tools = fixtureTools(ran);
    const result = await toolUse(b.deps(standIn(tools))).run({ name: "open_account", args: { holder: "Mira" } }, ctxOf());
    const schema = tools.find((tool) => tool.name === "open_account")!.parameters;
    expect([textOf(result), result.error]).toEqual([b.notices("invalid", { tool: "open_account", arguments: '{"holder":"Mira"}', parameters: JSON.stringify(schema) }) ?? "", true]);
    expect(ran).toEqual([]);
  });

  test("a name that is no tool the agent can reach is answered in the file's words, and nothing runs", async () => {
    const ran: Ran = [];
    const lines = await b.guidance.part("tool-search");
    if (lines?.format !== "lines") throw new Error("The shipped tool-search.md is a lines part.");
    for (const name of ["submarine_dive", TOOL_USE]) {
      const result = await toolUse(b.deps(standIn(fixtureTools(ran)))).run({ name, args: {} }, ctxOf());
      expect([textOf(result), result.error]).toEqual([lines.line("no_tool", { tool: name }) ?? "", true]);
    }
    expect(ran).toEqual([]);
  });
});
