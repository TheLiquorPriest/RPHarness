// The judging model of the `question:` rules (§5.4), as a turn runs it: after a message the lead
// finishes, the rule's question is put to a model in one call under the turn's limits, written from
// `.prompts/judge.md`; a yes puts the rule's text in front of the lead as every rule's text gets
// there. With `interrupt: always` the lead waits for the answer before its next call; without, it
// goes on, and an answer that comes once its work has ended is held for the next briefing. The
// judge's model is the rule's own, then the setting's. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { Answer, Reply } from "../../src/testing/rig";
import { gate, request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const QUESTION = "Does it promise a reward?";
const TEXT = "Fixture rule: no reward is promised here.";
const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [todo]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";
const rule = (extra: string) => `---\ndescription: Fixture - a reward promised.\nagents: [lead]\nscope: [text]\nquestion: ${QUESTION}\n${extra}---\n${TEXT}\n`;

/** Every call's answer, by whose call it is: the judging model's (its request puts the question) or the lead's, each from its own list in order. */
function routed(lead: Reply[], judge: Answer[]): Answer[] {
  const route: Answer = (req) => {
    const judging = req.messages.some((message) => textOf(message).includes(QUESTION));
    const next = (judging ? judge : lead).shift();
    if (next === undefined) throw new Error("The fixture has no answer left for this call.");
    return typeof next === "function" ? next(req) : next;
  };
  return Array.from({ length: lead.length + judge.length }, () => route);
}

/** What one of the model's requests holds, as text. */
function sent(s: Stage, index: number): string {
  return s.model.requests[index]!.messages.map((message) => textOf(message)).join("\n");
}

test("with `interrupt: always` the lead waits for the answer before its next call, which has the rule's text; the judge runs on the rule's own connection, one call counted under the turn", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".rules/fixture-reward.md": rule("interrupt: always\njudge: fixture-judge\n") },
    answers: routed(
      [{ pieces: [{ text: "A reward awaits whoever climbs." }, { call: "todo", args: { items: [{ text: "climb the tower" }] } }] }, { pieces: [{ text: "<reply>The tower waits.</reply>" }] }],
      // The answer is slow to come. Nothing marks a lead that is waiting, and one that goes on reaches its
      // next call through the host's file reads, so only a real delay lets a lead that does not wait
      // show itself: it would make that call, without the rule's text, long before this answer.
      [
        async () => {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 30);
          await promise;
          return { pieces: [{ text: "Yes, it does." }] };
        },
      ],
    ),
  }));

  const { outcome } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome.status).toBe("released");
  // The lead's first call, the judge's, the lead's second.
  expect(sent(s, 1)).toContain(QUESTION);
  expect(sent(s, 1)).toContain("A reward awaits whoever climbs.");
  expect(sent(s, 2)).toContain(TEXT);
  expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.moment, record.event.firing.action])).toEqual([["fixture-reward", "after-message", "remind"]]);
  const judge = s.trace.of("agent_started").find((record) => record.agent?.parent !== undefined && record.event.definition === "lead");
  expect(judge?.event.connection).toBe("fixture-judge");
  expect(outcome.usage.calls).toBe(3);
});

test("without it the lead goes on; an answer that comes once its work has ended is held for its next briefing, and the turn waits for it; the judge runs on the setting's connection", async () => {
  const slow = gate();
  const s = (open = await stage({
    config: "rules:\n  judge: fixture-setting\n",
    files: { ".agents/lead.md": LEAD, ".rules/fixture-reward.md": rule("") },
    answers: routed([{ pieces: [{ text: "<reply>A reward awaits whoever climbs.</reply>" }] }, { pieces: [{ text: "<reply>The tower waits.</reply>" }] }], [{ pieces: [{ hold: slow }, { text: "yes" }] }, { pieces: [{ text: "No." }] }]),
  }));

  const first = s.turn(request("t1", { lead: "lead" }));
  // The lead's work ends with its reply while the judge has not answered; the turn waits for it.
  await s.trace.seen((record) => record.event.kind === "agent_ended" && record.agent?.parent === undefined);
  slow.open();
  expect((await first).outcome.status).toBe("released");
  expect(s.trace.of("rule_fired").map((record) => record.event.firing.action)).toEqual(["briefing"]);
  expect(s.trace.of("agent_started").find((record) => record.agent?.parent !== undefined)?.event.connection).toBe("fixture-setting");

  expect((await s.turn(request("t2", { lead: "lead" }))).outcome.status).toBe("released");
  const second = s.model.requests.findLastIndex((req) => req.messages.some((message) => textOf(message).includes("Fixture lead: you run the turn.")));
  expect(sent(s, second)).toContain(TEXT);
});
