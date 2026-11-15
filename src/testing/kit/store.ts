// The kit's cases for the small durable store and the trace.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentRef, JobView, JsonValue, Scope, TraceEvent, TraceKind, TraceRecord, Usage } from "../../contract/index";
import type { KitContext } from "./context";
import { KIT_OTHER_USER, unlessRefused } from "./context";

export function storeCases(ctx: KitContext<"store">): void {
  test("a value is kept whole, and a key with none gives undefined", async () => {
    const value: JsonValue = { jobs: [{ id: "kit-job-1", state: "running", spent: { calls: 3 } }], note: null, ok: true };
    await ctx.env.store.set(ctx.scope, "kit/jobs/kit-job-1", value);
    expect(await ctx.env.store.get(ctx.scope, "kit/jobs/kit-job-1")).toEqual(value);
    await ctx.env.store.set(ctx.scope, "kit/jobs/kit-job-1", 7);
    expect(await ctx.env.store.get(ctx.scope, "kit/jobs/kit-job-1")).toBe(7);
    expect(await ctx.env.store.get(ctx.scope, "kit/jobs/kit-no-such-job")).toBeUndefined();
  });

  test("changes to one key run one at a time, so counts made at once add up", async () => {
    await Promise.all(Array.from({ length: 25 }, () => ctx.env.store.update(ctx.scope, "kit/usage/day", (n) => (typeof n === "number" ? n : 0) + 1)));
    expect(await ctx.env.store.get(ctx.scope, "kit/usage/day")).toBe(25);
    expect(await ctx.env.store.update(ctx.scope, "kit/usage/day", () => undefined)).toBeUndefined();
    expect(await ctx.env.store.get(ctx.scope, "kit/usage/day")).toBeUndefined();
  });

  test("keys list by prefix, and a deleted key is gone", async () => {
    await ctx.env.store.set(ctx.scope, "kit/approvals/a", 1);
    await ctx.env.store.set(ctx.scope, "kit/approvals/b", 2);
    await ctx.env.store.set(ctx.scope, "kit/other", 3);
    expect((await ctx.env.store.list(ctx.scope, "kit/approvals/")).sort()).toEqual(["kit/approvals/a", "kit/approvals/b"]);
    await ctx.env.store.delete(ctx.scope, "kit/approvals/a");
    await ctx.env.store.delete(ctx.scope, "kit/approvals/never-set");
    expect(await ctx.env.store.list(ctx.scope, "kit/approvals/")).toEqual(["kit/approvals/b"]);
  });

  test("two users' values under the same key stay apart, and a list by prefix gives only the user's own keys", async () => {
    const other = { user: KIT_OTHER_USER };
    await ctx.env.store.set(ctx.scope, "kit/apart/note", "mine");
    await ctx.env.store.set({ user: ctx.scope.user }, "kit/apart/only-mine", 1);
    // A host that serves one user only may refuse another's scope outright; one that keeps both keeps each his own.
    const accepted = await unlessRefused(ctx.env.store.set(other, "kit/apart/note", "theirs").then(() => true));
    await unlessRefused(ctx.env.store.set(other, "kit/apart/only-theirs", 2));
    await unlessRefused(ctx.env.store.update(other, "kit/apart/count", () => 5));

    expect(await ctx.env.store.get(ctx.scope, "kit/apart/note")).toBe("mine");
    expect(await ctx.env.store.get(ctx.scope, "kit/apart/count")).toBeUndefined();
    // A chat's scope and the user's alone are the same user's: his keys, whichever of the two set them.
    expect((await ctx.env.store.list({ user: ctx.scope.user }, "kit/apart/")).sort()).toEqual(["kit/apart/note", "kit/apart/only-mine"]);
    expect((await ctx.env.store.list(ctx.scope, "kit/apart/")).sort()).toEqual(["kit/apart/note", "kit/apart/only-mine"]);
    const theirs = { note: await unlessRefused(ctx.env.store.get(other, "kit/apart/note")), keys: ((await unlessRefused(ctx.env.store.list(other, "kit/apart/"))) ?? []).sort() };
    expect(theirs).toEqual(accepted === true ? { note: "theirs", keys: ["kit/apart/count", "kit/apart/note", "kit/apart/only-theirs"] } : { note: undefined, keys: [] });
  });

  test("a value survives a new instance over the same place", async () => {
    const place = await mkdtemp(join(tmpdir(), "rph-kit-store-"));
    try {
      const first = await ctx.make(ctx.seed, place);
      await first.store.set(ctx.scope, "kit/survives", { turn: "kit-turn-1", calls: 4 });
      await first.store.update(ctx.scope, "kit/count", () => 1);
      await first.close();
      const second = await ctx.make(ctx.seed, place);
      expect(await second.store.get(ctx.scope, "kit/survives")).toEqual({ turn: "kit-turn-1", calls: 4 });
      expect(await second.store.get(ctx.scope, "kit/count")).toBe(1);
      await second.close();
    } finally {
      await rm(place, { recursive: true, force: true });
    }
  });

  // The typed part for job records (`StorePort.jobs`). Each case keeps its records in a chat of its own, so what an earlier case left does not show in a later one's pages.
  const job = (chat: string, id: string, started: number, extra: Partial<JobView> = {}): JobView => ({ id, agent: "indexer", brief: "Index the lore.", state: "done", scope: { user: ctx.scope.user, chat, session: `kit-job-session-${id}` }, startedBy: "user", started, usage: NO_USAGE, ...extra });
  const ids = (jobs: JobView[]): string[] => jobs.map((j) => j.id);

  test("a job record is kept whole and read by its id, and the same id under two users is two records", async () => {
    const mine = job("kit-chat-whole", "kit-job-a", 1_000, { report: "Mine.", wrote: [{ tool: "kit_stamp", lane: "engine", line: "stamped" }], attach: ["notes/a.md"], missing: ["notes/gone.md"] });
    await ctx.env.store.jobs.set(ctx.scope, mine);
    expect(await ctx.env.store.jobs.get(ctx.scope, "kit-job-a")).toEqual(mine);
    expect(await ctx.env.store.jobs.get(ctx.scope, "kit-job-none")).toBeUndefined();
    await ctx.env.store.jobs.set(ctx.scope, { ...mine, state: "interrupted", report: "Changed." });
    expect(await ctx.env.store.jobs.get(ctx.scope, "kit-job-a")).toMatchObject({ state: "interrupted", report: "Changed." });
    expect(ids((await ctx.env.store.jobs.list(ctx.scope, { chat: "kit-chat-whole" })).jobs)).toEqual(["kit-job-a"]);
    // A host that serves one user only may refuse another's scope outright; one that keeps both keeps each his own.
    const other = { user: KIT_OTHER_USER };
    await unlessRefused(ctx.env.store.jobs.set(other, { ...mine, scope: { ...mine.scope, user: KIT_OTHER_USER }, report: "Theirs." }));
    expect(await ctx.env.store.jobs.get(ctx.scope, "kit-job-a")).toMatchObject({ report: "Changed." });
    expect(ids((await ctx.env.store.jobs.list(ctx.scope, { chat: "kit-chat-whole" })).jobs)).toEqual(["kit-job-a"]);
  });

  test("job records come a page at a time, the latest started first, and a page holds only what it was asked for", async () => {
    const chat = "kit-chat-pages";
    for (let at = 1; at <= 7; at += 1) await ctx.env.store.jobs.set(ctx.scope, job(chat, `kit-page-${at}`, 10_000 + at * 10, at % 2 === 0 ? { state: "running" } : {}));
    const first = await ctx.env.store.jobs.list(ctx.scope, { chat, limit: 3 });
    expect(ids(first.jobs)).toEqual(["kit-page-7", "kit-page-6", "kit-page-5"]);
    expect(first.next).toBeDefined();
    const second = await ctx.env.store.jobs.list(ctx.scope, { chat, limit: 3, cursor: first.next! });
    expect(ids(second.jobs)).toEqual(["kit-page-4", "kit-page-3", "kit-page-2"]);
    const third = await ctx.env.store.jobs.list(ctx.scope, { chat, limit: 3, cursor: second.next! });
    expect(ids(third.jobs)).toEqual(["kit-page-1"]);
    expect(third.next).toBeUndefined();
    // Whole: no limit gives every record, and no next.
    const all = await ctx.env.store.jobs.list(ctx.scope, { chat });
    expect(ids(all.jobs)).toEqual(["kit-page-7", "kit-page-6", "kit-page-5", "kit-page-4", "kit-page-3", "kit-page-2", "kit-page-1"]);
    expect(all.next).toBeUndefined();
    // By state and by chat, the page still full of what matches.
    expect(ids((await ctx.env.store.jobs.list(ctx.scope, { chat, states: ["running"], limit: 2 })).jobs)).toEqual(["kit-page-6", "kit-page-4"]);
    expect(ids((await ctx.env.store.jobs.list(ctx.scope, { chat, states: ["done"] })).jobs)).toEqual(["kit-page-7", "kit-page-5", "kit-page-3", "kit-page-1"]);
    expect(ids((await ctx.env.store.jobs.list(ctx.scope, { chat: "kit-no-such-chat" })).jobs)).toEqual([]);
  });

  test("the records of jobs started before a time are removed, and no other", async () => {
    const chat = "kit-chat-old";
    for (const at of [100, 200, 300]) await ctx.env.store.jobs.set(ctx.scope, job(chat, `kit-old-${at}`, at));
    expect(await ctx.env.store.jobs.prune(ctx.scope, 250)).toBe(2);
    expect(ids((await ctx.env.store.jobs.list(ctx.scope, { chat })).jobs)).toEqual(["kit-old-300"]);
    expect(await ctx.env.store.jobs.prune(ctx.scope, 250)).toBe(0);
    expect(await ctx.env.store.jobs.get(ctx.scope, "kit-old-100")).toBeUndefined();
  });

  test("a job record survives a new instance over the same place", async () => {
    const place = await mkdtemp(join(tmpdir(), "rph-kit-jobs-"));
    try {
      const first = await ctx.make(ctx.seed, place);
      await first.store.jobs.set(ctx.scope, job("kit-chat-kept", "kit-kept", 5_000, { state: "running", usage: { ...NO_USAGE, calls: 2, input: 300 } }));
      await first.close();
      const second = await ctx.make(ctx.seed, place);
      expect(await second.store.jobs.get(ctx.scope, "kit-kept")).toMatchObject({ state: "running", usage: { calls: 2, input: 300 } });
      await second.close();
    } finally {
      await rm(place, { recursive: true, force: true });
    }
  });
}

