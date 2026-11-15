// The owner's controls over jobs (§13.5, §12, R-31; C-5): jobs switched off, all jobs held, one job
// that waits held, a job that asks at the point its start named, an interrupted job started again,
// and the limits of his own start standing in place of the settings'. Each is his own press, kept
// in the host's store or the job's record so a restart keeps it. Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import type { JobView } from "../../src/contract";
import { type Answer, gate, scriptedModel, type Reply } from "../../src/testing/rig";
import { request, type Stage, stage, textOf, USER } from "../harness/support";
import { jobOf, userHarness } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [job_start]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";
const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
const FILES = { ".agents/keeper.md": KEEPER, ".agents/lead.md": LEAD };
const BRIEF = "Count the bells in the tower.";
const OTHER_BRIEF = "Count the lamps on the quay.";
const MORE = { call: "todo", args: { items: [{ text: "count the rest" }] } };

/** Every call's answer, by whose call it is: each of `keepers`' briefs has its own list, in order, and every other call is the lead's. */
function routed(lead: Reply[], keepers: Record<string, Reply[]>): Answer[] {
  const lists = new Map(Object.entries(keepers));
  const route: Answer = (req) => {
    const user = req.messages.filter((message) => message.role === "user").map(textOf).join("\n");
    const own = [...lists].find(([brief]) => user.includes(brief))?.[1] ?? lead;
    const next = own.shift();
    if (next === undefined) throw new Error("The fixture has no answer left for this call.");
    return next;
  };
  const count = lead.length + Object.values(keepers).reduce((total, list) => total + list.length, 0);
  return Array.from({ length: count }, () => route);
}

/** What the host was told of each job, in order. */
function toldJobs(s: Stage): JobView[] {
  return s.told.flatMap((told) => (told.kind === "job" ? [told.payload as JobView] : []));
}

/** Resolves once `count` jobs have been traced in `state`. */
function jobIn(s: Stage, state: JobView["state"], count = 1): Promise<void> {
  return s.trace.seen(() => s.trace.of("job").filter((record) => record.event.job.state === state).length >= count);
}

/** The answer a call got, as the model read it in a later request. */
function answerTo(s: Stage, callId: string): string {
  for (const req of s.model.requests) {
    const found = req.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    if (found !== undefined) return textOf(found);
  }
  return "";
}

