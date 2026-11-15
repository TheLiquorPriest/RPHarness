// A run's usage is its user's (READINGS R-52; §16: one user never reaches another's): asked with
// another user and a run's id, `usage.run` answers as for an id that was never a run. Everything here
// is invented.
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage, USER } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";

test("A's job's usage is answered to A; asked by B with A's run id, the answer is the same as for an id that was never a run", async () => {
  const s = (open = await stage({ files: { ".agents/keeper.md": KEEPER }, answers: [{ pieces: [{ text: "Counted seven." }], usage: { input: 100, output: 20 } }] }));

  const job = await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: "Count the bells in the tower." });
  await s.trace.seen((record) => record.event.kind === "job" && record.event.job.id === job.id && record.event.job.state === "done");

  // The job's run is the job's id: its calls and tokens are A's.
  expect(await s.harness.usage.run(USER, job.id)).toMatchObject({ run: job.id, total: { calls: 1, input: 100, output: 20 } });
  // B holding A's run id reads nothing, and no more than of an id that was never a run.
  expect(await s.harness.usage.run("second-reader", job.id)).toBeUndefined();
  expect(await s.harness.usage.run("second-reader", job.id)).toEqual(await s.harness.usage.run(USER, "never-a-run"));
});
