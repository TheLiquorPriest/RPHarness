// A summary and the turns it stands for (§11), when the host takes a turn off the path (§6.3,
// §10.10). A summary stands for its turns as they stood when it was written: a turn that leaves the
// path afterwards reaches no later request through it, and the next compaction summarizes the turns
// again from the file. A turn that had left before the summary was written was never in it, and its
// leaving undoes nothing, in the session or in a branch made from it.
import { afterEach, expect, test } from "bun:test";
import { type Stage, stage } from "../harness/support";
import { carried, inOrder, material, play, played, S1, said, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEP_TWO = "compaction:\n  keepTurns: 2\n";

test("a turn the summary stands for that leaves the path afterwards reaches no later request through it, and the next compaction summarizes the turns again from the file", async () => {
  const s = (open = await stage({
    config: KEEP_TWO,
    answers: [played(1), played(2), played(3), said("Fixture summary: Intent 1. was ruled."), played(4), played(5), said("Fixture summary again."), played(6)],
  }));
  const sessions = s.harness.sessions!;
  await play(s, ["t1", "t2", "t3"]);
  await sessions.compact(S1);
  await play(s, ["t4"], "t3");
  expect(carried(s.model.requests[4]!)).toContain("Fixture summary: Intent 1. was ruled.");

  await s.harness.turnLeft({ ...S1, turn: "t1" });
  await play(s, ["t5"], "t4");
  const five = carried(s.model.requests[5]!);
  expect(five).not.toContain("Intent 1.");
  expect(inOrder(five, ["Intent 2.", "Intent 3.", "Intent 4."])).toBe(true);

  // Asked for again, a compaction is sent the turns as they are now, from the file.
  await sessions.compact(S1);
  await play(s, ["t6"], "t5");
  const again = material(s.model.requests[6]!);
  expect(inOrder(again, ["Intent 2.", "Intent 3."])).toBe(true);
  expect(again).not.toContain("Intent 1.");
  expect(inOrder(carried(s.model.requests[7]!), ["Fixture summary again.", "Intent 4.", "Intent 5."])).toBe(true);
});

test("a turn that left the path before a summary was written does not undo it: later turns carry the summary, and so does a branch made after", async () => {
  const s = (open = await stage({
    config: KEEP_TWO,
    answers: [played(1), played(2), played(3), played(4), said("Fixture summary: the tide was checked."), played(5), played(6), played(7)],
  }));
  const sessions = s.harness.sessions!;
  await play(s, ["t1", "t2", "t3", "t4"]);
  await s.harness.turnLeft({ ...S1, turn: "t2" });
  await sessions.compact(S1);
  await play(s, ["t5"], "t4");
  // The summary call was sent t1 alone: t2 had left, and the newest two are kept.
  const sent = material(s.model.requests[4]!);
  expect(sent).toContain("Intent 1.");
  expect(sent).not.toContain("Intent 2.");

  await play(s, ["t6"], "t5");
  expect(s.model.requests).toHaveLength(7);
  const six = carried(s.model.requests[6]!);
  expect(inOrder(six, ["Fixture summary: the tide was checked.", "Intent 3.", "Intent 4.", "Intent 5."])).toBe(true);
  for (const gone of ["Intent 1.", "Intent 2."]) expect(six).not.toContain(gone);

  // A branch made at t6.
  await sessions.fork({ ...S1, turn: "t6" }, { ...S1, session: "s2" });
  expect((await s.turn(turn("t7", { scope: { ...S1, session: "s2", turn: "t7" }, parent: "t6" }))).outcome.status).toBe("released");
  const seven = carried(s.model.requests[7]!);
  expect(inOrder(seven, ["Fixture summary: the tide was checked.", "Intent 3.", "Intent 4.", "Intent 5.", "Intent 6."])).toBe(true);
  for (const gone of ["Intent 1.", "Intent 2."]) expect(seven).not.toContain(gone);
});