const NO_USAGE: Usage = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/** One event of every kind: the compiler holds this list to every kind there is. */
function everyKind(agent: AgentRef): { [K in TraceKind]: Extract<TraceEvent, { kind: K }> } {
  const outcome = { status: "released" as const, released: true, usage: NO_USAGE };
  return {
    run_started: { kind: "run_started", run: "turn", turn: "new", lead: "author" },
    agent_started: { kind: "agent_started", definition: agent.definition, connection: "kit-connection", model: "kit-model", effort: "low", session: "kit-session", given: ["prompt:persona"] },
    intent: { kind: "intent", text: "Wants: a quiet answer." },
    call_started: { kind: "call_started", call: 1, connection: "kit-connection", model: "kit-model", sampling: { temperature: 0.7 }, maxTokens: 512, messages: 6, tools: 3 },
    call_ended: { kind: "call_ended", call: 1, model: "kit-model", text: "Wren nods.", toolCalls: [{ id: "kit-call-1", name: "kit_tally", args: { numbers: [1, 2] } }], stop: "tool_calls", usage: { ...NO_USAGE, calls: 1, input: 900, output: 40 }, ms: 812 },
    tool_started: { kind: "tool_started", callId: "kit-call-1", tool: "kit_tally", args: { numbers: [1, 2] }, closing: true },
    tool_update: { kind: "tool_update", callId: "kit-call-1", tool: "kit_tally", partial: { content: [{ type: "text", text: "counting" }] } },
    tool_ended: { kind: "tool_ended", callId: "kit-call-1", tool: "kit_tally", result: { content: [{ type: "text", text: "3" }] }, clean: true, endedRun: true, ms: 2 },
    rule_fired: { kind: "rule_fired", firing: { rule: "kit-quiet", path: ".rules/kit-quiet.md", level: "global", moment: "run-end", agent, action: "follow-up" } },
    hook: { kind: "hook", hook: "kit-hook", on: "before-tool", outcome: "ok", ms: 5 },
    approval_asked: { kind: "approval_asked", callId: "kit-call-2", tool: "kit_tally", lane: "engine" },
    approval_answered: { kind: "approval_answered", callId: "kit-call-2", tool: "kit_tally", lane: "engine", answer: { go: false, reason: "Not now." } },
    prompt_notices: { kind: "prompt_notices", notices: [{ kind: "gone", marker: "card" }] },
    todo: { kind: "todo", items: [{ text: "Answer Tamsin.", done: false }] },
    limit: { kind: "limit", hit: { limit: "calls", per: "turn", max: 40, value: 40 } },
    released: { kind: "released", release: { by: agent, form: "tags", length: 10 } },
    progress_missing: { kind: "progress_missing", time: 540_000 },
    compacted: { kind: "compacted", session: "kit-session", before: 90_000, after: 12_000, keptTurns: 3 },
    session: { kind: "session", session: "kit-session", change: "opened" },
    job: { kind: "job", job: { id: "kit-job-1", agent: "indexer", brief: "Index the lore.", state: "running", scope: { user: "kit-user", chat: "kit-chat", session: "kit-job-session", turn: "kit-turn-1" }, startedBy: agent, started: 0, usage: NO_USAGE } },
    agent_ended: { kind: "agent_ended", status: "done", usage: NO_USAGE },
    run_ended: { kind: "run_ended", outcome },
  };
}

