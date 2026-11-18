// Claim a (§18.1 row 0.2, §10.7): an intent record and a reply in tags, in a message that makes no
// tool call, make one model call, and the reply reaches the sink as it streams, within 50 ms of the
// model's piece; a message that makes tool calls gets a further call.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import { TagReply } from "../../src/reply";
import { type Reply, rigAgent, said, SinkRecorder, tool, user } from "./support";

const author = { id: "author", definition: "author" };
const tags = { reply: "reply", intent: "intent" };

function writer(): { sink: SinkRecorder; reply: TagReply } {
  const sink = new SinkRecorder();
  return { sink, reply: new TagReply({ tags, sink, heldSentences: 0, tailSentences: DEFAULT_SETTINGS.tailSentences }) };
}

/** The intent's closing tag is split mid-name on purpose. Pieces come 20 ms apart on the fake clock, as a provider's do. */
function simpleTurn(calls: boolean): Reply {
  return {
    pieces: [
      { text: "<intent>Answer the knock" },
      { wait: 20 },
      { text: "; keep it brief.</in" },
      { wait: 20 },
      { text: "tent><reply>The door creaks open." },
      { wait: 20 },
      { text: " Rain blows in" },
      { wait: 20 },
      { text: " across the floor.</reply>" },
      ...(calls ? [{ call: "scene_note", args: { note: "door open" } }, { call: "todo", args: { note: "nothing open" } }] : []),
    ],
  };
}

describe("a simple turn", () => {
  test("an intent and a reply in tags, in a message that makes no call, make exactly one model call, and the reply streams to the sink", async () => {
    const { sink, reply } = writer();
    const { runner, scripted, clock } = rigAgent(author, [simpleTurn(false)], { channel: reply });

    const outcome = await clock.settle(runner.start({ messages: [user("A knock at the door.")] }).done);

    expect(outcome.status).toBe("done");
    expect(scripted.requests).toHaveLength(1);
    expect(sink.text).toBe("The door creaks open. Rain blows in across the floor.");
    expect(reply.released).toBe(true);

    // Streamed: the sink had each piece before the model pushed the next one.
    const pushed = (scripted.requests[0]?.pushed ?? []).filter((piece) => piece.kind === "text");
    const firstReply = pushed.find((piece) => piece.text.includes("<reply>"));
    expect(sink.pieces.map((piece) => piece.text)).toEqual(["The door creaks open.", " Rain blows in", " across the floor."]);
    expect(sink.pieces[0]!.wall).toBeLessThan(pushed[3]!.wall);
    expect(sink.pieces[1]!.wall).toBeLessThan(pushed[4]!.wall);
    expect(sink.pieces[0]!.wall - firstReply!.wall).toBeLessThan(50);
  });

  test("the reply's first piece reaches the sink within 50 ms of the model's, turn after turn", async () => {
    const delays: number[] = [];
    for (let turn = 0; turn < 25; turn += 1) {
      const { sink, reply } = writer();
      const { runner, scripted, clock } = rigAgent(author, [simpleTurn(false)], { channel: reply });
      await clock.settle(runner.start({ messages: [user("A knock at the door.")] }).done);
      const firstReply = scripted.requests[0]?.pushed.find((piece) => piece.text.includes("<reply>"));
      delays.push(sink.pieces[0]!.wall - firstReply!.wall);
    }
    expect(Math.max(...delays)).toBeLessThan(50);
  });

  test("the same message with tool calls gets a further call", async () => {
    const { reply } = writer();
    const tools = [tool("scene_note", async () => said("noted")), tool("todo", async () => said("listed"))];
    const { runner, scripted, clock } = rigAgent(author, [simpleTurn(true), { pieces: [{ text: "Done." }] }], { tools, channel: reply });
    await clock.settle(runner.start({ messages: [user("A knock at the door.")] }).done);
    expect(scripted.requests).toHaveLength(2);
  });
});
