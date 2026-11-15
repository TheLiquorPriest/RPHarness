// How a turn ends (§10.7, §10.9, §10.10, §13.3, §5.4): a closing call that comes back clean ends the
// run whether or not a reply is out, and whether a run with no reply goes on is a run-end rule's
// call (`reply-missing`, a file), which costs exactly one more call; `owesReply` is a fact a rule can
// test (`reply.owed`) and changes nothing of how a run ends; the run may go on after the reply; and
// a stop, from the signal or because the turn left the path, leaves nothing running, even a writer
// that was still being made.
import { afterEach, describe, expect, test } from "bun:test";
import type { FilesPort, RuleFiring } from "../../src/contract";
import { type ChatFixture, gate, request, said, type Stage, stage, textOf, WatchedSink } from "./support";

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
    expect(sink.errors).toEqual([{ code: "no-reply", text: "Thinking it over." }]);
    expect(sink.finished).toEqual([]);
    expect(firings(s)).toMatchObject([{ rule: "reply-missing", moment: "run-end", action: "follow-up", then: { did: "wrote" } }]);
    expect(s.told.at(-1)).toMatchObject({ kind: "ended", payload: { status: "no-reply", released: false } });
  });
});

/** The chat's active path, for `chat_read` to read. */
const CHAT: ChatFixture[] = [
  { id: "m1", role: "user", name: "Reader", text: "I ask Wren whether the supply boat came." },
  { id: "m2", role: "assistant", name: "Wren Hale", text: "The supply boat is two days late, Wren says." },
];

/** A read the lead marks closing, though it needs its answer. */
const CLOSING_READ = { call: "chat_read", args: { last: 4, closing: true } };

/** Each tool call's tool, whether it came back clean, and whether it ended the run. */
function ended(s: Stage): [string, boolean, boolean][] {
  return s.trace.of("tool_ended").map((record) => [record.event.tool, record.event.clean, record.event.endedRun]);
}

/** A finished reply the lead can release, in the chat's folder, as the agents name it. */
const KEPT = "persistent-workspace/reply.md";
const KEPT_ON_DISK = `chats/wren-hale/lighthouse/${KEPT}`;

/** A `reply-missing` of the test's own, whose header tests `reply.owed`: what the shipped rule's header is to test (see the report). */
const OWED_RULE = "---\ndescription: Fixture - a run that owes the player a reply and is ending with none.\nagents: [lead]\nfact: reply.owed > 0\nat: run-end\nrepeat: once per turn\n---\nFixture reminder: the player is still owed a reply.\n";

