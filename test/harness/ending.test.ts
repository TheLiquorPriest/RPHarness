// How a turn ends (§10.7, §10.9, §10.10, §5.4): with no reply released, the shipped reminder is put
// in front of the lead once, and then the host is told; closing calls do not end the run while a
// run-end rule is due; the run may go on after the reply; and a stop, from the signal or because
// the turn left the path, leaves nothing running, even a writer that was still being made.
import { afterEach, describe, expect, test } from "bun:test";
import type { RuleFiring } from "../../src/contract";
import { gate, request, said, type Stage, stage, textOf, WatchedSink } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** The text of the drafted `reply-missing` rule, as its file has it. */
const REMINDER = "You are about to end the turn and the player has no reply. Write it now, marked the way the reply contract says.";

function firings(s: Stage): RuleFiring[] {
  return s.told.filter((told) => told.kind === "ruleFired").map((told) => told.payload as RuleFiring);
}

describe("a turn that would end with no reply", () => {
  test("puts the shipped reminder in front of the lead once; when the lead still gives none, the host is told", async () => {
    const s = (open = await stage({ drafted: true, answers: [{ pieces: [{ text: "<intent>Wait and see.</intent>" }] }, { pieces: [{ text: "Thinking it over." }] }, { pieces: [{ text: "<reply>never asked for</reply>" }] }] }));

    const { outcome, sink } = await s.turn(request("t1"));

    expect(outcome).toMatchObject({ status: "no-reply", released: false, reply: "" });
    expect(s.model.requests).toHaveLength(2);
    const reminded = s.model.requests[1]!.messages.at(-1)!;
    expect(reminded.role).toBe("user");
    expect(textOf(reminded)).toBe(REMINDER);
    expect(sink.text).toBe("");
    expect(sink.errors).toEqual([{ code: "no-reply" }]);
    expect(sink.finished).toEqual([]);
    expect(firings(s)).toMatchObject([{ rule: "reply-missing", moment: "run-end", action: "follow-up", then: { did: "wrote" } }]);
    expect(s.told.at(-1)).toMatchObject({ kind: "ended", payload: { status: "no-reply", released: false } });
  });

  test("closing calls do not end the run while the reminder is due: it comes after their results, and the reply follows", async () => {
    const s = (open = await stage({
      drafted: true,
      answers: [
        { pieces: [{ text: "<intent>Note it first.</intent>" }, { call: "todo", args: { items: [{ text: "answer about the boat", done: false }], closing: true } }] },
        { pieces: [{ text: "<reply>No boat, Wren says.</reply>" }] },
      ],
    }));

    const { outcome, sink } = await s.turn(request("t1"));

    expect(outcome).toMatchObject({ status: "released", reply: "No boat, Wren says." });
    expect(s.model.requests).toHaveLength(2);
    expect(s.trace.of("tool_ended").map((record) => [record.event.tool, record.event.clean, record.event.endedRun])).toEqual([["todo", true, true]]);
    expect(s.model.requests[1]!.messages.slice(-2).map((message) => message.role)).toEqual(["toolResult", "user"]);
    expect(textOf(s.model.requests[1]!.messages.at(-1)!)).toBe(REMINDER);
    expect(sink.text).toBe("No boat, Wren says.");
    expect(firings(s)).toMatchObject([{ rule: "reply-missing", then: { did: "released" } }]);
  });
});

describe("after the reply", () => {
  test("the run goes on after the reply has streamed, and the turn ends when the lead's run does", async () => {
    const s = (open = await stage({
      drafted: true,
      tools: { world_apply: { tier: "write", lane: "engine", description: "Fixture: records a change.", run: async () => said("recorded") } },
      answers: [
        { pieces: [{ text: "<reply>Wren lights the lamp.</reply>" }, { call: "world_apply", args: {} }] },
        { pieces: [{ call: "todo", args: { items: [], closing: true } }] },
      ],
    }));
    const sink = new WatchedSink(s.clock);

    const { outcome } = await s.turn(request("t1"), sink);

    expect(outcome).toMatchObject({ status: "released", reply: "Wren lights the lamp." });
    expect(s.model.requests).toHaveLength(2);
    // The sink was finished at release, before the run's second call, and heard nothing after.
    expect(sink.finished).toHaveLength(1);
    const kinds = s.trace.records.map((record) => record.event.kind);
    expect(kinds.indexOf("released")).toBeLessThan(kinds.lastIndexOf("call_started"));
  });
});

