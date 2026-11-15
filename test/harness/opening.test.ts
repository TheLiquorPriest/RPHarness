// An agent's opening block (§5.2, §10.2): the skills' index goes to an agent that can call
// `skill_load`, by holding it or by reaching it through `tool_use` (§6.8, R-65). Everything here is
// invented.
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const SKILL = "---\nname: fixture-tides\ndescription: Fixture - load it when the tide matters.\n---\nFixture body of fixture-tides.\n";
const lead = (outOfReach: string) => `---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [tool_use]\n${outOfReach}given: [prompt:*]\n---\nFixture chief: you run the turn.\n`;

/** The lead's opening block on its first call, under a definition with the given `out_of_reach:` line. */
async function openingWith(outOfReach: string): Promise<string> {
  const s = (open = await stage({ files: { ".agents/chief.md": lead(outOfReach), ".skills/fixture-tides/SKILL.md": SKILL }, answers: [{ pieces: [{ text: "<reply>The tide turns.</reply>" }] }] }));
  expect((await s.turn(request("t1", { lead: "chief" }))).outcome.status).toBe("released");
  const text = textOf(s.model.requests[0]!.messages[0]!);
  await s.close();
  open = undefined;
  return text;
}

test("a definition holding tool_use and not skill_load is given the skills' index; with skills out of its reach it is not", async () => {
  expect(await openingWith("")).toContain("fixture-tides");
  expect(await openingWith("out_of_reach: [skills]\n")).not.toContain("fixture-tides");
});
