// Usage and the live view (§13.4, Appendix A `UsageApi`, `LiveApi`): a sub-agent's calls are
// counted and shown under its own name, in the shapes the harness publishes for every agent: the
// run's usage by agent, the day's total, its window gauge, the live run's agents and its events
// and text as they come, and the progress lines its work brings. Then the day (§10.11 daily caps,
// a day being the last 24 hours): every call counts in the store as it ends, a book made again over
// the same store holds what ended, older day records count once, and a finished run's usage is kept
// in the store for as many runs as the user's setting says.
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRef, JsonValue, LiveItem, StorePort, TraceEvent, Usage } from "../../src/contract";
import { UsageBook } from "../../src/harness/usage";
import { Budget, emptyUsage } from "../../src/loop";
import { FakeClock } from "../../src/testing/rig/clock";
import { configFiles } from "../model/support";
import { CHAT, definition, PROGRESS, said, type Stage, stage, USER } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = definition("lead", { model: "lead-model", tools: ["delegate"] }, "Fixture lead: you run the turn.");
const GM = definition("gm", { model: "gm-model", tools: ["roll"] }, "Fixture GM.");

test("a sub-agent's calls are counted and shown under its own name", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM, ".prompts/progress.md": PROGRESS },
    tools: { roll: { tier: "read", description: "Fixture: rolls dice.", run: async () => said("4") } },
    models: {
      "lead-model": [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-1" }], usage: { input: 1_000, output: 50 } },
        { pieces: [{ text: "Settled." }], usage: { input: 1_200, output: 20 } },
      ],
      "gm-model": [
        { pieces: [{ text: "Rolling." }, { call: "roll" }], usage: { input: 300, output: 15 } },
        { pieces: [{ text: "A four: the jump fails." }], usage: { input: 340, cacheRead: 300, output: 12 } },
      ],
    },
  }));
  const items: LiveItem[] = [];
  s.hub.subscribe({ user: USER, chat: CHAT }, (item) => items.push(item));

  const turn = await s.play("She leaps for the far ledge.");
  await turn.done;
  await s.usage.settled();

  const gm = { id: "gm-1", definition: "gm", parent: turn.lead.id };
  const gmUsage = { calls: 2, input: 940, cacheRead: 300, cacheWrite: 0, output: 27 };
  const leadUsage = { calls: 2, input: 2_200, cacheRead: 0, cacheWrite: 0, output: 70 };
  // The run's usage, by agent, and its total; the user's day counts both.
  expect(await s.usage.run(USER, "t1")).toEqual({
    run: "t1",
    total: { calls: 4, input: 3_140, cacheRead: 300, cacheWrite: 0, output: 97 },
    agents: [
      { agent: gm, usage: gmUsage },
      { agent: turn.lead, usage: leadUsage },
    ],
  });
  expect(await s.usage.day(USER)).toEqual({ calls: 4, input: 3_140, cacheRead: 300, cacheWrite: 0, output: 97 });
  // Its own window gauge: what its last call was sent, against its model's room.
  expect(await s.usage.window({ user: USER, chat: CHAT, session: "s1", turn: "t1" }, "gm-1")).toEqual({ used: 640, window: 64_000, reserve: 4_000 });
  // The live run lists it beside the lead, and its events and text came under its name, tied to the lead's call.
  expect(s.hub.running(USER)[0]?.agents).toEqual([turn.lead, gm]);
  const own = items.flatMap((item) => (item.type === "event" && item.record.agent.id === "gm-1" ? [item.record] : []));
  expect(own.map((record) => record.event.kind)).toEqual(["agent_started", "call_started", "call_ended", "tool_started", "tool_ended", "call_started", "call_ended", "agent_ended"]);
  expect(own.every((record) => record.parent?.call === "d-1")).toBe(true);
  const text = items.flatMap((item) => (item.type === "delta" && item.delta.agent === "gm-1" && item.delta.text !== undefined ? [item.delta.text] : []));
  expect(text.join("")).toBe("Rolling.A four: the jump fails.");
  // The thinking block says who is at work, in the progress file's words.
  expect(s.progress).toEqual(["Asking gm-1."]);
});

const HOUR = 3_600_000;
const START = Date.UTC(2026, 4, 1, 9, 30);
const scope = { user: USER, chat: CHAT, session: "s1" };
const lead: AgentRef = { id: "lead", definition: "lead" };
const keeper: AgentRef = { id: "keeper-1", definition: "keeper", job: "job-1" };

