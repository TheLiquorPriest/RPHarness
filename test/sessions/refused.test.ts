// A provider that refuses the lead's first call as too long (§11 "When: a call would no longer fit
// the model's own window"): the harness's estimate, or the window a model reports, can be wrong, and
// the provider's refusal is the call not fitting all the same. The session is compacted as for a
// call that would not fit, and the call is made again on what it then carries, once.
import { afterEach, expect, test } from "bun:test";
import { type Stage, stage } from "../harness/support";
import { carried, inOrder, material, play, played, said, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEP_TWO = "compaction:\n  keepTurns: 2\n";
/** A provider's refusal of a call past what its model takes, in Anthropic's words. */
const TOO_LONG = { pieces: [], end: { error: "prompt is too long: 33037 tokens > 32000 maximum" } };

test("a first call the provider refuses as too long is a call that would not fit: the session is compacted, and the call is made again on what it then carries", async () => {
  const s = (open = await stage({ config: KEEP_TWO, answers: [played(1), played(2), played(3), TOO_LONG, said("Fixture summary: the tide was checked."), played(4), played(5)] }));
  await play(s, ["t1", "t2", "t3"]);
  const { outcome } = await s.turn(turn("t4", { parent: "t3" }));

  expect(outcome).toMatchObject({ status: "released", reply: "Reply 4." });
  const [, , , refused, summary, again] = s.model.requests;
  expect(inOrder(carried(refused!), ["Intent 1.", "Intent 2.", "Intent 3."])).toBe(true);
  expect(material(summary!)).toContain("Intent 1.");
  const four = carried(again!);
  expect(inOrder(four, ["Fixture summary: the tide was checked.", "Intent 2.", "Intent 3."])).toBe(true);
  expect(four).not.toContain("Intent 1.");
  expect(s.trace.of("compacted").map((record) => record.run)).toEqual(["t4"]);

  // The next turn starts from the summary, with no compaction of its own.
  await play(s, ["t5"], "t4");
  expect(s.model.requests).toHaveLength(7);
  expect(inOrder(carried(s.model.requests[6]!), ["Fixture summary: the tide was checked.", "Intent 2.", "Intent 3.", "Intent 4."])).toBe(true);
});

test("the call is made again once: refused again, the turn ends as the provider answered", async () => {
  const s = (open = await stage({ config: KEEP_TWO, answers: [played(1), played(2), played(3), TOO_LONG, said("Fixture summary."), TOO_LONG] }));
  await play(s, ["t1", "t2", "t3"]);
  const { outcome } = await s.turn(turn("t4", { parent: "t3" }));

  expect(outcome).toMatchObject({ status: "failed", error: { code: "provider", detail: "prompt is too long: 33037 tokens > 32000 maximum" } });
  expect(s.model.requests).toHaveLength(6);
  expect(s.trace.of("compacted")).toHaveLength(1);
});
