// A `question:` rule about the reply (§5.4): a small model is asked about the reply once it has been
// shown, so the question is put the moment the reply is released, in whichever form, and its text
// goes to the next briefing. A `reply_release` is followed by the lead's own message with no call,
// which ends the run, and the question is asked at the release all the same. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { Answer, RecordedRequest, Reply } from "../../src/testing/rig";
import { request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const QUESTION = "Does the reply promise a reward?";
const TEXT = "Fixture rule: last turn's reply promised a reward; keep to what was promised.";
const RULE = `---\ndescription: Fixture - a reward promised in the reply.\nagents: [lead]\nscope: [reply]\nquestion: ${QUESTION}\n---\n${TEXT}\n`;
const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [reply_release, todo]\ngiven:\n  - prompt:*\n  - briefing\n---\nFixture lead: you run the turn.\n";
const RELEASED = "A reward awaits whoever climbs the tower.";

/** Whether a request is the judging model's: it puts the question. */
function asks(req: RecordedRequest): boolean {
  return req.messages.some((message) => textOf(message).includes(QUESTION));
}

/** Every call's answer, by whose call it is: the judging model's or the lead's, each from its own list in order. */
function routed(lead: Reply[], judge: Reply[]): Answer[] {
  const route: Answer = (req) => {
    const next = (asks(req) ? judge : lead).shift();
    if (next === undefined) throw new Error("The fixture has no answer left for this call.");
    return next;
  };
  return Array.from({ length: lead.length + judge.length }, () => route);
}

test("a question rule on the reply, released by a reply_release: asked once at release, its text in the next briefing", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".rules/fixture-promise.md": RULE, "chats/wren-hale/lighthouse/persistent-workspace/reply.md": `${RELEASED}\n` },
    answers: routed(
      [{ pieces: [{ call: "reply_release", args: { path: "persistent-workspace/reply.md" } }] }, { pieces: [{ text: "Released." }] }, { pieces: [{ text: "<reply>The tower waits.</reply>" }] }],
      [{ pieces: [{ text: "Yes." }] }, { pieces: [{ text: "No." }] }],
    ),
  }));
  const judged = (): string[] => s.model.requests.filter(asks).map((req) => req.messages.map((message) => textOf(message)).join("\n"));

  const first = await s.turn(request("t1", { lead: "lead" }));

  expect(first.outcome).toMatchObject({ status: "released", form: "file" });
  // The run ended on the lead's message after the release, and the question was put once, about the reply.
  expect(s.model.requests.filter((req) => !asks(req))).toHaveLength(2);
  expect(judged()).toHaveLength(1);
  expect(judged()[0]).toContain(RELEASED);
  expect(s.trace.of("rule_fired").map((record) => [record.scope.turn, record.event.firing.rule, record.event.firing.watched, record.event.firing.action])).toEqual([["t1", "fixture-promise", "reply", "briefing"]]);

  await s.turn(request("t2", { lead: "lead", parent: "t1" }));
  const lead = s.model.requests.filter((req) => !asks(req));
  // The next turn's briefing carries the rule's text; the first turn's lead never saw it.
  expect(textOf(lead[2]!.messages.at(-1)!)).toContain(TEXT);
  for (const call of lead.slice(0, 2)) expect(call.messages.map((message) => textOf(message)).join("\n")).not.toContain(TEXT);
});
