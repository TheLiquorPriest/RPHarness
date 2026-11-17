// The skills in force (§5.4: only names and descriptions sit in the prompt; the body is loaded when
// asked): an agent that holds skill_load is shown each by its name and description, the lead in its
// opening block and a sub-agent in its instructions, laid out by RPH's own skills part. A skill
// switched off is not shown, one replaced is shown as the nearer file has it, and a change in the
// middle of a session reaches the lead in its next briefing.
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CHIEF = "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [delegate, skill_load]\ngiven: [prompt:*, briefing]\n---\nFixture chief: you run the turn.\n";
const GM = "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: [skill_load]\n---\nFixture gm: rule on what you are asked.\n";
const SCRIBE = "---\nname: scribe\ndescription: Fixture scribe.\nmodel: default\ntools: []\n---\nFixture scribe: write it down.\n";
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nFixture body of ${name}.\n`;
const FILES = {
  ".agents/chief.md": CHIEF,
  ".agents/gm.md": GM,
  ".agents/scribe.md": SCRIBE,
  ".skills/fixture-tides/SKILL.md": skill("fixture-tides", "Fixture - load it when the tide matters."),
  ".skills/fixture-knots/SKILL.md": skill("fixture-knots", "Fixture - load it when a rope is tied."),
  "chats/wren-hale/lighthouse/skills/fixture-knots/SKILL.md": skill("fixture-knots", "Fixture - the chat's own knots."),
};

/** The lead delegates to the GM and the scribe, each answers, and the lead replies. */
const ANSWERS = [
  {
    pieces: [
      { call: "delegate", args: { agent: "gm", brief: "Rule on the tide." }, id: "d-1" },
      { call: "delegate", args: { agent: "scribe", brief: "Note the tide." }, id: "d-2" },
    ],
  },
  { pieces: [{ text: "Low tide at dusk." }] },
  { pieces: [{ text: "Noted." }] },
  { pieces: [{ text: "<reply>The tide is low.</reply>" }] },
];

/** Each agent's first request's instructions (its first message, the system prompt), by its definition. */
function instructionsBy(s: Stage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const started of s.trace.of("agent_started")) {
    const asked = s.model.requests.find((r) => textOf(r.messages[0]!).startsWith(`Fixture ${started.agent?.definition}:`));
    if (asked !== undefined) out[started.agent!.definition] = textOf(asked.messages[0]!);
  }
  return out;
}

test("the skills in force are listed by name and description in the lead's opening block and in the instructions of a sub-agent that holds skill_load; one replaced shows as the nearer file has it", async () => {
  const s = (open = await stage({ files: FILES, answers: ANSWERS }));

  const { outcome } = await s.turn(request("t1", { lead: "chief" }));

  expect(outcome.status).toBe("released");
  const by = instructionsBy(s);
  for (const agent of ["chief", "gm"]) {
    expect(by[agent]).toContain("- fixture-tides: Fixture - load it when the tide matters.");
    expect(by[agent]).toContain("- fixture-knots: Fixture - the chat's own knots.");
    expect(by[agent]).not.toContain("load it when a rope is tied");
  }
  // The scribe holds no skill_load: it is shown no list it could not load from.
  expect(by["scribe"]).toBe("Fixture scribe: write it down.");
});

test("a skill switched off is listed for no agent", async () => {
  const s = (open = await stage({ files: FILES, config: "stack:\n  off:\n    - skills/fixture-tides\n", answers: ANSWERS }));

  await s.turn(request("t1", { lead: "chief" }));

  const by = instructionsBy(s);
  for (const agent of ["chief", "gm"]) {
    expect(by[agent]).not.toContain("fixture-tides");
    expect(by[agent]).toContain("- fixture-knots: Fixture - the chat's own knots.");
  }
});

test("a skill switched off in the middle of a session: the next briefing says the opening block's list no longer stands, and gives the list as it stands", async () => {
  const s = (open = await stage({ files: FILES, answers: [{ pieces: [{ text: "<reply>Calm.</reply>" }] }, { pieces: [{ text: "<reply>Still calm.</reply>" }] }] }));
  await s.turn(request("t1", { lead: "chief" }));
  const opening = textOf(s.model.requests[0]!.messages[0]!);
  expect(opening).toContain("fixture-tides");
  expect(textOf(s.model.requests[0]!.messages.at(-1)!)).not.toContain("no longer stands");

  await Bun.write(`${s.dir}/files/config.yml`, "stack:\n  off:\n    - skills/fixture-tides\n");
  await s.turn(request("t2", { lead: "chief", parent: "t1" }));

  // The opening block holds still for the session; the briefing carries the change.
  expect(textOf(s.model.requests[1]!.messages[0]!)).toBe(opening);
  const briefing = textOf(s.model.requests[1]!.messages.at(-1)!);
  expect(briefing).toContain("The list of skills in the opening block no longer stands. The list as it stands now follows.");
  const after = briefing.slice(briefing.indexOf("The list as it stands now follows."));
  expect(after).toContain("- fixture-knots: Fixture - the chat's own knots.");
  expect(after).not.toContain("fixture-tides");
});
