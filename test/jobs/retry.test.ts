// A job's model call that failed is made again as a turn's is (the owner's word of 18 Nov), and what
// a broken call wrote is never the job's report.
import { afterEach, expect, test } from "bun:test";
import type { JobView } from "../../src/contract";
import { request, type Stage, stage } from "../harness/support";
import { jobOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
const BRIEF = "Count the bells in the tower.";
const RESET = "The connection was closed or reset: The socket connection was closed unexpectedly.";
const BROKEN = { pieces: [{ text: "Counted thr" }], end: { error: RESET } };

function lastJob(s: Stage): JobView | undefined {
  return s.told.flatMap((told) => (told.kind === "job" ? [told.payload as JobView] : [])).at(-1);
}

function jobEnded(s: Stage, state: JobView["state"]): Promise<void> {
  return s.trace.seen(() => s.trace.of("job").some((record) => record.event.job.state === state));
}

test("a job's call that broke off is made again: its report is the whole answer, and the trace shows the failed try", async () => {
  const s = (open = await stage({ config: "calls:\n  retryWaitSeconds: 0\n", files: { ".agents/keeper.md": KEEPER }, answers: [BROKEN, { pieces: [{ text: "Counted three." }] }] }));

  const started = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
  await jobEnded(s, "done");

  expect(lastJob(s)).toMatchObject({ id: started.id, state: "done", report: "Counted three." });
  expect(s.model.requests).toHaveLength(2);
  expect(s.trace.of("call_failed").map((record) => [record.event.failure, record.event.retried])).toEqual([["connection", true]]);
});

test("a job whose broken call is not made again fails, its report never what the broken call wrote", async () => {
  const s = (open = await stage({ config: "calls:\n  retries: 0\n", files: { ".agents/keeper.md": KEEPER }, answers: [BROKEN] }));

  await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF });
  await jobEnded(s, "failed");

  expect(lastJob(s)?.state).toBe("failed");
  expect(lastJob(s)?.report ?? "").not.toContain("Counted thr");
  expect(s.trace.of("call_failed").map((record) => [record.event.tries, record.event.retried])).toEqual([[1, false]]);
});
