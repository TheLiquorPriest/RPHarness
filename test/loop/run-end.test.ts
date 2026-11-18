// Claims b and h (§18.1 row 0.2, §13.3, §5.4): a rule due at a run's end puts its text in as a
// follow-up and the agent gets exactly one more call. After the reply went out, a second reply gets
// the same plain line in every form (§10.7): a reply tag, or in the two-step form a message of text
// with no work left, is answered once in the generation, never in a loop.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import type { Fired, RunEndRules } from "../../src/loop";
import { MessageReply, ReplyDesk, TagReply } from "../../src/reply";
import { fired, replyMissing, rigAgent, SinkRecorder, textOf, user } from "./support";

const author = { id: "author", definition: "author" };
const tags = { reply: "reply", intent: "intent" };
const RULE = "Fixture rule: the turn is ending with no reply. Write it now.";

function writer(): { sink: SinkRecorder; reply: TagReply } {
  const sink = new SinkRecorder();
  return { sink, reply: new TagReply({ tags, sink, heldSentences: 0, tailSentences: DEFAULT_SETTINGS.tailSentences }) };
}

describe("a rule at a run's end", () => {
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
});

describe("after the reply went out", () => {
  const SECOND = "Fixture: the reply for this turn already went out.";
  const AFTER = "Fixture rule: say what changed in the scene.";

  /** A rule due at a run's end once, whatever was released: the work after the reply (§10.9). */
  function onceAtEnd(): RunEndRules & { fired: number } {
    const rules = {
      fired: 0,
      due: (): Fired[] => {
        if (rules.fired > 0) return [];
        rules.fired += 1;
        return [fired("scene-changes", "run-end", AFTER)];
      },
    };
    return rules;
  }

  /** The two-step form, with the second-reply line, which it says as the tag form says it. */
  function twoStep(sink: SinkRecorder, stream: boolean, claim?: () => boolean): MessageReply {
    const options = { sink, stream, heldSentences: 0, tailSentences: DEFAULT_SETTINGS.tailSentences, second: SECOND, ...(claim !== undefined ? { claim } : {}) };
    return new MessageReply(options);
  }

  for (const stream of [false, true]) {
    const form = stream ? "the two-step form, streamed" : "the two-step form";

    test(`in ${form}, a message of text alone after the reply is a second reply: shown to nobody, and answered with the plain line once, as in the tag form, after the rules due at the run's end`, async () => {
      const sink = new SinkRecorder();
      const reply = twoStep(sink, stream);
      const rules = onceAtEnd();
      const { runner, scripted, clock } = rigAgent(author, [{ pieces: [{ text: "The lamp flares." }] }, { pieces: [{ text: "The oil runs low; nothing else changed." }] }, { pieces: [{ text: "Understood." }] }], { channel: reply, runEnd: rules });

      const outcome = await clock.settle(runner.start({ messages: [user("Light the lamp.")] }).done);

      expect(outcome.status).toBe("done");
      expect(rules.fired).toBe(1);
      expect(scripted.requests).toHaveLength(3);
      // The rule due at the run's end went in after the reply's message; the text alone after it was a second reply, answered with the line, and the run ended on the next.
      expect(scripted.requests[1]!.messages.filter((message) => message.role === "user").map(textOf)).toEqual(["Light the lamp.", AFTER]);
      expect(scripted.requests[2]!.messages.filter((message) => message.role === "user").map(textOf)).toEqual(["Light the lamp.", AFTER, SECOND]);
      expect(sink.text).toBe("The lamp flares.");
      expect(reply.released).toBe(true);
    });

    test(`in ${form}, text alone after the reply went out another way (a file released) is answered the same way`, async () => {
      const desk = new ReplyDesk();
      desk.claim("file");
      desk.out();
      const sink = new SinkRecorder();
      const reply = twoStep(sink, stream, () => desk.claim("message"));
      const { runner, scripted, clock } = rigAgent(author, [{ pieces: [{ text: "Turn settled." }] }, { pieces: [{ text: "Understood." }] }], { channel: reply });

      const outcome = await clock.settle(runner.start({ messages: [user("Light the lamp.")] }).done);

      expect(outcome.status).toBe("done");
      expect(scripted.requests).toHaveLength(2);
      expect(textOf(scripted.requests[1]!.messages.at(-1)!)).toBe(SECOND);
      expect(sink.text).toBe("");
      expect(reply.released).toBe(false);
    });
  }

  test("in the tag form, a reply tag after the reply is told once that the reply went out, and the run ends", async () => {
    const sink = new SinkRecorder();
    const reply = new TagReply({ tags, sink, heldSentences: 0, tailSentences: DEFAULT_SETTINGS.tailSentences, second: SECOND });
    // More answers than the work may take, every one of them a reply tag.
    const texts = ["<reply>The lamp flares.</reply>", "<reply>It flares again.</reply>", "<reply>And again.</reply>", "<reply>Once more.</reply>", "<reply>More.</reply>", "<reply>Done.</reply>"];
    const { runner, scripted, clock } = rigAgent(author, texts.map((text) => ({ pieces: [{ text }] })), { channel: reply, runEnd: onceAtEnd(), limits: { calls: texts.length } });

    const outcome = await clock.settle(runner.start({ messages: [user("Light the lamp.")] }).done);

    expect(outcome.status).toBe("done");
    expect(sink.text).toBe("The lamp flares.");
    // The reply, the rule's call, and one call that hears the reply already went out: then the run ends.
    expect(scripted.requests.map((request) => textOf(request.messages.at(-1)!))).toEqual(["Light the lamp.", AFTER, SECOND]);
  });
});