describe("jobs the owner switches off or holds", () => {
  test("jobs off: job_start answers that none may start, so does his own start, and the switch holds across a restart", async () => {
    const s = (open = await stage({
      files: FILES,
      answers: routed([{ pieces: [{ call: "job_start", args: { agent: "keeper", brief: BRIEF }, id: "start-1" }] }, { pieces: [{ text: "<reply>No job, then.</reply>" }] }], {}),
    }));
    expect(await s.harness.jobs!.switches(USER)).toEqual({ off: false, held: false });
    expect(await s.harness.jobs!.setSwitches(USER, { off: true })).toEqual({ off: true, held: false });

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
    expect(answerTo(s, "start-1")).toBe("No job was started: the player has switched jobs off.");
    expect(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF })).toEqual({ refused: "off" });
    expect(toldJobs(s)).toEqual([]);

    // A second harness over the same store keeps the switch, and lets it go on his word.
    await s.harness.close();
    const { harness } = userHarness(s, {});
    try {
      expect(await harness.jobs!.switches(USER)).toEqual({ off: true, held: false });
      expect(await harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF })).toEqual({ refused: "off" });
      expect(await harness.jobs!.setSwitches(USER, { off: false })).toEqual({ off: false, held: false });
      expect(await harness.jobs!.switches(USER)).toEqual({ off: false, held: false });
    } finally {
      await harness.close();
    }
  });

  test("held: a running job makes no further call until let go, none starts meanwhile, and both then go on", async () => {
    const first = gate();
    const s = (open = await stage({
      files: FILES,
      answers: routed([], { [BRIEF]: [{ pieces: [{ hold: first }, { text: "Counted three so far." }, MORE] }, { pieces: [{ text: "Counted seven." }] }], [OTHER_BRIEF]: [{ pieces: [{ text: "Counted nine." }] }] }),
    }));
    const running = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.run === running.id && record.event.kind === "call_started");

    expect(await s.harness.jobs!.setSwitches(USER, { held: true })).toEqual({ off: false, held: true });
    expect(s.harness.live.running(USER).map((view) => view.held)).toEqual([true]);
    // Started while all are held, a job waits.
    const waiting = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: OTHER_BRIEF }));
    expect(waiting.state).toBe("queued");

    first.open();
    await s.trace.seen((record) => record.run === running.id && record.event.kind === "paused");
    expect(s.model.requests).toHaveLength(1);
    expect((await s.harness.jobs!.get(USER, running.id))?.state).toBe("running");
    expect((await s.harness.jobs!.get(USER, waiting.id))?.state).toBe("queued");

    await s.harness.jobs!.setSwitches(USER, { held: false });
    await jobIn(s, "done", 2);
    expect(await s.harness.jobs!.get(USER, running.id)).toMatchObject({ state: "done", report: "Counted seven." });
    expect(await s.harness.jobs!.get(USER, waiting.id)).toMatchObject({ state: "done", report: "Counted nine." });
  });

  test("held: a job started while all are held waits through a restart, and runs when he lets them go", async () => {
    const s = (open = await stage({ files: FILES, answers: [] }));
    await s.harness.jobs!.setSwitches(USER, { held: true });
    const waiting = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    expect(waiting.state).toBe("queued");
    await s.harness.close();

    const { harness } = userHarness(s, { "": scriptedModel([{ pieces: [{ text: "Counted seven." }] }], { clock: s.clock }) });
    try {
      expect(await harness.jobs!.switches(USER)).toEqual({ off: false, held: true });
      // Found again at his first call, it keeps its place and does not run.
      expect((await harness.jobs!.list({ user: USER })).jobs.map((job) => [job.id, job.state])).toEqual([[waiting.id, "queued"]]);
      expect(toldJobs(s).some((job) => job.state === "running")).toBe(false);

      await harness.jobs!.setSwitches(USER, { held: false });
      await jobIn(s, "done");
      expect(await harness.jobs!.get(USER, waiting.id)).toMatchObject({ state: "done", report: "Counted seven." });
    } finally {
      await harness.close();
    }
  });

  test("a job's time limit does not run while the owner holds it", async () => {
    const first = gate();
    const s = (open = await stage({
      config: "jobs:\n  run:\n    time: 10\n",
      files: FILES,
      answers: [{ pieces: [{ hold: first }, { text: "Counted three so far." }, MORE] }, { pieces: [{ wait: 60_000 }, { text: "Counted seven." }] }],
    }));
    const job = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "call_started");

    s.harness.live.pause(USER, job.id);
    s.clock.advance(120_000);
    first.open();
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "paused");
    expect((await s.harness.jobs!.get(USER, job.id))?.state).toBe("running");

    // Let go, it has its ten seconds still; its second call needs sixty.
    s.harness.live.letGo(USER, job.id);
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "call_started" && record.event.call === 2);
    s.clock.advance(9_000);
    expect((await s.harness.jobs!.get(USER, job.id))?.state).toBe("running");
    s.clock.advance(2_000);
    await jobIn(s, "done");
    expect(toldJobs(s).at(-1)).toMatchObject({ state: "done", report: "Counted three so far.", limit: { limit: "time", per: "job", max: 10_000, value: 10_000 } });
  });
});

