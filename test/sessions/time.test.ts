// The turn's own time (§10.11: limits are the user's settings, and a turn that hits one ends with
// what it has and says which) holds while the session is compacted: when it runs out during the
// lead's call at the moment before compaction, or during the summary call, nothing more of the turn
// starts, and the turn ends at that limit.
import { afterEach, expect, test } from "bun:test";
import { gate, type Stage, stage } from "../harness/support";
import { play, played, S1, SAVE, SAVE_RULE, said, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const ONE_SECOND = "limits:\n  turn:\n    time: 1\ncompaction:\n  keepTurns: 2\n";

/** t1 to t3, then t4 after a compaction the host asked for; t4's time runs out while its first model call holds. */
async function outOfTime(s: Stage): Promise<void> {
  await play(s, ["t1", "t2", "t3"]);
  await s.harness.sessions!.compact(S1);
  const answering = s.turn(turn("t4", { parent: "t3" }));
  await s.trace.seen((record) => record.scope.turn === "t4" && record.event.kind === "call_started");
  s.clock.advance(1_500);
  const { outcome } = await answering;
  expect(outcome).toMatchObject({ status: "limit", limit: { limit: "time", per: "turn", max: 1_000 } });
  // Nothing after the call the time ran out in: no other call, no summary written.
  expect(s.model.requests).toHaveLength(4);
  expect(s.trace.of("compacted")).toEqual([]);
}

test("the turn's time running out during the lead's call before compaction ends the turn there", async () => {
  const held = gate();
  const s = (open = await stage({ config: ONE_SECOND, files: { [SAVE_RULE]: SAVE }, answers: [played(1), played(2), played(3), { pieces: [{ hold: held }, { text: "Saved." }] }, said("Fixture summary."), played(4)] }));
  await outOfTime(s);
});

test("the turn's time running out during the summary call ends the turn there", async () => {
  const held = gate();
  const s = (open = await stage({ config: ONE_SECOND, answers: [played(1), played(2), played(3), { pieces: [{ hold: held }, { text: "Fixture summary." }] }, played(4)] }));
  await outOfTime(s);
});
