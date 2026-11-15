// The live view's hub sends each listener its items off the runs' way (§5.6): the trace has every
// record the moment the run makes it, each listener is sent its own queue in turn, one that throws is
// logged once with what it follows, and one that falls behind past the setting `live.backlog` of a
// run whose items fill its queue is cut off, logged, and told how far behind it was (C29). Each run
// hands the hub the setting it read itself, so a listener following two runs is held to each one's,
// and a change to the chat's file is taken by the next turn with nothing restarted. Everything here
// is invented.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, LiveItem, Log, Scope } from "../../src/contract";
import { LiveHub } from "../../src/harness/live";
import { RunTrace } from "../../src/loop";
import { FakeClock, gate, TraceRecorder } from "../loop/support";
import type { Answer, Reply } from "../../src/testing/rig";
import { CHARACTER, CHAT, request, type Stage, stage, textOf, USER } from "./support";

const TURN: Scope = { user: "ana", chat: "harbour", session: "s1", turn: "t1" };
const JOB: Scope = { user: "ana", chat: "harbour", session: "s1" };
const lead = { id: "lead-1", definition: "lead" };

type Line = { level: string; message: string; fields?: Record<string, JsonValue> };

function recordingLog(lines: Line[]): Log {
  const line =
    (level: string) =>
    (message: string, fields?: Record<string, JsonValue>): void => {
      lines.push({ level, message, ...(fields !== undefined ? { fields } : {}) });
    };
  return { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") };
}

/** Lets every item already given to the hub reach its listeners: it sends them in the microtasks that follow the run's own step. */
function drained(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** One step of a run: an event its trace writes. */
function step(trace: RunTrace, text: string): void {
  trace.event(lead, undefined, { kind: "todo", items: [{ text, done: false }] });
}

/** The step each event item a listener was sent is of; a cut item as itself. */
function steps(items: readonly LiveItem[]): (string | LiveItem)[] {
  return items.map((item) => (item.type === "event" && item.record.event.kind === "todo" ? (item.record.event.items[0]?.text ?? "") : item));
}

const cutLines = (lines: readonly Line[]): Line[] => lines.filter((line) => line.message.startsWith("A live listener fell behind"));

describe("the live hub", () => {
  test("a listener that throws and one that stalls: every record reaches the trace as the run writes it, and the other listener in time; the log names the one that throws, once, and the stalled one is cut off past the run's setting and told how far behind it was", async () => {
    const lines: Line[] = [];
    const hub = new LiveHub({ log: recordingLog(lines) });
    const recorder = new TraceRecorder();
    const trace = new RunTrace(hub.tee(recorder, TURN, () => 3), TURN, "t1", new FakeClock());
    hub.subscribe({ user: "ana", chat: "harbour" }, () => {
      throw new Error("Fixture: the page broke.");
    });
    const never = gate();
    const stalled: LiveItem[] = [];
    hub.subscribe({ user: "ana", run: "t1" }, (item) => {
      stalled.push(item);
      return never.opened;
    });
    const heard: LiveItem[] = [];
    hub.subscribe({ user: "ana" }, (item) => {
      heard.push(item);
    });

    for (let n = 1; n <= 6; n += 1) {
      step(trace, `step ${n}`);
      // The trace has the record at once, and no listener has run on the run's way.
      expect([recorder.records.length, heard.length]).toEqual([n, n - 1]);
      await drained();
      expect(heard.length).toBe(n);
    }

    expect(steps(heard)).toEqual(["step 1", "step 2", "step 3", "step 4", "step 5", "step 6"]);
    expect(lines.filter((line) => line.message.startsWith("A live listener threw"))).toEqual([{ level: "warn", message: "A live listener threw; it goes on being sent the items of the runs it follows.", fields: { user: "ana", chat: "harbour", error: "Fixture: the page broke." } }]);
    // It took step 1 and never let go of it; steps 2 to 4 waited for it, and step 5 was one more than the run's setting allows.
    expect(steps(stalled)).toEqual(["step 1", { type: "cut", behind: 4 }]);
    expect(cutLines(lines)).toEqual([{ level: "warn", message: "A live listener fell behind and was cut off: it had not taken more of a run's items than live.backlog allows.", fields: { user: "ana", run: "t1", cutAt: "t1", behind: 4, backlog: 3 } }]);
  });

  test("a listener that returns a promise is sent its next item only once that promise settles, in order", async () => {
    const hub = new LiveHub();
    const trace = new RunTrace(hub.tee(new TraceRecorder(), TURN, () => 10), TURN, "t1", new FakeClock());
    const first = gate();
    const taken: string[] = [];
    hub.subscribe({ user: "ana" }, async (item) => {
      taken.push(String(steps([item])[0]));
      if (taken.length === 1) await first.opened;
    });

    step(trace, "step 1");
    step(trace, "step 2");
    step(trace, "step 3");
    await drained();
    expect(taken).toEqual(["step 1"]);

    first.open();
    await drained();
    expect(taken).toEqual(["step 1", "step 2", "step 3"]);
  });

  test("a listener following a turn and a job at once is held to each run's own setting for that run's items", async () => {
    const lines: Line[] = [];
    const hub = new LiveHub({ log: recordingLog(lines) });
    const recorder = new TraceRecorder();
    const clock = new FakeClock();
    const turn = new RunTrace(hub.tee(recorder, TURN, () => 2), TURN, "t1", clock);
    const job = new RunTrace(hub.tee(recorder, JOB, () => 4), JOB, "j1", clock);
    const never = gate();
    const stalled: LiveItem[] = [];
    hub.subscribe({ user: "ana", chat: "harbour" }, (item) => {
      stalled.push(item);
      return never.opened;
    });

    step(turn, "turn 1");
    await drained();
    for (let n = 1; n <= 4; n += 1) step(job, `job ${n}`);
    step(turn, "turn 2");
    step(turn, "turn 3");
    await drained();
    // Six not taken: more than either run's setting, but the job's four and the turn's two are each within their own run's.
    expect(steps(stalled)).toEqual(["turn 1"]);
    expect(cutLines(lines)).toEqual([]);

    step(turn, "turn 4");
    await drained();
    expect(steps(stalled)).toEqual(["turn 1", { type: "cut", behind: 7 }]);
    expect(cutLines(lines).map((line) => line.fields)).toEqual([{ user: "ana", chat: "harbour", cutAt: "t1", behind: 7, backlog: 2 }]);
  });
});

describe("the setting, as each run reads it", () => {
  let open: Stage | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  const REPLY = { pieces: [{ text: "<intent>Short.</intent><reply>The lamp gutters.</reply>" }] };
  const CHAT_FILE = "chats/" + CHARACTER + "/" + CHAT + "/config.yml";

  test("live.backlog set in the chat's file holds a turn's listeners to it, and a change to the file is taken by the next turn, with nothing restarted", async () => {
    const s = (open = await stage({ drafted: true, files: { [CHAT_FILE]: "live:\n  backlog: 2\n" }, answers: [REPLY, REPLY] }));
    const never = gate();
    const follows = { user: USER, chat: CHAT };
    const firstPage: LiveItem[] = [];
    s.harness.live.subscribe(follows, (item) => {
      firstPage.push(item);
      return never.opened;
    });

    expect((await s.turn(request("t1"))).outcome.status).toBe("released");
    await drained();
    expect(firstPage.at(-1)).toEqual({ type: "cut", behind: 3 });
    expect(cutLines(s.logged).map((line) => line.fields?.["backlog"])).toEqual([2]);

    await writeFile(join(s.dir, "files", CHAT_FILE), "live:\n  backlog: 1000\n", "utf8");
    const secondPage: LiveItem[] = [];
    s.harness.live.subscribe(follows, (item) => {
      secondPage.push(item);
      return never.opened;
    });

    expect((await s.turn(request("t2"))).outcome.status).toBe("released");
    await drained();
    // It took the turn's first item and stalls there, holding back the rest, but the new setting leaves it room: it is not cut off.
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]?.type).toBe("event");
    expect(cutLines(s.logged)).toHaveLength(1);
  });

  test("a job's items are held to the setting the job read for itself", async () => {
    const BRIEF = "Count the bells in the tower.";
    const lead = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [job_start]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";
    const keeper = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
    const leadAnswers: Reply[] = [{ pieces: [{ call: "job_start", args: { agent: "keeper", brief: BRIEF }, id: "start-1" }] }, { pieces: [{ text: "<reply>The tower is quiet.</reply>" }] }];
    const held = gate();
    const keeperAnswers: Reply[] = [{ pieces: [{ hold: held }, { text: "Fixture count: " }, { text: "the bells " }, { text: "number seven." }] }];
    // Each call's answer from the list of whoever makes it: the keeper's call carries its brief.
    const route: Answer = (req) => {
      const own = req.messages.some((message) => message.role === "user" && textOf(message).includes(BRIEF)) ? keeperAnswers : leadAnswers;
      const next = own.shift();
      if (next === undefined) throw new Error("The fixture has no answer left for this call.");
      return next;
    };
    const s = (open = await stage({ files: { [CHAT_FILE]: "live:\n  backlog: 2\n", ".agents/lead.md": lead, ".agents/keeper.md": keeper }, answers: [route, route, route] }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
    // The turn is over and the job runs on, held: a page that follows the chat from now hears the job's items alone.
    const job = s.trace.records.find((record) => record.event.kind === "run_started" && record.event.run === "job")?.run;
    const never = gate();
    const page: LiveItem[] = [];
    s.harness.live.subscribe({ user: USER, chat: CHAT }, (item) => {
      page.push(item);
      return never.opened;
    });

    held.open();
    await s.trace.seen(() => s.trace.records.some((record) => record.event.kind === "job" && record.event.job.state === "done"));
    await drained();
    expect(page.at(-1)).toEqual({ type: "cut", behind: 3 });
    expect(cutLines(s.logged).map((line) => line.fields)).toEqual([{ user: USER, chat: CHAT, cutAt: job ?? "", behind: 3, backlog: 2 }]);
  });
});