describe("a job that waits, held", () => {
  test("it keeps its place and does not start until let go; a job that is not waiting cannot be held", async () => {
    const first = gate();
    const s = (open = await stage({
      config: "jobs:\n  atOnce: 1\n",
      files: FILES,
      answers: routed([], { [BRIEF]: [{ pieces: [{ hold: first }, { text: "Counted seven." }] }], [OTHER_BRIEF]: [{ pieces: [{ text: "Counted nine." }] }] }),
    }));
    const running = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    const waiting = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: OTHER_BRIEF }));
    expect([running.state, waiting.state]).toEqual(["running", "queued"]);

    expect(await s.harness.jobs!.hold(USER, running.id)).toEqual({ refused: "state", id: running.id, state: "running", applies: ["queued"] });
    expect(await s.harness.jobs!.hold(USER, "no-such-job")).toEqual({ refused: "no-job", id: "no-such-job" });
    expect(await s.harness.jobs!.hold(USER, waiting.id)).toMatchObject({ id: waiting.id, state: "held" });
    expect(await s.harness.jobs!.letGo(USER, running.id)).toEqual({ refused: "state", id: running.id, state: "running", applies: ["held"] });

    // The place is free, and it is held: it does not take it.
    first.open();
    await jobIn(s, "done");
    await s.clock.idle();
    expect((await s.harness.jobs!.get(USER, waiting.id))?.state).toBe("held");
    expect(s.model.requests).toHaveLength(1);

    expect(await s.harness.jobs!.letGo(USER, waiting.id)).toMatchObject({ id: waiting.id, state: expect.stringMatching(/^(queued|running)$/) });
    await jobIn(s, "done", 2);
    expect(await s.harness.jobs!.get(USER, waiting.id)).toMatchObject({ state: "done", report: "Counted nine." });
  });

  test("a job held while it waits is held again after a restart", async () => {
    const first = gate();
    const s = (open = await stage({ config: "jobs:\n  atOnce: 1\n", files: FILES, answers: routed([], { [BRIEF]: [{ pieces: [{ hold: first }, { text: "Never written." }] }] }) }));
    jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    const waiting = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: OTHER_BRIEF }));
    await s.harness.jobs!.hold(USER, waiting.id);
    await s.harness.close();
    first.open();

    const { harness } = userHarness(s, { "": scriptedModel([{ pieces: [{ text: "Counted nine." }] }], { clock: s.clock }) });
    try {
      expect((await harness.jobs!.get(USER, waiting.id))?.state).toBe("held");
      await s.clock.idle();
      expect((await harness.jobs!.get(USER, waiting.id))?.state).toBe("held");
      await harness.jobs!.letGo(USER, waiting.id);
      await jobIn(s, "done");
      expect(await harness.jobs!.get(USER, waiting.id)).toMatchObject({ state: "done", report: "Counted nine." });
    } finally {
      await harness.close();
    }
  });
});