/** A store of plain values by user, as a host keeps them; job records are not asked for here. */
function memoryStore(): StorePort & { values: Map<string, JsonValue> } {
  const values = new Map<string, JsonValue>();
  const at = (user: string, key: string): string => `${user}\n${key}`;
  return {
    values,
    get: async ({ user }, key) => structuredClone(values.get(at(user, key))),
    set: async ({ user }, key, value) => void values.set(at(user, key), structuredClone(value)),
    update: async ({ user }, key, change) => {
      const next = change(structuredClone(values.get(at(user, key))));
      if (next === undefined) values.delete(at(user, key));
      else values.set(at(user, key), structuredClone(next));
      return next;
    },
    delete: async ({ user }, key) => void values.delete(at(user, key)),
    list: async ({ user }, prefix) => [...values.keys()].filter((key) => key.startsWith(at(user, prefix))).map((key) => key.slice(user.length + 1)),
    jobs: new Proxy({} as StorePort["jobs"], {
      get: () => {
        throw new Error("No job record is asked for here.");
      },
    }),
  };
}

function book(store: StorePort, clock: FakeClock, global = ""): UsageBook {
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return new UsageBook({ store, clock, log, files: configFiles({ global, chats: {} }) });
}

function spent(input: number, output: number, cacheRead = 0): Usage {
  return { calls: 1, input, cacheRead, cacheWrite: 0, output };
}

/** Plays one agent's work into the book: its start, a call that ended per usage, and, unless cut off, its end with all it spent. */
function work(usage: UsageBook, clock: FakeClock, run: string, agent: AgentRef, calls: Usage[], ended = true): void {
  let seq = 0;
  const record = (event: TraceEvent): void => usage.record({ seq: (seq += 1), run, scope, at: clock.now(), agent, event });
  record({ kind: "agent_started", definition: agent.definition, connection: "c", model: "m", session: "s1", given: [] });
  const total = emptyUsage();
  for (const [at, call] of calls.entries()) {
    record({ kind: "call_ended", call: at + 1, model: "m", text: "", toolCalls: [], stop: "stop", usage: call, ms: 1 });
    total.calls += call.calls;
    total.input += call.input;
    total.cacheRead += call.cacheRead;
    total.output += call.output;
  }
  if (ended) record({ kind: "agent_ended", status: "done", usage: total });
}

