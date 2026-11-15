// What a restart does to jobs (§13.5): a job that was running is found interrupted with what it had
// said, written and spent as the process stood when it was cut off; a job that was only waiting waits
// again from its kept start. The cut-off is a second harness over the same store, found at the user's
// first call, while the first still runs: nothing it kept after the cut is the second's to read.
// Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import type { JobView } from "../../src/contract";
import { gate, scriptedModel } from "../../src/testing/rig";
import { CHAT, request, said, type Stage, stage, textOf, USER } from "../harness/support";
import { jobOf, userHarness } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo, note]\n---\nFixture keeper: you count what you are asked to count.\n";
const BRIEF = "Count the bells in the tower.";
const NOTE = {
  tier: "write" as const,
  lane: "engine",
  description: "Fixture: notes what it is told.",
  run: async () => said("Noted the count.\nIt stands in the ledger."),
};
const MORE = { call: "todo", args: { items: [{ text: "count the rest" }] } };

/** What the host was told of each job, in order. */
function toldJobs(s: Stage): JobView[] {
  return s.told.flatMap((told) => (told.kind === "job" ? [told.payload as JobView] : []));
}

/** Resolves once `count` jobs have ended in `state`, as the trace shows them. */
function jobEnded(s: Stage, state: JobView["state"], count = 1): Promise<void> {
  return s.trace.seen(() => s.trace.of("job").filter((record) => record.event.job.state === state).length >= count);
}

const NONE = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

describe("a job cut off by a restart", () => {
  test("a job stopped by a restart mid-run shows the calls and tokens it spent", async () => {
    const held = gate();
    const s = (open = await stage({
      files: { ".agents/keeper.md": KEEPER },
      tools: { note: NOTE },
      answers: [
        { pieces: [{ text: "Counted three so far." }, MORE], usage: { input: 100, output: 20 } },
        { pieces: [{ hold: held }, { text: "Never written." }] },
      ],
    }));
    const job = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    // Its second call is under way; the first has ended and been kept.
    await s.trace.seen((record) => record.event.kind === "call_started" && record.event.call === 2);
    await s.harness.jobs!.list({ user: USER });

    const { harness } = userHarness(s, {});
    try {
      // The process the job ran in is gone as far as the second one can tell: what it kept is what it spent.
      expect(await harness.jobs!.get(USER, job.id)).toMatchObject({ state: "interrupted", report: "Counted three so far.", usage: { calls: 1, input: 100, output: 20 } });
    } finally {
      held.open();
      await harness.close();
    }
  });

  test("an interrupted job lists its latest text and every write it made before the restart", async () => {
    const held = gate();
    const s = (open = await stage({
      files: { ".agents/keeper.md": KEEPER },
      tools: { note: NOTE },
      answers: [
        { pieces: [{ text: "Counted three so far." }, { call: "note" }] },
        { pieces: [{ text: "Counted five so far." }, { call: "note" }] },
        { pieces: [{ hold: held }, { text: "Never written." }] },
      ],
    }));
    const job = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.event.kind === "call_started" && record.event.call === 3);
    await s.harness.jobs!.list({ user: USER });

    const { harness } = userHarness(s, {});
    try {
      const found = await harness.jobs!.get(USER, job.id);
      expect(found).toMatchObject({ state: "interrupted", report: "Counted five so far." });
      // Each write the job made, by tool and lane, as the tool's own answer began.
      expect(found?.wrote).toEqual([
        { tool: "note", lane: "engine", line: "Noted the count." },
        { tool: "note", lane: "engine", line: "Noted the count." },
      ]);
    } finally {
      held.open();
      await harness.close();
    }
  });
});

describe("a job that was waiting", () => {
  test("a queued job found at a restart is queued again and runs when a place frees", async () => {
    const s = (open = await stage({ config: "jobs:\n  atOnce: 1\n", files: { ".agents/keeper.md": KEEPER }, tools: { note: NOTE }, answers: [] }));
    // Two jobs a process was holding for a place when it stopped: each with the start it was given.
    const waiting = (id: string, started: number, brief: string, extra: Partial<JobView> = {}): JobView => ({
      id,
      agent: "keeper",
      brief,
      state: "queued",
      scope: { user: USER, chat: CHAT, session: `job-session-${id}`, turn: "t1" },
      startedBy: "user",
      started,
      usage: NONE,
      ...extra,
    });
    await s.env.store.jobs.set({ user: USER }, waiting("waited-2", 200, "Count the lamps."));
    await s.env.store.jobs.set({ user: USER }, waiting("waited-1", 100, BRIEF, { limits: { calls: 1 }, attach: ["notes/gone.md"] }));

    const first = gate();
    const model = scriptedModel([{ pieces: [{ hold: first }, { text: "Counted seven." }, MORE] }, { pieces: [{ text: "Counted nine." }] }], { clock: s.clock });
    const { harness } = userHarness(s, { "": model });
    try {
      // The user's first call finds them: the older takes the one place, the other waits for it, and neither is told as interrupted.
      expect((await harness.jobs!.list({ user: USER })).jobs.map((job) => [job.id, job.state])).toEqual([
        ["waited-2", "queued"],
        ["waited-1", "running"],
      ]);
      expect(toldJobs(s).map((job) => [job.id, job.state])).toEqual([
        ["waited-1", "queued"],
        ["waited-1", "running"],
        ["waited-2", "queued"],
      ]);

      first.open();
      await jobEnded(s, "done", 2);
      expect(toldJobs(s).slice(3).map((job) => [job.id, job.state])).toEqual([
        ["waited-1", "done"],
        ["waited-2", "running"],
        ["waited-2", "done"],
      ]);
      // From its kept start: its brief, and the limit its start gave (one call), whose record says which.
      expect(textOf(model.requests[0]!.messages.find((message) => message.role === "user")!)).toContain(BRIEF);
      expect(textOf(model.requests[1]!.messages.find((message) => message.role === "user")!)).toContain("Count the lamps.");
      expect(await harness.jobs!.get(USER, "waited-1")).toMatchObject({ state: "done", report: "Counted seven.", limit: { limit: "calls", per: "job", max: 1, value: 1 }, limits: { calls: 1 }, attach: ["notes/gone.md"] });
      expect(await harness.jobs!.get(USER, "waited-2")).toMatchObject({ state: "done", report: "Counted nine." });
    } finally {
      first.open();
      await harness.close();
    }
  });

  test("a harness closed with a job waiting keeps it queued, and the next harness queues it again, while the one that was running stays interrupted", async () => {
    const held = gate();
    const s = (open = await stage({ config: "jobs:\n  atOnce: 1\n", files: { ".agents/keeper.md": KEEPER }, tools: { note: NOTE }, answers: [{ pieces: [{ hold: held }, { text: "Never written." }] }] }));
    const running = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    const waiting = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: "Count the lamps." }));
    expect([running.state, waiting.state]).toEqual(["running", "queued"]);
    await s.harness.close();
    expect([(await s.env.store.jobs.get({ user: USER }, running.id))?.state, (await s.env.store.jobs.get({ user: USER }, waiting.id))?.state]).toEqual(["interrupted", "queued"]);

    const { harness } = userHarness(s, { "": scriptedModel([{ pieces: [{ text: "Counted nine." }] }], { clock: s.clock }) });
    try {
      await harness.jobs!.list({ user: USER });
      await jobEnded(s, "done");

      expect(await harness.jobs!.get(USER, waiting.id)).toMatchObject({ state: "done", report: "Counted nine." });
      expect(await harness.jobs!.get(USER, running.id)).toMatchObject({ state: "interrupted" });
    } finally {
      await harness.close();
    }
  });
});
