// Every time the runner writes is the host's clock's (here, the rig's, which starts far from the
// machine's own time and moves only when a script waits): an unfinished call's answer, every message
// the runner gives an agent, and in the trace the moment the model began writing each tool call
// (pi's `toolcall_start`), which the floor test reads to take the intent record's own time out of
// "first words" on a two-step connection (§17.1). Everything here is invented.
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { FakeClock, gate, replyMissing, rigAgent, said, tool, user } from "./support";

const author = { id: "author", definition: "author" };

/** A start no machine's clock shows today: a time read from the machine would not match it. */
const RIG_START = 7_000;

/** The time of each message of `role` in a transcript, after the first `from`. */
function times(transcript: readonly AgentMessage[], role: string, from = 0): number[] {
  return transcript.slice(from).flatMap((message) => ("role" in message && message.role === role && "timestamp" in message ? [message.timestamp] : []));
}

describe("the host's clock", () => {
  test("every message the runner gives an agent carries the rig's time: a rule due at the run's end, and a message that continues its work", async () => {
    const clock = new FakeClock(RIG_START);
    const { runner } = rigAgent(author, [{ pieces: [{ wait: 100 }, { text: "Quiet." }] }, { pieces: [{ wait: 50 }, { text: "Quiet, still." }] }, { pieces: [{ wait: 25 }, { text: "The lamp is lit." }] }], {
      clock,
      runEnd: replyMissing(() => false, "Fixture rule: the reply is still owed."),
    });

    await clock.settle(runner.start({ messages: [user("Look around.")] }).done);
    const before = runner.transcript.length;
    await clock.settle(runner.start({ message: "Light the lamp." }).done);

    // The rule's text went in when the first call ended (at 7,100); the message that continues the work came once the second had (at 7,150).
    expect(times(runner.transcript, "user", 1)).toEqual([RIG_START + 100, RIG_START + 150]);
    expect(times(runner.transcript, "user", before)).toEqual([RIG_START + 150]);
  });

  test("an unfinished call's answer carries the rig's time of the stop", async () => {
    const clock = new FakeClock(RIG_START);
    const forever = gate();
    const wait = tool("wait", async () => (await forever.opened, said("never")));
    const { runner } = rigAgent(author, [{ pieces: [{ wait: 40 }, { call: "wait" }] }], { clock, tools: [wait] });

    const work = runner.start({ messages: [user("Wait.")] });
    await clock.settle(clock.sleep(60));
    work.stop();
    expect((await clock.settle(work.done)).status).toBe("stopped");

    const answer = runner.transcript.at(-1);
    expect(answer).toMatchObject({ role: "toolResult", toolName: "wait", timestamp: RIG_START + 60 });
  });

  test("a call whose model writes text and then a tool call records both moments, by the rig's time, in order", async () => {
    const clock = new FakeClock(RIG_START);
    const look = tool("look", async () => said("a quiet room"));
    const { runner, recorder } = rigAgent(author, [{ pieces: [{ wait: 30 }, { text: "Let me look." }, { wait: 250 }, { call: "look" }] }, { pieces: [{ text: "Quiet." }] }], { clock, tools: [look] });

    await clock.settle(runner.start({ messages: [user("Look around.")] }).done);

    const firstWords = recorder.deltas.find((delta) => delta.call === 1 && delta.text !== undefined)?.at;
    const began = recorder.of("call_ended")[0]?.event.toolCalls[0]?.began;
    expect([firstWords, began]).toEqual([RIG_START + 30, RIG_START + 280]);
  });
});
