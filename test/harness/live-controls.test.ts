// What the owner can do to a run going on (§14 Live, C-19): hold it, so every agent of it waits at
// its next call, and let it go; and say something to its main agent, which hears it at its next call.
// Both are his own presses (`live.pause`, `live.letGo`, `live.say`) and each is the trace's too.
// Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import { gate } from "../../src/testing/rig";
import { jobOf } from "../jobs/support";
import { request, type Stage, stage, textOf, USER } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [todo]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";
const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
const BRIEF = "Count the bells in the tower.";
const MORE = { call: "todo", args: { items: [{ text: "count the rest" }] } };

describe("a run the owner holds", () => {
  test("a paused job makes no further call until it is let go, and the trace shows both", async () => {
    const held = gate();
    const s = (open = await stage({
      files: { ".agents/keeper.md": KEEPER },
      answers: [{ pieces: [{ hold: held }, { text: "Counted three so far." }, MORE] }, { pieces: [{ text: "Counted seven." }] }],
    }));
    const job = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "call_started");
    const live = s.harness.live;

    expect(live.running(USER).map((view) => [view.run, view.what, view.held])).toEqual([[job.id, "job", false]]);
    // His pause, and no one else's: another user has no such run to hold.
    expect(live.pause("second-reader", job.id)).toBe(false);
    expect(live.pause(USER, job.id)).toBe(true);
    expect(live.pause(USER, job.id)).toBe(false);
    expect(live.running(USER).map((view) => view.held)).toEqual([true]);

    // The call under way ends; the next one is not made.
    held.open();
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "paused");
    expect(s.model.requests).toHaveLength(1);
    expect((await s.harness.jobs!.get(USER, job.id))?.state).toBe("running");

    expect(live.letGo("second-reader", job.id)).toBe(false);
    expect(live.letGo(USER, job.id)).toBe(true);
    expect(live.letGo(USER, job.id)).toBe(false);
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "job" && record.event.job.state === "done");
    expect(s.model.requests).toHaveLength(2);

    // The agent says it waited at its second call, and for how long it did.
    const mine = s.trace.records.filter((record) => record.run === job.id).map((record) => record.event);
    const paused = mine.findIndex((event) => event.kind === "paused");
    const resumed = mine.findIndex((event) => event.kind === "resumed");
    const second = mine.findIndex((event) => event.kind === "call_started" && event.call === 2);
    expect(paused).toBeGreaterThan(-1);
    expect(resumed).toBeGreaterThan(paused);
    expect(second).toBeGreaterThan(resumed);
    expect(mine[paused]).toMatchObject({ kind: "paused", call: 2 });
    expect(mine[resumed]).toMatchObject({ kind: "resumed", call: 2 });
  });

  test("a word said to a running turn reaches its lead's next call as the owner's, and the trace shows it", async () => {
    const held = gate();
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD },
      answers: [{ pieces: [{ hold: held }, MORE] }, { pieces: [{ text: "<reply>The door is open.</reply>" }] }],
    }));
    const turn = s.turn(request("t1", { lead: "lead" }));
    await s.trace.seen((record) => record.event.kind === "call_started");
    const [run] = s.harness.live.running(USER);
    expect(run?.what).toBe("turn");

    expect(s.harness.live.say("second-reader", run!.run, "Let her look at the door.")).toBe(false);
    expect(s.harness.live.say(USER, run!.run, "   ")).toBe(false);
    expect(s.harness.live.say(USER, run!.run, "Let her look at the door.")).toBe(true);
    held.open();
    expect((await turn).outcome.status).toBe("released");

    // Not in the first request, which was already out; in the second, as a message of its own after the lead's own work.
    const ofWords = (index: number): boolean => s.model.requests[index]!.messages.some((message) => message.role === "user" && textOf(message).includes("Let her look at the door."));
    expect([ofWords(0), ofWords(1)]).toEqual([false, true]);
    expect(s.trace.records.filter((record) => record.event.kind === "said").map((record) => ({ call: record.event.kind === "said" ? record.event.call : 0, text: record.event.kind === "said" ? record.event.text : "" }))).toEqual([{ call: 2, text: "Let her look at the door." }]);
    // Said once: a later call does not hear it again.
    expect(s.model.requests).toHaveLength(2);
  });

  test("a word said to a job's run goes to its first agent alone, and a run that is not held is never waited on", async () => {
    const held = gate();
    const s = (open = await stage({
      files: { ".agents/keeper.md": KEEPER },
      answers: [{ pieces: [{ hold: held }, MORE] }, { pieces: [{ text: "Counted seven." }] }],
    }));
    const job = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "call_started");
    expect(s.harness.live.say(USER, job.id, "Count the lamps as well.")).toBe(true);
    held.open();
    await s.trace.seen((record) => record.run === job.id && record.event.kind === "job" && record.event.job.state === "done");

    expect(s.trace.records.some((record) => record.event.kind === "paused")).toBe(false);
    expect(s.model.requests[1]!.messages.some((message) => message.role === "user" && textOf(message).includes("Count the lamps as well."))).toBe(true);
  });
});
