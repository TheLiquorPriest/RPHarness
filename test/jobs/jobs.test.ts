// Jobs (§13.5), through the harness on the folder host and the scripted rig: background work an
// agent starts with `job_start`, a run of its own that outlives the turn's reply; the user's limits
// on jobs at once, in a day and per connection, and on what one job's run may spend; the host told
// of every change, so the next briefing can say a job ended; a stop of the turn that leaves a job
// running, and the host's word that cuts it off; and a restart that finds a job interrupted.
// Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRef, JobView, JsonValue, TraceRecord } from "../../src/contract";
import { createHarness } from "../../src/index";
import { type Answer, type Reply, scriptedModel } from "../../src/testing/rig";
import { gate, request, type Stage, stage, textOf, USER, WatchedSink } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [job_start]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";
const KEEPER = (model = "default") => `---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: ${model}\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n`;
const BRIEF = "Count the bells in the tower.";

/**
 * Every call's answer, by whose call it is: the keeper's (its brief is in what it was sent) or the
 * lead's, each from its own list in order, so a job's call and the lead's may come in either order.
 */
function routed(lead: Reply[], keeper: Reply[]): Answer[] {
  const route: Answer = (req) => {
    const own = req.messages.some((message) => message.role === "user" && textOf(message).includes(BRIEF)) ? keeper : lead;
    const next = own.shift();
    if (next === undefined) throw new Error("The fixture has no answer left for this call.");
    return next;
  };
  return Array.from({ length: lead.length + keeper.length }, () => route);
}

const start = (id: string): Reply => ({ pieces: [{ call: "job_start", args: { agent: "keeper", brief: BRIEF }, id }] });
const reply = (text: string): Reply => ({ pieces: [{ text: `<reply>${text}</reply>` }] });

/** What the host was told of each job, in order. */
function toldJobs(s: Stage): JobView[] {
  return s.told.flatMap((told) => (told.kind === "job" ? [told.payload as JobView] : []));
}

