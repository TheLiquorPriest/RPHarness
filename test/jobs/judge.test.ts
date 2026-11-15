// The judging model of the `question:` rules runs for the user whose run asks it (READINGS R-52,
// §16): its model is chosen among that user's connections, never another's. The turn runs on models
// scripted for one user that keep every choice they were asked for, so this fails where a judge is
// given a choice naming another user. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { scriptedModel } from "../../src/testing/rig";
import { request, type Stage, stage, textOf, USER } from "../harness/support";
import { turnOn, userHarness } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const QUESTION = "Does it promise a reward?";
const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [todo]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";
const rule = (extra: string) => `---\ndescription: Fixture - a reward promised.\nagents: [lead]\nscope: [text]\nquestion: ${QUESTION}\n${extra}---\nFixture rule: no reward is promised here.\n`;

test("a judge's model choice names the run's user: on the rule's own connection, and on the setting's", async () => {
  const s = (open = await stage({ config: "rules:\n  judge: fixture-setting\n", files: { ".agents/lead.md": LEAD, ".rules/fixture-own.md": rule("judge: fixture-judge\n"), ".rules/fixture-set.md": rule("") }, answers: [] }));
  const lead = scriptedModel([{ pieces: [{ text: "<reply>A reward awaits whoever climbs.</reply>" }] }], { clock: s.clock });
  // One judging model for each connection the two rules name; each answers the question put to it.
  const own = scriptedModel([{ pieces: [{ text: "No." }] }], { clock: s.clock });
  const set = scriptedModel([{ pieces: [{ text: "No." }] }], { clock: s.clock });
  const { harness, source } = userHarness(s, { "": lead, "fixture-judge": own, "fixture-setting": set });
  try {
    const { outcome } = await turnOn(s, harness, request("t1", { lead: "lead" }));

    expect(outcome.status).toBe("released");
    // Each judge was put the question on a model of the run's user's, and no choice named another.
    expect(own.requests.map((req) => req.messages.some((message) => textOf(message).includes(QUESTION)))).toEqual([true]);
    expect(set.requests.map((req) => req.messages.some((message) => textOf(message).includes(QUESTION)))).toEqual([true]);
    expect(source.asked.map((choice) => choice.user)).toEqual([USER, USER, USER]);
    expect(source.asked.map((choice) => choice.connectionId ?? "default").sort()).toEqual(["default", "fixture-judge", "fixture-setting"]);
  } finally {
    await harness.close();
  }
});