describe("a job that asks at a point", () => {
  /** A call that sends 900 tokens and writes 200: 1,100 together. */
  const BIG = (...more: Reply["pieces"][number][]): Reply => ({ pieces: [{ text: "Counted three so far." }, ...more], usage: { input: 900, output: 200 } });

  test("a job with an ask point of 1,000 that passes it is asking, not done; going on resumes the same session", async () => {
    const s = (open = await stage({ files: FILES, answers: [BIG(MORE), { pieces: [{ text: "Counted seven." }], usage: { input: 50, output: 10 } }] }));
    const job = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF, limits: { askAt: 1_000 } }));
    await jobIn(s, "asking");
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "paused");

    // Held, not ended; the host was told, with the count; no second call was made.
    expect(await s.harness.jobs!.get(USER, job.id)).toMatchObject({ state: "asking", asks: { at: 1_000, tokens: 1_100 }, report: "Counted three so far." });
    expect(toldJobs(s).at(-1)).toMatchObject({ id: job.id, state: "asking", asks: { at: 1_000, tokens: 1_100 } });
    expect(s.harness.live.running(USER).map((view) => view.held)).toEqual([true]);
    expect(s.model.requests).toHaveLength(1);
    // The answer applies to a job that asks, and to nothing else.
    expect(await s.harness.jobs!.answer(USER, job.id, { go: "on", askAt: 0 })).toEqual({ refused: "limit", limit: "askAt", value: 0 });

    expect(await s.harness.jobs!.answer(USER, job.id, { go: "on" })).toMatchObject({ id: job.id, state: "running" });
    await jobIn(s, "done");
    expect(await s.harness.jobs!.get(USER, job.id)).toMatchObject({ state: "done", report: "Counted seven." });
    expect((await s.harness.jobs!.get(USER, job.id))?.asks).toBeUndefined();
    // The same session: its second request carries what the first did.
    expect(s.model.requests).toHaveLength(2);
    expect(s.model.requests[1]!.messages.some((message) => textOf(message).includes("Counted three so far."))).toBe(true);
    expect(await s.harness.jobs!.answer(USER, job.id, { go: "end" })).toEqual({ refused: "state", id: job.id, state: "done", applies: ["asking"] });
  });

  test("ending it gives done with its report, and a new ask point asks again further on", async () => {
    const s = (open = await stage({
      files: FILES,
      answers: [BIG(MORE), { pieces: [{ text: "Counted five so far." }, MORE], usage: { input: 300, output: 10 } }, { pieces: [{ text: "Counted seven." }], usage: { input: 10, output: 10 } }],
    }));
    const job = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF, limits: { askAt: 1_000 } }));
    await jobIn(s, "asking");

    // Gone on with another point: it asks again once it has spent past it.
    expect(await s.harness.jobs!.answer(USER, job.id, { go: "on", askAt: 1_200 })).toMatchObject({ state: "running", limits: { askAt: 1_200 } });
    await jobIn(s, "asking", 2);
    expect(await s.harness.jobs!.get(USER, job.id)).toMatchObject({ state: "asking", asks: { at: 1_200, tokens: 1_410 }, report: "Counted five so far." });

    // Ended, it has the report it had written.
    expect(await s.harness.jobs!.answer(USER, job.id, { go: "end" })).toMatchObject({ id: job.id, state: "done", report: "Counted five so far." });
    expect((await s.harness.jobs!.get(USER, job.id))?.asks).toBeUndefined();
    expect(s.model.requests).toHaveLength(2);
    expect(s.harness.live.running(USER)).toEqual([]);
  });
});

describe("a job started again", () => {
  test("an interrupted job started again runs the same brief with the same limits and names the first", async () => {
    const stuck = gate();
    const s = (open = await stage({ files: FILES, answers: [{ pieces: [{ hold: stuck }, { text: "Never written." }] }] }));
    const first = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF, limits: { calls: 3 } }));
    await s.trace.seen((record) => record.run === first.id && record.event.kind === "call_started");
    await s.harness.jobs!.list({ user: USER });

    const { harness } = userHarness(s, { "": scriptedModel([{ pieces: [{ text: "Counted seven." }] }], { clock: s.clock }) });
    try {
      // What a restart cut off is found interrupted, and he starts it again.
      expect((await harness.jobs!.get(USER, first.id))?.state).toBe("interrupted");
      const again = jobOf(await harness.jobs!.again(USER, first.id));
      expect(again).toMatchObject({ agent: "keeper", brief: BRIEF, limits: { calls: 3 }, repeats: first.id, startedBy: "user", scope: { user: USER, chat: first.scope.chat } });
      expect(again.id).not.toBe(first.id);
      expect(again.scope.turn).toBeUndefined();
      await jobIn(s, "done");
      expect(await harness.jobs!.get(USER, again.id)).toMatchObject({ state: "done", report: "Counted seven.", repeats: first.id });

      // The first is as it was; one that is done, running or unknown cannot be started again.
      expect((await harness.jobs!.get(USER, first.id))?.state).toBe("interrupted");
      expect(await harness.jobs!.again(USER, again.id)).toEqual({ refused: "state", id: again.id, state: "done", applies: ["interrupted", "failed", "cancelled"] });
      expect(await harness.jobs!.again(USER, "no-such-job")).toEqual({ refused: "no-job", id: "no-such-job" });
    } finally {
      stuck.open();
      await harness.close();
    }
  });

  test("a cancelled job can be started again, and not while jobs are switched off", async () => {
    const stuck = gate();
    const s = (open = await stage({ files: FILES, answers: [{ pieces: [{ hold: stuck }, { text: "Never written." }] }, { pieces: [{ text: "Counted seven." }] }] }));
    const first = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.run === first.id && record.event.kind === "call_started");
    await s.harness.jobs!.cancel(USER, first.id);
    stuck.open();
    expect((await s.harness.jobs!.get(USER, first.id))?.state).toBe("cancelled");

    await s.harness.jobs!.setSwitches(USER, { off: true });
    expect(await s.harness.jobs!.again(USER, first.id)).toEqual({ refused: "off" });
    await s.harness.jobs!.setSwitches(USER, { off: false });
    const again = jobOf(await s.harness.jobs!.again(USER, first.id));
    expect(again.repeats).toBe(first.id);
    await jobIn(s, "done");
    expect(await s.harness.jobs!.get(USER, again.id)).toMatchObject({ state: "done", report: "Counted seven." });
  });
});

