// Claim e (§18.1 row 0.2, §10.10 "Stop"): a stop in the middle of a stream or of a tool emits
// nothing further but the agent's end, and leaves the agent consistent: idle, and with a
// transcript it can be continued from. Then the limits (§10.11), which end work the same way.
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { Budget, type GateAfter, type GateBefore, type LoopToolResult, type ToolGate } from "../../src/loop";
import { REPLY_DEFAULTS, TagReply } from "../../src/reply";
import { FakeClock, gate, rigAgent, said, SinkRecorder, textOf, tool, TraceRecorder, user } from "./support";

const author = { id: "author", definition: "author" };
const tags = { reply: "reply", intent: "intent" };

/** Every tool call in the messages has its result, and no message is one a stop cut short. */
function consistent(messages: readonly Message[]): boolean {
  const answered = new Set(messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
  return messages.every((message) => message.role !== "assistant" || (message.stopReason !== "aborted" && message.content.every((part) => part.type !== "toolCall" || answered.has(part.id))));
}

describe("stop", () => {
  test("in the middle of a stream: nothing further is emitted, even from a provider that keeps going", async () => {
    const sink = new SinkRecorder();
    const reply = new TagReply({ tags, sink, heldSentences: 0, tailSentences: REPLY_DEFAULTS.tailSentences });
    const later = gate();
    const { runner, scripted, recorder, clock } = rigAgent(
      author,
      [{ pieces: [{ text: "<reply>The first line arrives. " }, { wait: 10 }, { text: "Then another" }, { hold: later }, { text: " that must not show.</reply>" }], ignoreAbort: true }, { pieces: [{ text: "Going on." }] }],
      { channel: reply },
    );
    const work = runner.start({ messages: [user("Begin.")] });
    await clock.settle(clock.sleep(15));
    expect(sink.text).toBe("The first line arrives. Then another");

    work.stop();
    const records = recorder.records.length;
    const deltas = recorder.deltas.length;
    later.open();
    const outcome = await clock.settle(work.done);
    await clock.settle(clock.sleep(50));

    expect(outcome.status).toBe("stopped");
    expect(sink.text).toBe("The first line arrives. Then another");
    expect(recorder.records.slice(records).map((record) => record.event.kind)).toEqual(["agent_ended"]);
    expect(recorder.deltas).toHaveLength(deltas);
    expect(runner.idle).toBe(true);
    // The cut-short message left the transcript; the agent can be continued from where it stands.
    expect(runner.transcript.at(-1)?.role).toBe("user");
    const again = await clock.settle(runner.start({ message: "Go on." }).done);
    expect(again.status).toBe("done");
    expect(consistent(scripted.requests[1]!.messages)).toBe(true);
  });

  test("in the middle of a tool: the stop does not wait on it, its late answer and updates go nowhere, and the step stays with every call answered", async () => {
    const slowDone = gate();
    let slowSignal: AbortSignal | undefined;
    let lateUpdate: (() => void) | undefined;
    const quick = tool("quick", async () => said("quick answer"));
    const slow = tool("slow", async (_args, ctx) => {
      slowSignal = ctx.signal;
      lateUpdate = () => ctx.onUpdate(said("late update"));
      // Ignores its signal, as a careless tool might.
      await slowDone.opened;
      return said("slow answer");
    });
    const { runner, scripted, recorder, clock } = rigAgent(author, [{ pieces: [{ text: "Checking two things." }, { call: "quick" }, { call: "slow" }] }, { pieces: [{ text: "Fresh start." }] }], { tools: [quick, slow] });
    const work = runner.start({ messages: [user("Check.")] });
    await clock.settle(clock.sleep(5));
    expect(runner.idle).toBe(false);

    work.stop();
    const records = recorder.records.length;
    const outcome = await clock.settle(work.done);
    // The tool finishes after the stop, and tries to report.
    lateUpdate?.();
    slowDone.open();
    await clock.settle(clock.sleep(50));

    expect(outcome.status).toBe("stopped");
    expect(slowSignal?.aborted).toBe(true);
    expect(recorder.records.slice(records).map((record) => record.event.kind)).toEqual(["agent_ended"]);
    expect(scripted.requests).toHaveLength(1);
    expect(runner.idle).toBe(true);
    expect(consistent(runner.transcript as Message[])).toBe(true);
    // The call that finished keeps its answer; the one the stop left is answered as unfinished, never with its late answer.
    expect(runner.transcript.slice(-3).map((message) => [message.role, textOf(message)])).toEqual([
      ["assistant", "Checking two things."],
      ["toolResult", "quick answer"],
      ["toolResult", "Fixture: slow did not finish."],
    ]);
    // Continued, its next request is one a provider accepts.
    await clock.settle(runner.start({ message: "Again, briefly." }).done);
    expect(consistent(scripted.requests[1]!.messages)).toBe(true);
  });

  test("in the middle of tools that run one after another: a call the stop kept from starting is answered as unfinished too", async () => {
    const firstDone = gate();
    const first = tool("first", async () => (await firstDone.opened, said("first answer")), { sequential: true });
    const second = tool("second", async () => said("second answer"), { sequential: true });
    const { runner, clock } = rigAgent(author, [{ pieces: [{ call: "first" }, { call: "second" }] }], { tools: [first, second] });
    const work = runner.start({ messages: [user("Check.")] });
    await clock.settle(clock.sleep(5));

    work.stop();
    await clock.settle(work.done);
    firstDone.open();
    await clock.settle(clock.sleep(50));

    expect(consistent(runner.transcript as Message[])).toBe(true);
    expect(runner.transcript.slice(-3).map((message) => [message.role, textOf(message)])).toEqual([
      ["assistant", ""],
      ["toolResult", "Fixture: first did not finish."],
      ["toolResult", "Fixture: second did not finish."],
    ]);
  });

  /** A gate that waits on the player before every call (a permission asked), and counts what runs after a tool. */
  function asking(player: { opened: Promise<void> }): ToolGate & { afters: number } {
    const around = {
      afters: 0,
      before: async (): Promise<GateBefore> => (await player.opened, { remind: [] }),
      after: async (_call: unknown, result: LoopToolResult): Promise<GateAfter> => {
        around.afters += 1;
        return { result, remind: [] };
      },
    };
    return around;
  }

  test("while the gate is asked (a permission still open): the call never runs, even when the answer comes after the stop", async () => {
    const player = gate();
    const ran: string[] = [];
    const apply = tool("world_apply", async () => (ran.push("ran"), said("applied")));
    const around = asking(player);
    const { runner, scripted, clock } = rigAgent(author, [{ pieces: [{ call: "world_apply", args: { note: "open the vault" } }] }, { pieces: [{ text: "Done." }] }], { tools: [apply], gate: around });
    const work = runner.start({ messages: [user("Open the vault.")] });
    await clock.settle(clock.sleep(5));

    work.stop();
    const outcome = await clock.settle(work.done);
    // The player says yes once the turn has stopped.
    player.open();
    await clock.settle(clock.sleep(50));

    expect(outcome.status).toBe("stopped");
    expect(ran).toEqual([]);
    expect(around.afters).toBe(0);
    expect(scripted.requests).toHaveLength(1);
  });

  test("in the middle of a tool: what would run around its late result (rules on it, clipping) does not", async () => {
    const player = gate();
    player.open();
    const slowDone = gate();
    const slow = tool("slow", async () => (await slowDone.opened, said("slow answer")));
    const around = asking(player);
    const { runner, clock } = rigAgent(author, [{ pieces: [{ call: "slow" }] }], { tools: [slow], gate: around });
    const work = runner.start({ messages: [user("Check.")] });
    await clock.settle(clock.sleep(5));

    work.stop();
    await clock.settle(work.done);
    slowDone.open();
    await clock.settle(clock.sleep(50));

    expect(around.afters).toBe(0);
  });
});

describe("limits", () => {
  test("a call limit ends the work before the call past it, and says which limit", async () => {
    const step = tool("step", async () => said("stepped"));
    const answers = Array.from({ length: 5 }, () => ({ pieces: [{ call: "step" }] }));
    const { runner, scripted, recorder, clock } = rigAgent(author, answers, { tools: [step], limits: { calls: 2 } });

    const outcome = await clock.settle(runner.start({ messages: [user("Walk.")] }).done);

    expect(outcome.status).toBe("limit");
    expect(outcome.limit).toEqual({ limit: "calls", per: "agent", max: 2, value: 2, agent: author });
    expect(scripted.requests).toHaveLength(2);
    expect(recorder.of("limit")).toHaveLength(1);
    expect(consistent(runner.transcript as Message[])).toBe(true);
  });

  test("a time limit stops work that runs past it", async () => {
    const forever = gate();
    const wait = tool("wait", async () => (await forever.opened, said("never")));
    const { runner, clock } = rigAgent(author, [{ pieces: [{ call: "wait" }] }], { tools: [wait], limits: { time: 1_000 } });

    const outcome = await clock.settle(runner.start({ messages: [user("Wait.")] }).done);

    expect(outcome.status).toBe("limit");
    expect(outcome.limit?.limit).toBe("time");
    expect(outcome.limit?.value).toBeGreaterThanOrEqual(1_000);
  });

  test("a turn's limit is shared by its agents", async () => {
    const clock = new FakeClock();
    const recorder = new TraceRecorder();
    const turn = new Budget("turn", { calls: 3 });
    const step = tool("step", async () => said("stepped"));
    const answers = () => Array.from({ length: 4 }, () => ({ pieces: [{ call: "step" }, { wait: 1 }] }));
    const one = rigAgent({ id: "one", definition: "a" }, answers(), { clock, recorder, tools: [step], turn });
    const two = rigAgent({ id: "two", definition: "b" }, answers(), { clock, recorder, trace: one.trace, tools: [step], turn });

    const outcomes = await clock.settle(Promise.all([one.runner.start({ messages: [user("Go.")] }).done, two.runner.start({ messages: [user("Go.")] }).done]));

    expect(one.scripted.requests.length + two.scripted.requests.length).toBe(3);
    expect(outcomes.map((outcome) => [outcome.status, outcome.limit?.per])).toEqual([
      ["limit", "turn"],
      ["limit", "turn"],
    ]);
    expect(turn.used.calls).toBe(3);
  });
});