describe("stop", () => {
  test("in the middle of the stream: the agent stops, nothing more reaches the sink, and no further call is made", async () => {
    const more = gate();
    const s = (open = await stage({ drafted: true, answers: [{ pieces: [{ text: "<reply>The first line arrives." }, { hold: more }, { text: " This must never show.</reply>" }], ignoreAbort: true }] }));
    const sink = new WatchedSink(s.clock);
    const stop = new AbortController();

    const turn = s.turn(request("t1"), sink, stop.signal);
    await sink.until(() => sink.text !== "");
    stop.abort();
    const { outcome } = await turn;
    more.open();
    await s.clock.idle();

    expect(outcome).toMatchObject({ status: "stopped", released: false });
    expect(sink.text).toBe("The first line arrives.");
    expect(sink.errors).toEqual([{ code: "stopped" }]);
    expect(s.model.requests).toHaveLength(1);
    expect(s.trace.of("agent_ended").map((record) => record.event.status)).toEqual(["stopped"]);
    expect(s.trace.records.at(-1)?.event.kind).toBe("run_ended");
  });

  test("in the middle of a tool: the stop does not wait on the tool, and what the tool says late goes nowhere", async () => {
    const finish = gate();
    const running = gate();
    const late: string[] = [];
    const s = (open = await stage({
      drafted: true,
      tools: {
        world_query: {
          tier: "read",
          description: "Fixture: a slow read that ignores its signal.",
          run: async (_args, ctx) => {
            running.open();
            await finish.opened;
            ctx.onUpdate(said("late update"));
            late.push("answered");
            return said("late answer");
          },
        },
      },
      answers: [{ pieces: [{ text: "<intent>Look it up.</intent>" }, { call: "world_query" }] }, { pieces: [{ text: "<reply>never</reply>" }] }],
    }));
    const stop = new AbortController();

    const turn = s.turn(request("t1"), undefined, stop.signal);
    await running.opened;
    stop.abort();
    const { outcome, sink } = await turn;
    const records = s.trace.records.length;
    finish.open();
    await s.clock.idle();

    expect(outcome.status).toBe("stopped");
    expect(late).toEqual(["answered"]);
    expect(s.trace.records).toHaveLength(records);
    expect(s.model.requests).toHaveLength(1);
    expect(sink.errors).toEqual([{ code: "stopped" }]);
  });

  test("the turn left the path: its work is cancelled, after the reply as before it", async () => {
    const never = gate();
    const s = (open = await stage({
      drafted: true,
      tools: { world_query: { tier: "read", description: "Fixture: waits.", run: async () => (await never.opened, said("too late")) } },
      answers: [{ pieces: [{ text: "<reply>Wren lights the lamp.</reply>" }, { call: "world_query" }] }],
    }));
    const sink = new WatchedSink(s.clock);
    const req = request("t1");

    const turn = s.turn(req, sink);
    await s.trace.seen((record) => record.event.kind === "tool_started");
    await s.harness.turnLeft(req.scope);
    const { outcome } = await turn;

    expect(outcome).toMatchObject({ status: "stopped", released: true, reply: "Wren lights the lamp." });
    expect(sink.finished).toHaveLength(1);
    expect(sink.errors).toEqual([]);
  });

  test("while a finished file is being read for release: nothing reaches the sink after its error, and the host hears of no release", async () => {
    const asked = gate();
    const held = gate();
    const kept = "persistent-workspace/reply.md";
    const s = (open = await stage({
      drafted: true,
      files: { [`chats/wren-hale/lighthouse/${kept}`]: "A finished reply.\n" },
      // The file is held while it is read, until the turn has been stopped.
      filesPort: (inner) => ({
        layers: (scope) => inner.layers(scope),
        places: (scope) => inner.places(scope),
        find: (scope, query) => inner.find(scope, query),
        write: (scope, path, op, by) => inner.write(scope, path, op, by),
        read: async (scope, path, range) => {
          const read = await inner.read(scope, path, range);
          if (path === kept) {
            asked.open();
            await held.opened;
          }
          return read;
        },
      }),
      answers: [{ pieces: [{ call: "reply_release", args: { path: kept, closing: true } }] }],
    }));
    const stop = new AbortController();

    const turn = s.turn(request("t1"), undefined, stop.signal);
    await asked.opened;
    stop.abort();
    const { outcome, sink } = await turn;
    held.open();
    await s.clock.idle();

    expect(outcome).toMatchObject({ status: "stopped", released: false });
    expect(sink.errors).toEqual([{ code: "stopped" }]);
    expect(sink.text).toBe("");
    expect(sink.finished).toEqual([]);
    expect(s.told.map((told) => told.kind)).toEqual(["ended"]);
  });

  test("while the writer is still being made: no writer starts, the sink hears nothing after its error, and the host nothing after the end", async () => {
    const asked = gate();
    const held = gate();
    const s = (open = await stage({
      drafted: true,
      // The second model asked for is the writer's: it is held until the turn has been stopped.
      modelAsked: async (count) => {
        if (count !== 2) return;
        asked.open();
        await held.opened;
      },
      answers: [{ pieces: [{ call: "write_reply", args: { brief: "Wren says the boat has not come.", live: true } }] }, { pieces: [{ text: "Not yet, Wren says." }] }],
    }));
    const stop = new AbortController();

    const turn = s.turn(request("t1"), undefined, stop.signal);
    await asked.opened;
    stop.abort();
    const { outcome, sink } = await turn;
    const lines = sink.lines.length;
    held.open();
    await s.clock.idle();

    expect(outcome).toMatchObject({ status: "stopped", released: false });
    expect(s.model.requests).toHaveLength(1);
    expect(s.trace.of("agent_started").map((record) => record.agent.definition)).toEqual(["author"]);
    expect(sink.errors).toEqual([{ code: "stopped" }]);
    expect(sink.text).toBe("");
    expect(sink.finished).toEqual([]);
    expect(sink.lines).toHaveLength(lines);
    expect(s.told.map((told) => told.kind)).toEqual(["ended"]);
  });
});
