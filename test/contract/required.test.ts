// What a harness always has (Appendix A, C-4): `jobs` and `sessions` are members of every harness,
// whatever host it is made over, so a host offers the Jobs and Sessions pages without asking whether
// they exist. The typecheck holds the same: `Harness.jobs` and `Harness.sessions` are no longer
// optional. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { Harness } from "../../src/contract";
import { type Stage, stage, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

test("createHarness over the folder host gives jobs and sessions, each with every member of its API", async () => {
  const s = (open = await stage({ answers: [] }));
  // Typed as the contract has them: a harness without either would not compile here.
  const harness: Harness = s.harness;
  const jobs = harness.jobs;
  const sessions = harness.sessions;

  for (const member of ["list", "get", "switches", "start", "cancel", "setSwitches", "hold", "letGo", "again", "answer"] as const) expect(typeof jobs[member]).toBe("function");
  for (const member of ["open", "close", "fork", "compact", "get", "list"] as const) expect(typeof sessions[member]).toBe("function");
  expect(await jobs.list({ user: USER })).toEqual({ jobs: [] });
});