export function traceCases(ctx: KitContext<"trace">): void {
  test("the trace takes an event of every kind, and streaming text, without throwing, and its flush resolves", async () => {
    const lead: AgentRef = { id: "kit-lead", definition: "author" };
    const scope: Scope = ctx.scope;
    const events = Object.values(everyKind(lead));
    for (const [i, event] of events.entries()) {
      const record: TraceRecord = { seq: i + 1, run: ctx.scope.turn, scope, at: 1_000 + i, agent: lead, event };
      expect(() => ctx.env.trace.event(record)).not.toThrow();
    }
    const sub: TraceRecord = { seq: events.length + 1, run: ctx.scope.turn, scope, at: 2_000, agent: { id: "kit-gm-1", definition: "gm", parent: "kit-lead" }, parent: { agent: "kit-lead", run: ctx.scope.turn, call: "kit-call-3" }, event: { kind: "agent_started", definition: "gm", connection: "kit-connection", model: "kit-model", session: "kit-gm-session", given: [] } };
    expect(() => ctx.env.trace.event(sub)).not.toThrow();
    expect(() => ctx.env.trace.delta({ run: ctx.scope.turn, agent: "kit-lead", call: 1, text: "Wren", thinking: "quietly", at: 1_500 })).not.toThrow();
    await expect(ctx.env.trace.flush()).resolves.toBeUndefined();
  });
}
