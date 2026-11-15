// A compaction cut short (§11): a summary call that fails, or the turn stopped during the lead's call
// before compaction or during the summary call. No summary is written: the turns are carried as they
// were, a compaction the host asked for still waits, and a stopped turn starts nothing more.
import { afterEach, expect, test } from "bun:test";
import { gate, type Stage, stage, WatchedSink } from "../harness/support";
import { carried, inOrder, play, played, S1, SAVE, SAVE_RULE, said, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEP_TWO = "compaction:\n  keepTurns: 2\n";

test("a summary call that fails writes no summary: the turn goes on with its turns carried as they were, and the compaction asked for waits for the next turn", async () => {
  const s = (open = await stage({ config: KEEP_TWO, answers: [played(1), played(2), played(3), { pieces: [], end: { error: "Fixture: the provider is down." } }, played(4), said("Fixture summary."), played(5)] }));
  const sessions = s.harness.sessions!;
  await play(s, ["t1", "t2", "t3"]);
  await sessions.compact(S1);
  await play(s, ["t4"], "t3");
  expect(inOrder(carried(s.model.requests[4]!), ["Intent 1.", "Intent 2.", "Intent 3."])).toBe(true);
  expect(s.trace.of("compacted")).toEqual([]);
  expect(await sessions.get(S1)).toMatchObject({ compactAsked: true });

  await play(s, ["t5"], "t4");
  expect(inOrder(carried(s.model.requests[6]!), ["Fixture summary.", "Intent 3.", "Intent 4."])).toBe(true);
  expect((await sessions.get(S1))?.compactAsked).toBeUndefined();
});

/** t1 to t3, then t4 after a compaction the host asked for, stopped while its first model call holds. */
async function stopped(s: Stage): Promise<void> {
  await play(s, ["t1", "t2", "t3"]);
  await s.harness.sessions!.compact(S1);
  const stop = new AbortController();
  const answering = s.turn(turn("t4", { parent: "t3" }), new WatchedSink(s.clock), stop.signal);
  await s.trace.seen((record) => record.scope.turn === "t4" && record.event.kind === "call_started");
  stop.abort();
  const { outcome, sink } = await answering;
  expect(outcome.status).toBe("stopped");
  expect(sink.text).toBe("");
  expect(s.model.requests).toHaveLength(4);
  expect(s.trace.of("compacted")).toEqual([]);
  expect(await s.harness.sessions!.get(S1)).toMatchObject({ compactAsked: true });
}

test("a stop during the lead's call before compaction ends the turn there: no summary call, no summary, no reply", async () => {
  const s = (open = await stage({ config: KEEP_TWO, files: { [SAVE_RULE]: SAVE }, answers: [played(1), played(2), played(3), { pieces: [{ hold: gate() }, { text: "Saved." }] }, said("Fixture summary."), played(4)] }));
  await stopped(s);
});

test("a stop during the summary call ends the turn there: no summary, and no call of the lead's", async () => {
  const s = (open = await stage({ config: KEEP_TWO, answers: [played(1), played(2), played(3), { pieces: [{ hold: gate() }, { text: "Fixture summary." }] }, played(4)] }));
  await stopped(s);
});
