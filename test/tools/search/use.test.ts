// `tool_use` (§6.8), its own answers: arguments that do not fit the found tool's own schema, and a
// name that is no tool the agent can reach. A found tool run as itself, through the runner and the
// turn's gate, is tested as a turn runs it, in `test/harness/tool-use.test.ts` and
// `test/harness/tool-search.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOOL_USE, toolUse } from "../../../src/tools/search";
import { type Bench, bench, ctxOf, fixtureTools, type Ran, standIn, textOf } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(async () => {
  await b.close();
});

describe("tool_use", () => {
  test("arguments that do not fit the found tool's own schema get the tool answers' line, naming that tool and what it takes, and it does not run", async () => {
    const ran: Ran = [];
    const tools = fixtureTools(ran);
    const result = await toolUse(b.deps(standIn(tools))).run({ name: "open_account", args: { holder: "Mira" } }, ctxOf());
    expect(result.error).toBe(true);
    expect(textOf(result)).toStartWith("open_account was not run: the arguments you sent do not fit what it takes.");
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
