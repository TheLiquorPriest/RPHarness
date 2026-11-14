// Claim e (§18.1 row 0.2, §10.10 "Stop"): a stop in the middle of a stream or of a tool emits
// nothing further but the agent's end, and leaves the agent consistent: idle, and with a
// transcript it can be continued from. Then the limits (§10.11), which end work the same way.
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { Budget } from "../../src/loop";
import { REPLY_DEFAULTS, TagReply } from "../../src/reply";
import { FakeClock, gate, rigAgent, said, SinkRecorder, tool, TraceRecorder, user } from "./support";

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

  test("in the middle of a tool: the stop does not wait on it, its late answer and updates go nowhere, and the unfinished step leaves the transcript", async () => {
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
    expect(runner.transcript.at(-1)?.role).toBe("user");
    // Continued, its next request is one a provider accepts.
    await clock.settle(runner.start({ message: "Again, briefly." }).done);
    expect(consistent(scripted.requests[1]!.messages)).toBe(true);
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
