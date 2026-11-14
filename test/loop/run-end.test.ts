// Claims b and h (§18.1 row 0.2, §13.3, §5.4): a rule due at a run's end puts its text in as a
// follow-up and the agent gets exactly one more call, whether the run would have ended on closing
// calls or with no calls left.
import { describe, expect, test } from "bun:test";
import { REPLY_DEFAULTS, TagReply } from "../../src/reply";
import { replyMissing, rigAgent, said, SinkRecorder, textOf, tool, user } from "./support";

const author = { id: "author", definition: "author" };
const tags = { reply: "reply", intent: "intent" };
const RULE = "Fixture rule: the turn is ending with no reply. Write it now.";

function writer(): { sink: SinkRecorder; reply: TagReply } {
  const sink = new SinkRecorder();
  return { sink, reply: new TagReply({ tags, sink, heldSentences: 0, tailSentences: REPLY_DEFAULTS.tailSentences }) };
}

const tools = () => [tool("scene_note", async () => said("noted")), tool("todo", async () => said("listed"))];

describe("a rule at a run's end", () => {
  test("closing calls while the rule is due: the run does not end on them, the rule's text follows, and there is exactly one more call", async () => {
    const { sink, reply } = writer();
    const rules = replyMissing(() => reply.released, RULE);
    const { runner, scripted, recorder, clock } = rigAgent(
      author,
      [
        { pieces: [{ text: "<intent>Note it, then answer.</intent>" }, { call: "scene_note", args: { note: "lamp lit", closing: true } }, { call: "todo", args: { closing: true } }] },
        { pieces: [{ text: "<reply>The lamp flares.</reply>" }] },
      ],
      { tools: tools(), channel: reply, runEnd: rules },
    );

    const outcome = await clock.settle(runner.start({ messages: [user("Light the lamp.")] }).done);

    expect(outcome.status).toBe("done");
    expect(scripted.requests).toHaveLength(2);
    expect(rules.fired).toBe(1);
    // Both closing calls came back clean and ended their batch: pi still took the follow-up.
    expect(recorder.of("tool_ended").map((record) => record.event.endedRun)).toEqual([true, true]);
    const second = scripted.requests[1]!.messages;
    expect(second.slice(-3).map((message) => message.role)).toEqual(["toolResult", "toolResult", "user"]);
    expect(textOf(second.at(-1)!)).toBe(RULE);
    expect(sink.text).toBe("The lamp flares.");
    const firing = recorder.of("rule_fired").map((record) => record.event.firing);
    expect(firing.map((f) => [f.rule, f.moment, f.action, f.fact?.name])).toEqual([["reply-missing", "run-end", "follow-up", "reply.released"]]);
    // The agent ended after the second call, not between them.
    expect(recorder.kinds("author").filter((kind) => kind !== "tool_started")).toEqual(["agent_started", "call_started", "call_ended", "tool_ended", "tool_ended", "rule_fired", "call_started", "call_ended", "agent_ended"]);
  });

  test("with no calls left and the rule due, its text goes in as a follow-up and the run goes on once", async () => {
    const { sink, reply } = writer();
    const rules = replyMissing(() => reply.released, RULE);
    const { runner, scripted, clock } = rigAgent(author, [{ pieces: [{ text: "<intent>Answer later.</intent>" }] }, { pieces: [{ text: "<reply>Later is now.</reply>" }] }], { channel: reply, runEnd: rules });

    const outcome = await clock.settle(runner.start({ messages: [user("Answer me.")] }).done);

    expect(outcome.status).toBe("done");
    expect(scripted.requests).toHaveLength(2);
    expect(textOf(scripted.requests[1]!.messages.at(-1)!)).toBe(RULE);
    expect(sink.text).toBe("Later is now.");
  });

  test("a rule that fires once per turn adds one call, however the agent answers it", async () => {
    const { sink, reply } = writer();
    const rules = replyMissing(() => reply.released, RULE);
    const { runner, scripted, clock } = rigAgent(author, [{ pieces: [{ text: "Thinking aloud." }] }, { pieces: [{ text: "Still no reply." }] }, { pieces: [{ text: "<reply>unused</reply>" }] }], { channel: reply, runEnd: rules });

    const outcome = await clock.settle(runner.start({ messages: [user("Answer me.")] }).done);

    expect(outcome.status).toBe("done");
    expect(scripted.requests).toHaveLength(2);
    expect(sink.text).toBe("");
  });

  test("with nothing due, the closing calls end the run after one call", async () => {
    const { reply } = writer();
    const rules = replyMissing(() => reply.released, RULE);
    const { runner, scripted, clock } = rigAgent(author, [{ pieces: [{ text: "<reply>Done already.</reply>" }, { call: "todo", args: { closing: true } }] }], { tools: tools(), channel: reply, runEnd: rules });

    await clock.settle(runner.start({ messages: [user("Quick one.")] }).done);

    expect(scripted.requests).toHaveLength(1);
    expect(rules.fired).toBe(0);
  });
});