/** Resolves once `count` jobs have ended in `state`, as the trace shows them. */
function jobEnded(s: Stage, state: JobView["state"], count = 1): Promise<void> {
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

describe("a job an agent starts", () => {
  test("runs on after the turn's reply as a run of its own; its end is told to the host with its report, and the next briefing lays out the since-item the host gives", async () => {
    const held = gate();
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/keeper.md": KEEPER() },
      answers: routed([start("start-1"), reply("The tower is quiet."), reply("Seven bells, then.")], [{ pieces: [{ hold: held }, { text: "Fixture count: the bells number seven." }] }]),
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
    // The turn is over and its reply out; the job still runs.
    const [queued, running] = toldJobs(s);
    expect([queued?.state, running?.state]).toEqual(["queued", "running"]);
    const id = running!.id;
    expect(answerTo(s, "start-1")).toBe(`Job ${id} was started: keeper works on it in the background.`);

    held.open();
    await jobEnded(s, "done");
    const done = toldJobs(s).at(-1)!;
    expect(done).toMatchObject({ id, state: "done", agent: "keeper", brief: BRIEF, report: "Fixture count: the bells number seven.", startedBy: { definition: "lead" } });
    // Its chat and the turn that started it, in a session of its own.
    expect(done.scope).toMatchObject({ user: USER, turn: "t1" });
    expect(done.scope.session).not.toBe("s1");
    expect(await s.harness.jobs!.get(id)).toMatchObject({ state: "done", report: done.report });
    // Its run is its own, hung under the call that started it.
    const own = s.trace.records.filter((record: TraceRecord) => record.run === id);
    expect(own.find((record) => record.event.kind === "agent_started")?.parent).toEqual({ agent: (running!.startedBy as AgentRef).id, run: "t1", call: "start-1" });

    const since = `Fixture since-item: job ${id} ended. ${done.report}`;
    expect((await s.turn(request("t2", { lead: "lead", since: [{ kind: "job", text: since, turn: "t1" }] }))).outcome.status).toBe("released");
    expect(s.model.requests.at(-1)!.messages.map((message) => textOf(message)).join("\n")).toContain(since);
  });

  test("past the player's count at once a job waits for a place, and past the day's count none is started: both per connection", async () => {
    const first = gate();
    const s = (open = await stage({
      config: "jobs:\n  atOnce: 5\n  connections:\n    fixture-line: { atOnce: 1, perDay: 2 }\n",
      files: { ".agents/lead.md": LEAD, ".agents/keeper.md": KEEPER("fixture-line") },
      answers: routed([start("start-1"), start("start-2"), start("start-3"), reply("The tower is quiet.")], [{ pieces: [{ hold: first }, { text: "First count: seven." }] }, { pieces: [{ text: "Second count: seven." }] }]),
    }));

    await s.turn(request("t1", { lead: "lead" }));

    const [one, two] = [...new Set(toldJobs(s).map((job) => job.id))];
    expect(answerTo(s, "start-1")).toBe(`Job ${one} was started: keeper works on it in the background.`);
    expect(answerTo(s, "start-2")).toBe(`Job ${two} was started: keeper works on it in the background once a place is free.`);
    expect(answerTo(s, "start-3")).toBe("No job was started: 2 jobs were started today on fixture-line, and the player allows 2.");
    expect(s.trace.of("limit").map((record) => record.event.hit)).toEqual([{ limit: "jobs", per: "day", max: 2, value: 2, connection: "fixture-line" }]);
    expect(toldJobs(s).map((job) => `${job.id === one ? "one" : "two"}:${job.state}`)).toEqual(["one:queued", "one:running", "two:queued"]);

    first.open();
    await jobEnded(s, "done", 2);
    expect(toldJobs(s).slice(3).map((job) => `${job.id === one ? "one" : "two"}:${job.state}`)).toEqual(["one:done", "two:running", "two:done"]);
  });

  test("a job's run is held to the player's limits on a job: it ends at the limit with what it had written", async () => {
    const s = (open = await stage({
      config: "jobs:\n  run:\n    calls: 1\n",
      files: { ".agents/lead.md": LEAD, ".agents/keeper.md": KEEPER() },
      answers: routed([start("start-1"), reply("The tower is quiet.")], [{ pieces: [{ text: "Counted three so far." }, { call: "todo", args: { items: [{ text: "count the rest" }] } }] }]),
    }));

    await s.turn(request("t1", { lead: "lead" }));
    await jobEnded(s, "done");

    expect(toldJobs(s).at(-1)).toMatchObject({ state: "done", report: "Counted three so far.", limit: { limit: "calls", per: "job", max: 1, value: 1 } });
  });
});

describe("what stops a job", () => {
  test("a stop of the turn leaves its job running; the host saying the turn left the path cuts it off, and the player's cancel stops another", async () => {
    const leadHeld = gate();
    const never = gate();
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/keeper.md": KEEPER() },
      answers: routed([start("start-1"), start("start-2"), { pieces: [{ hold: leadHeld }, { text: "<reply>Too late.</reply>" }] }], [{ pieces: [{ hold: never }, { text: "Never written." }] }, { pieces: [{ hold: never }, { text: "Never written." }] }]),
    }));
    const stop = new AbortController();
    const sink = new WatchedSink(s.clock);
    const turn = s.turn(request("t1", { lead: "lead" }), sink, stop.signal);
    await s.trace.seen(() => toldJobs(s).filter((job) => job.state === "running").length === 2);
    stop.abort();
    expect((await turn).outcome.status).toBe("stopped");
    const [one, two] = [...new Set(toldJobs(s).map((job) => job.id))];
    expect((await s.harness.jobs!.get(one!))?.state).toBe("running");

    expect((await s.harness.jobs!.cancel(two!))?.state).toBe("cancelled");
    await s.harness.turnLeft(request("t1").scope);
    expect((await s.harness.jobs!.get(one!))?.state).toBe("off-path");
    expect(toldJobs(s).filter((job) => job.ended !== undefined).map((job) => [job.id === one ? "one" : "two", job.state])).toEqual([
      ["two", "cancelled"],
      ["one", "off-path"],
    ]);
  });

  test("a restart: a job running when the harness closes is kept as interrupted with what it had done, and one a crash left under way is found interrupted and told", async () => {
    const held = gate();
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/keeper.md": KEEPER() },
      answers: routed([start("start-1"), reply("The tower is quiet.")], [{ pieces: [{ text: "Counted three so far." }, { call: "todo", args: { items: [{ text: "count the rest" }] } }] }, { pieces: [{ hold: held }, { text: "Never written." }] }]),
    }));
    await s.turn(request("t1", { lead: "lead" }));
    await s.trace.seen((record) => record.event.kind === "tool_ended" && record.event.tool === "todo");
    const id = toldJobs(s)[0]!.id;
    await s.harness.close();
    expect(await s.harness.jobs!.get(id)).toMatchObject({ state: "interrupted", report: "Counted three so far." });

    // A process that ended without closing left a job kept as running.
    const crashed = { ...toldJobs(s)[0]!, id: "crashed-1", state: "running" as const, report: "Half the ledger read." };
    await s.env.store.set("jobs/all/crashed-1", crashed as unknown as JsonValue);
    const again = createHarness(s.env, { models: { agentModel: async () => scriptedModel([], { clock: s.clock }).agentModel() }, ids: () => "again" });
    try {
      expect(await again.jobs!.get("crashed-1")).toMatchObject({ state: "interrupted", report: "Half the ledger read." });
      expect(toldJobs(s).at(-1)).toMatchObject({ id: "crashed-1", state: "interrupted" });
      expect((await again.jobs!.list({ user: USER, states: ["interrupted"] })).map((job) => job.id).sort()).toEqual(["crashed-1", id].sort());
    } finally {
      await again.close();
    }
  });
});
