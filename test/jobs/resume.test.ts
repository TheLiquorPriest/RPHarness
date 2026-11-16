// A job carried on (§13.5): one that stopped at its own limit is given more by the owner and goes on
// from its own session where it stood, its earlier call and answer read back, told it was given more.
// Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage, textOf, USER } from "../harness/support";
import { jobOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";

test("a job stopped at its call limit, given more calls, carries on from its last call", async () => {
  const s = (open = await stage({
    files: { ".agents/keeper.md": KEEPER },
    answers: [{ pieces: [{ call: "todo", args: { items: [{ text: "count the bells", done: false }] }, id: "c-1" }] }, { pieces: [{ text: "Seven bells." }] }],
  }));
  const ended = (count: number) => s.trace.seen(() => s.trace.of("job").filter((record) => record.event.job.state === "done").length >= count);

  const job = jobOf(await s.harness.jobs.start(request("t1").scope, { agent: "keeper", brief: "Count the bells.", limits: { calls: 1 } }));
  await ended(1);
  const stopped = await s.harness.jobs.get(USER, job.id);
  expect(stopped?.limit?.limit).toBe("calls");

  const carried = jobOf(await s.harness.jobs.carryOn(USER, job.id, { calls: 2 }));
  expect(carried.id).toBe(job.id);
  await ended(2);

  const done = await s.harness.jobs.get(USER, job.id);
  expect(done).toMatchObject({ state: "done", report: "Seven bells.", more: { calls: 2 } });
  expect(done?.limit).toBeUndefined();
  // Its second call read back its first, and what came back to it, then the line it goes on under.
  const second = s.model.requests[1]!.messages;
  expect(second.some((message) => message.role === "toolResult" && message.toolCallId === "c-1")).toBe(true);
  expect(second.at(-1)?.role).toBe("user");
  expect(textOf(second.at(-1)!)).not.toBe("");
});