describe("the limits of the owner's own start", () => {
  const KEPT: JobView = {
    id: "kept-by-agent",
    agent: "keeper",
    brief: BRIEF,
    state: "queued",
    scope: { user: USER, chat: "lighthouse", session: "job-session-kept", turn: "t1" },
    startedBy: { id: "agent-1", definition: "lead" },
    started: 100,
    usage: { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    limits: { calls: 5, time: 3_600 },
  };

  test("a job the owner starts with 5 calls and an hour runs past jobs.run's 1 call and 5 seconds; a job an agent started is held to them", async () => {
    const s = (open = await stage({
      config: "jobs:\n  run:\n    calls: 1\n    time: 5\n",
      files: FILES,
      answers: [
        // The owner's own start: three calls, the second waits ten seconds of the clock.
        { pieces: [{ text: "Counted three so far." }, MORE] },
        { pieces: [{ wait: 10_000 }, { text: "Counted five so far." }, MORE] },
        { pieces: [{ text: "Counted seven." }] },
        // The job an agent started, found queued by a restart: held to the setting's one call.
        { pieces: [{ text: "Counted nine so far." }, MORE] },
      ],
    }));
    const owners = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF, limits: { calls: 5, time: 3_600 } }));
    await s.trace.seen((record) => record.run === owners.id && record.event.kind === "call_started" && record.event.call === 2);
    s.clock.advance(10_000);
    await jobIn(s, "done");
    expect(await s.harness.jobs!.get(USER, owners.id)).toMatchObject({ state: "done", report: "Counted seven.", usage: { calls: 3 } });
    expect((await s.harness.jobs!.get(USER, owners.id))?.limit).toBeUndefined();

    // A start by an agent that carries limits of its own is made only tighter by them, never looser.
    await s.env.store.jobs.set({ user: USER }, KEPT);
    const { harness } = userHarness(s, { "": scriptedModel([{ pieces: [{ text: "Counted nine so far." }, MORE] }, { pieces: [{ text: "Never written." }] }], { clock: s.clock }) });
    try {
      await harness.jobs!.list({ user: USER });
      await jobIn(s, "done", 2);
      expect(await harness.jobs!.get(USER, KEPT.id)).toMatchObject({ state: "done", report: "Counted nine so far.", limit: { limit: "calls", per: "job", max: 1, value: 1 } });
    } finally {
      await harness.close();
    }
  });

  test("a limit that is not a whole number above 0 is refused with the limit and its value, and starts nothing", async () => {
    const s = (open = await stage({ files: FILES, answers: [] }));
    expect(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF, limits: { calls: 5, askAt: 1.5 } })).toEqual({ refused: "limit", limit: "askAt", value: 1.5 });
    expect(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF, limits: { time: 0 } })).toEqual({ refused: "limit", limit: "time", value: 0 });
    expect(await s.harness.jobs!.start(request("t1").scope, { agent: "nobody", brief: BRIEF })).toEqual({ refused: "agent", agent: "nobody" });
    expect(toldJobs(s)).toEqual([]);
  });
});
