// The summary a session opened with (§11: the previous scene's) is carried in every mode, beside the
// newest summary of the session's own earlier turns: a compaction replaces older turns, never what the
// scene opened with. It is not sent to the summary call, since it is carried as it is.
import { afterEach, expect, test } from "bun:test";
import { type Stage, stage } from "../harness/support";
import { carried, inOrder, material, play, played, S1, said } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const OPENING = "Fixture opening: the bridge is out.";

test("after a compaction, the summary the session opened with is still carried, beside the compaction's, and the summary call is not sent it", async () => {
  const s = (open = await stage({ config: "compaction:\n  keepTurns: 2\n", answers: [played(1), played(2), played(3), said("Fixture summary: the tide was checked."), played(4), played(5)] }));
  const sessions = s.harness.sessions!;
  await sessions.open(S1, { summary: OPENING });
  await play(s, ["t1", "t2", "t3"]);
  expect(carried(s.model.requests[2]!)).toContain(OPENING);
  await sessions.compact(S1);
  await play(s, ["t4", "t5"], "t3");

  const [, , , summary, four, five] = s.model.requests;
  expect(material(summary!)).toContain("Intent 1.");
  expect(material(summary!)).not.toContain(OPENING);
  for (const req of [four!, five!]) expect(inOrder(carried(req), [OPENING, "Fixture summary: the tide was checked.", "Intent 2.", "Intent 3."])).toBe(true);
});
