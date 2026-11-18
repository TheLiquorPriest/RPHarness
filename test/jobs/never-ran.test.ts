// A job cancelled before it ran made no call: its view, its run's usage and the day's totals count none.
// (A job that had a place, whose first call was stopped before its request went out, counts none either:
// the runner gives that call back, `test/loop/unmade.test.ts`.)
import { afterEach, expect, test } from "bun:test";
import { gate, request, type Stage, stage } from "../harness/support";
import { jobOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";

test("a job cancelled while it waited for a place made no call, and nothing counts one", async () => {
  const s = (open = await stage({ config: "jobs:\n  atOnce: 1\n", files: { ".agents/keeper.md": KEEPER }, answers: [{ pieces: [{ hold: gate() }, { text: "Counted." }] }] }));
  const { user } = request("t1").scope;
  const running = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: "Count the bells." }));
  await s.trace.seen((record) => record.run === running.id && record.event.kind === "call_started");
  const waiting = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: "Count the lamps." }));
  expect(waiting.state).toBe("queued");

  const cancelled = await s.harness.jobs!.cancel(user, waiting.id);

  expect(cancelled).toMatchObject({ state: "cancelled", usage: { calls: 0, input: 0, output: 0 } });
  expect(await s.harness.usage.run(user, waiting.id)).toBeUndefined();
  // The day's count of the jobs' calls has nothing of the cancelled one (the running job's call is still under way, so not counted yet).
  expect((await s.harness.usage.day(user, "jobs")).calls).toBe(0);
});