describe("the day", () => {
  test("past the day's tokens no call of a turn or of a job is made, and the limit is named; calls older than 24 hours no longer count", async () => {
    const clock = new FakeClock(START);
    const usage = book(memoryStore(), clock);
    work(usage, clock, "t1", lead, [spent(4_000, 500)]);
    clock.advance(10 * HOUR);
    work(usage, clock, "job-1", keeper, [spent(3_000, 400, 2_000)]);
    await usage.settled();
    const spend = await usage.spend(USER);
    expect(spend.all()).toEqual({ calls: 2, input: 7_000, cacheRead: 2_000, cacheWrite: 0, output: 900 });
    expect(spend.jobs()).toEqual({ calls: 1, input: 3_000, cacheRead: 2_000, cacheWrite: 0, output: 400 });
    // A turn's chain ends in the day's cap on every agent; a job's in the jobs' own cap, then that one.
    const day = new Budget("day", { tokens: 7_000 }, undefined, { spent: spend.all, cachedWeight: 0.1 });
    const jobsDay = new Budget("day", { tokens: 1_000 }, day, { spent: spend.jobs, cachedWeight: 0.1 });
    // 7,000 sent less the 2,000 read again, those at a tenth, and 900 written: 6,100, within the cap.
    expect(new Budget("turn", {}, day).reached(lead)).toEqual([]);
    expect(new Budget("job", {}, jobsDay).reached(keeper)).toEqual([{ limit: "tokens", per: "day", max: 1_000, value: 1_600 }]);
    work(usage, clock, "t2", lead, [spent(1_000, 100)]);
    await usage.settled();
    expect(new Budget("turn", {}, day).reached(lead)).toEqual([{ limit: "tokens", per: "day", max: 7_000, value: 7_200 }]);
    // The first turn's call falls out of the window once 24 hours have passed since it.
    clock.advance(14 * HOUR);
    expect(spend.all()).toEqual({ calls: 2, input: 4_000, cacheRead: 2_000, cacheWrite: 0, output: 500 });
    expect(new Budget("turn", {}, day).reached(lead)).toEqual([]);
    expect(await usage.day(USER)).toEqual(spend.all());
  });

  test("a harness made again over the same store after a run was cut off holds the day to every call that ended", async () => {
    const clock = new FakeClock(START);
    const store = memoryStore();
    const first = book(store, clock);
    // Cut off: two calls ended, the agent's work never did.
    work(first, clock, "t1", lead, [spent(1_200, 80), spent(1_500, 60)], false);
    await first.settled();
    expect(await book(store, clock).day(USER)).toEqual({ calls: 2, input: 2_700, cacheRead: 0, cacheWrite: 0, output: 140 });
    // What a work spent beyond its calls that ended whole (a call a stop cut off) counts as it ends.
    const second = book(store, clock);
    let seq = 0;
    const record = (event: TraceEvent): void => second.record({ seq: (seq += 1), run: "t2", scope, at: clock.now(), agent: lead, event });
    record({ kind: "agent_started", definition: "lead", connection: "c", model: "m", session: "s1", given: [] });
    record({ kind: "agent_ended", status: "stopped", usage: spent(900, 30) });
    await second.settled();
    expect(await book(store, clock).day(USER)).toEqual({ calls: 3, input: 3_600, cacheRead: 0, cacheWrite: 0, output: 170 });
  });

  test("a day record in an older form counts toward the 24 hours it falls in, once: one number in full, token parts, and the map by user for this user alone", async () => {
    const clock = new FakeClock(START);
    const store = memoryStore();
    await store.set({ user: USER }, "usage/days/2026-05-01", { calls: 3, input: 2_000, cacheRead: 0, cacheWrite: 0, output: 300 });
    await store.set({ user: USER }, "usage/days/2026-04-28", { calls: 9, input: 90_000, cacheRead: 0, cacheWrite: 0, output: 900 });
    await store.set({ user: USER }, "jobs/days/2026-05-01", { all: 2, connections: { quay: 1 }, tokens: { input: 500, cacheRead: 100, output: 50 } });
    await store.set({ user: USER }, "jobs/days/2026-04-30", 700);
    await store.set({ user: USER }, "jobs/days/2026-04-29", { [USER]: 400, "second-reader": 9_000 });
    const usage = book(store, clock);
    const spend = await usage.spend(USER);
    // Today's usage record counts for every agent; yesterday's job tokens (its day ends inside the 24 hours) and today's for the jobs; days gone by count nothing.
    expect(spend.all()).toEqual({ calls: 3, input: 2_000, cacheRead: 0, cacheWrite: 0, output: 300 });
    expect(spend.jobs()).toEqual({ calls: 0, input: 1_200, cacheRead: 100, cacheWrite: 0, output: 50 });
    // Read once: they leave the store, the job record's counts of jobs going into its hour's document as jobs started.
    expect([...store.values.keys()].filter((key) => key.includes("/days/"))).toEqual([]);
    expect(await book(store, clock).countJob(USER, [{ max: 2 }], [])).toMatchObject({ limit: "jobs", per: "day", max: 2, value: 2 });
    expect((await book(store, clock).spend(USER)).jobs()).toEqual(spend.jobs());
    // A map by user written before each user's values were kept apart counts his entry alone.
    const other = memoryStore();
    await other.set({ user: USER }, "jobs/days/2026-05-01", { [USER]: 400, "second-reader": 9_000 });
    expect((await book(other, clock).spend(USER)).jobs()).toEqual({ ...emptyUsage(), input: 400 });
  });

  test("a finished run's usage is answered by a harness made again; past the kept count the oldest goes", async () => {
    const clock = new FakeClock(START);
    const store = memoryStore();
    const first = book(store, clock, "usage:\n  keptRuns: 2\n");
    for (const run of ["t1", "t2", "t3"]) {
      first.begin(run);
      work(first, clock, run, lead, [spent(100, 10)]);
      first.end(run);
    }
    await first.settled();
    const again = book(store, clock);
    expect(await again.run(USER, "t1")).toBeUndefined();
    expect(await again.run(USER, "t3")).toEqual({ run: "t3", total: spent(100, 10), agents: [{ agent: lead, usage: spent(100, 10) }] });
    expect(await again.run("second-reader", "t3")).toBeUndefined();
  });
});