describe("closing calls", () => {
  test("a clean closing call ends the run before the reply when no run-end rule is due, in either form", async () => {
    // RPH ships no run-end rule: nothing is due when the run would end.
    const tagged = (open = await stage({ chat: CHAT, answers: [{ pieces: [CLOSING_READ] }] }));
    const { outcome, sink } = await tagged.turn(request("t1", { lead: "lead" }));
    expect(outcome).toMatchObject({ status: "no-reply", released: false });
    expect(tagged.model.requests).toHaveLength(1);
    expect(ended(tagged)).toEqual([["chat_read", true, true]]);
    expect(firings(tagged)).toEqual([]);
    expect(sink.errors).toEqual([{ code: "no-reply" }]);
    await tagged.close();

    const plain = (open = await stage({ config: "reply:\n  form: two-step\n", chat: CHAT, answers: [{ pieces: [CLOSING_READ] }] }));
    expect((await plain.turn(request("t1", { lead: "lead" }))).outcome).toMatchObject({ status: "no-reply", released: false });
    expect(plain.model.requests).toHaveLength(1);
    expect(ended(plain)).toEqual([["chat_read", true, true]]);
  });

  test("with reply-missing in force, a run that would end on closing calls before the reply gets exactly one more call", async () => {
    const s = (open = await stage({
      drafted: true,
      chat: CHAT,
      answers: [{ pieces: [CLOSING_READ] }, { pieces: [{ text: "<intent>News of the boat.</intent><reply>No boat, Wren says.</reply>" }] }],
    }));

    const { outcome, sink } = await s.turn(request("t1"));

    expect(outcome).toMatchObject({ status: "released", form: "tags", reply: "No boat, Wren says." });
    expect(s.model.requests).toHaveLength(2);
    // The closing read ended the run's batch; the rule's text is what the one more call ends on.
    expect(ended(s)).toEqual([["chat_read", true, true]]);
    const reminded = s.model.requests[1]!.messages.at(-1)!;
    expect(reminded.role).toBe("user");
    expect(textOf(reminded)).toBe(REMINDER);
    expect(firings(s)).toMatchObject([{ rule: "reply-missing", moment: "run-end", action: "follow-up", then: { did: "released" } }]);
    expect(sink.text).toBe("No boat, Wren says.");
  });

  test("a closing reply_release beside another closing call that finishes first: no call after the release", async () => {
    const read = gate();
    // The file is held while it is read, until the closing read beside it has finished.
    const filesPort = (inner: FilesPort): FilesPort => ({
      layers: (scope) => inner.layers(scope),
      places: (scope) => inner.places(scope),
      find: (scope, query) => inner.find(scope, query),
      write: (scope, path, op, by) => inner.write(scope, path, op, by),
      read: async (scope, path, range) => {
        if (path === KEPT) await read.opened;
        return inner.read(scope, path, range);
      },
    });
    const s = (open = await stage({
      drafted: true,
      chat: CHAT,
      files: { [KEPT_ON_DISK]: "A finished reply.\n" },
      filesPort,
      answers: [{ pieces: [CLOSING_READ, { call: "reply_release", args: { path: KEPT, closing: true } }] }],
    }));

    const playing = s.turn(request("t1"));
    await s.trace.seen((record) => record.event.kind === "tool_ended" && record.event.tool === "chat_read");
    read.open();
    const { outcome, sink } = await playing;

    expect(outcome).toMatchObject({ status: "released", form: "file", reply: "A finished reply.\n" });
    expect(s.model.requests).toHaveLength(1);
    expect(ended(s)).toEqual([
      ["chat_read", true, true],
      ["reply_release", true, true],
    ]);
    expect(firings(s)).toEqual([]);
    expect(sink.text).toBe("A finished reply.\n");
  });

  test("once the reply is out, the same closing read in the reply's own message ends the run, in either form", async () => {
    const tagged = (open = await stage({ chat: CHAT, answers: [{ pieces: [{ text: "<reply>No boat, Wren says.</reply>" }, CLOSING_READ] }] }));
    expect((await tagged.turn(request("t1", { lead: "lead" }))).outcome).toMatchObject({ status: "released", reply: "No boat, Wren says." });
    expect(tagged.model.requests).toHaveLength(1);
    expect(ended(tagged)).toEqual([["chat_read", true, true]]);
    await tagged.close();

    const plain = (open = await stage({ config: "reply:\n  form: two-step\n", chat: CHAT, answers: [{ pieces: [{ text: "No boat, Wren says." }, CLOSING_READ] }] }));
    expect((await plain.turn(request("t1", { lead: "lead" }))).outcome).toMatchObject({ status: "released", form: "message", reply: "No boat, Wren says." });
    expect(plain.model.requests).toHaveLength(1);
    expect(ended(plain)).toEqual([["chat_read", true, true]]);
  });

  test("a run that owes the player no reply ends on its closing calls", async () => {
    const s = (open = await stage({ chat: CHAT, answers: [{ pieces: [CLOSING_READ] }] }));

    const { outcome } = await s.turn(request("t1", { lead: "lead", owesReply: false }));

    expect(outcome).toMatchObject({ status: "no-reply", released: false });
    expect(s.model.requests).toHaveLength(1);
    expect(ended(s)).toEqual([["chat_read", true, true]]);
  });

  test("owesReply false with reply-missing in force: the rule, whose header tests reply.owed, does not fire", async () => {
    const s = (open = await stage({
      chat: CHAT,
      files: { ".rules/reply-missing.md": OWED_RULE },
      answers: [{ pieces: [CLOSING_READ] }, { pieces: [{ text: "<reply>No boat, Wren says.</reply>" }] }, { pieces: [CLOSING_READ] }],
    }));

    // A run that owes the reply: the rule fires as the run would end on its closing read, and the lead gets one more call.
    expect((await s.turn(request("t1", { lead: "lead" }))).outcome).toMatchObject({ status: "released", reply: "No boat, Wren says." });
    expect(s.model.requests).toHaveLength(2);
    expect(textOf(s.model.requests[1]!.messages.at(-1)!)).toBe("Fixture reminder: the player is still owed a reply.");
    expect(firings(s)).toMatchObject([{ rule: "reply-missing", moment: "run-end", fact: { name: "reply.owed", value: { count: 1 } } }]);

    // A run that owes none: the same closing read ends it, and the rule does not fire.
    const { outcome, sink } = await s.turn(request("t2", { lead: "lead", parent: "t1", owesReply: false }));
    expect(outcome).toMatchObject({ status: "no-reply", released: false });
    expect(s.model.requests).toHaveLength(3);
    expect(s.trace.of("rule_fired").filter((record) => record.scope.turn === "t2")).toEqual([]);
    expect(firings(s)).toHaveLength(1);
    expect(sink.errors).toEqual([{ code: "no-reply" }]);
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
      answers: [{ pieces: [{ text: "<intent>Look it up.</intent>Checking the world first." }, { call: "world_query" }] }, { pieces: [{ text: "<reply>never</reply>" }] }],
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
    // A stop with no reply carries the lead's last plain text outside any mark: never its intent record.
    expect(sink.errors).toEqual([{ code: "stopped", text: "Checking the world first." }]);
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
