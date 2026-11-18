// Claim g (§18.1 row 0.2, §5.4, §13.3, Appendix D.1): when what is being written matches a rule,
// the call is stopped, what was not yet shown is dropped, the rule's text is added and the agent
// goes on. What was released never shows the matched sentence and never repeats what was shown.
// With such a rule in force the reply is held back by one sentence; without one, not at all.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import type { StreamRules, TextChannel, Written } from "../../src/loop";
import { heldSentences, MessageReply, sentenceEnds, TagReply } from "../../src/reply";
import { fired, type Reply, replyMissing, rigAgent, said, SinkRecorder, textOf, tool, user } from "./support";

const author = { id: "author", definition: "author" };
const tags = { reply: "reply", intent: "intent" };
const PHRASE = "a shiver ran down";
const RULE = "Fixture rule: never write that phrase. Rewrite the sentence without it.";

/** The example rule `banned-phrases`, as the rules would work it: a pattern on the reply, that interrupts, once per turn. */
function bannedPhrase(inForce: boolean): StreamRules & { fired: number } {
  const rules = {
    coverReply: inForce,
    fired: 0,
    check: (written: Written) => {
      if (!inForce || rules.fired > 0 || written.reply?.includes(PHRASE) !== true) return undefined;
      rules.fired += 1;
      return { ...fired("banned-phrases", "stream", RULE, { watched: "reply", matched: PHRASE }), interrupt: true };
    },
  };
  return rules;
}

/** Records, after every release, what the reply had written and not shown. */
function watched(reply: TagReply): { channel: TextChannel; held: string[] } {
  const held: string[] = [];
  const channel: TextChannel = {
    marks: reply.marks,
    begin: () => reply.begin(),
    write: (piece) => reply.write(piece),
    release: () => {
      reply.release();
      held.push(reply.reply.slice(reply.shown.length));
    },
    cut: () => reply.cut(),
    end: (message: AssistantMessage) => reply.end(message),
    get reply() {
      return reply.reply;
    },
    get shown() {
      return reply.shown;
    },
    tail: () => reply.tail(),
  };
  return { channel, held };
}

const firstCall: Reply = {
  pieces: [
    { text: "<intent>Dread first, then the reveal.</intent><reply>The hall is dark. " },
    { wait: 10 },
    { text: "Her candle gutters. " },
    { wait: 10 },
    { text: "Something moves, and a shiv" },
    { wait: 10 },
    { text: "er ran down her spine. " },
    { wait: 10 },
    { text: "She runs.</reply>" },
  ],
};
const secondCall: Reply = { pieces: [{ text: "<reply>Something moves; the cold reaches her before the sound does. " }, { wait: 10 }, { text: "She runs.</reply>" }] };

function setUp(inForce: boolean) {
  const sink = new SinkRecorder();
  const rules = bannedPhrase(inForce);
  const released: string[] = [];
  const reply = new TagReply({ tags, sink, heldSentences: heldSentences(rules, DEFAULT_SETTINGS.heldSentences), tailSentences: DEFAULT_SETTINGS.tailSentences, onReleased: (text) => released.push(text) });
  const { channel, held } = watched(reply);
  const notes: string[] = [];
  const note = tool("scene_note", async () => (notes.push("noted"), said("noted")));
  const rig = rigAgent(author, [firstCall, secondCall], { tools: [note], channel, stream: rules });
  return { ...rig, sink, rules, reply, held, released, notes };
}

describe("a rule on the stream", () => {
  test("stops the call at the match, drops what was not shown, adds the rule's text, and the agent goes on", async () => {
    const { runner, scripted, recorder, clock, sink, rules, held, released } = setUp(true);

    const outcome = await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect(outcome.status).toBe("done");
    expect(rules.fired).toBe(1);
    expect(scripted.requests).toHaveLength(2);
    // Never the matched sentence; never anything twice.
    expect(sink.text).toBe("The hall is dark. Her candle gutters. Something moves; the cold reaches her before the sound does. She runs.");
    expect(sink.text).not.toContain("shiv");
    expect(sink.pieces.map((piece) => piece.text).join("")).toBe(sink.text);
    expect(released).toEqual([sink.text]);
    const [firing] = recorder.of("rule_fired").map((record) => record.event.firing);
    expect(firing).toMatchObject({ rule: "banned-phrases", moment: "stream", watched: "reply", matched: PHRASE, action: "cut", dropped: "Something moves, and a shiver ran down her spine. " });
    expect(recorder.of("call_ended").map((record) => record.event.stop)).toEqual(["cut", "stop"]);
    // The next call: the cut message is gone, and the rule's text comes with where the player's view ends.
    const next = scripted.requests[1]!.messages;
    expect(next.some((message) => message.role === "assistant")).toBe(false);
    const last = next.at(-1)!;
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content) ? last.content.map((part) => (part.type === "text" ? part.text : "")) : []).toEqual([RULE, "[Already shown]\nThe hall is dark. Her candle gutters. \n[Go on from there]"]);
    expect(textOf(last)).not.toContain("shiv");
    // Held back by one sentence at most: what waited never held a whole sentence.
    expect(held.length).toBeGreaterThan(3);
    for (const waiting of held) expect(sentenceEnds(waiting)).toEqual([]);
    expect(held).toContain("Something moves, and a shiv");
  });

  test("with no such rule in force the reply is not held back at all", async () => {
    const { runner, clock, sink, held, scripted } = setUp(false);

    await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect(scripted.requests).toHaveLength(1);
    for (const waiting of held) expect(waiting).toBe("");
    expect(sink.pieces.map((piece) => piece.text)).toEqual(["The hall is dark. ", "Her candle gutters. ", "Something moves, and a shiv", "er ran down her spine. ", "She runs."]);
  });

  // The provider can be ahead of pi's loop: when the matching piece is read, the message's end may
  // already be on its way, and pi then ends the message as the provider did, not as stopped. The
  // whole message comes in one burst, the match in its last piece, as a fast provider sends it.
  const burst = (calls: boolean): Reply => ({
    pieces: [
      ...(calls ? [{ call: "scene_note", args: { note: "she fled", closing: true } }] : []),
      ...["<reply>Something", " moves", " in", " the", " dark,", " and a shiv"].map((text) => ({ text })),
      { text: "er ran down her spine. She runs.</reply>" },
    ],
  });
  const goOn = "[Already shown]\n\n[Go on from there]";

  test("a message the provider had already finished leaves no trace when a rule stops it: not its words, nor its calls, nor answers to them", async () => {
    const sink = new SinkRecorder();
    const rules = bannedPhrase(true);
    const reply = new TagReply({ tags, sink, heldSentences: heldSentences(rules, DEFAULT_SETTINGS.heldSentences), tailSentences: DEFAULT_SETTINGS.tailSentences });
    const notes: string[] = [];
    const note = tool("scene_note", async () => (notes.push("noted"), said("noted")));
    const { runner, scripted, recorder, clock } = rigAgent(author, [burst(true), secondCall], { tools: [note], channel: reply, stream: rules });

    const outcome = await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect(outcome.status).toBe("done");
    expect(rules.fired).toBe(1);
    expect(scripted.requests).toHaveLength(2);
    const next = scripted.requests[1]!.messages;
    expect(next.filter((message) => message.role !== "system").map((message) => [message.role, textOf(message)])).toEqual([
      ["user", "She enters the hall."],
      ["user", `${RULE}${goOn}`],
    ]);
    // The cut message's call never ran and is in no record as if it had.
    expect(notes).toEqual([]);
    expect(recorder.of("tool_started")).toHaveLength(0);
    expect(recorder.of("tool_ended")).toEqual([]);
    expect(sink.text).toBe("Something moves; the cold reaches her before the sound does. She runs.");
  });

  test("a message the provider had already finished is no run's end when a rule stops it: the rules due then do not fire on it", async () => {
    const sink = new SinkRecorder();
    const rules = bannedPhrase(true);
    const reply = new TagReply({ tags, sink, heldSentences: heldSentences(rules, DEFAULT_SETTINGS.heldSentences), tailSentences: DEFAULT_SETTINGS.tailSentences });
    const missing = replyMissing(() => reply.released, "Fixture rule: the turn is ending with no reply. Write it now.");
    const rewritten: Reply = { pieces: [{ text: "<reply>Something moves; the cold reaches her first. She runs.</reply>" }] };
    const { runner, scripted, recorder, clock } = rigAgent(author, [burst(false), rewritten], { channel: reply, stream: rules, runEnd: missing });

    const outcome = await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect(outcome.status).toBe("done");
    expect(missing.fired).toBe(0);
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[1]!.messages.filter((message) => message.role !== "system").map(textOf)).toEqual(["She enters the hall.", `${RULE}${goOn}`]);
    expect(recorder.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.action])).toEqual([["banned-phrases", "cut"]]);
    expect(sink.text).toBe("Something moves; the cold reaches her first. She runs.");
  });
});

describe("a reply a rule cut once some of it was shown", () => {
  const repeated: Reply = { pieces: [{ text: "<reply>The hall is dark. Her candle gutters. " }, { wait: 10 }, { text: "Something moves; the cold reaches her first. She runs.</reply>" }] };

  test("in the tag form, gone on with from its start, is one reply with nothing twice, released, and the cut call is booked", async () => {
    const sink = new SinkRecorder();
    const rules = bannedPhrase(true);
    const reply = new TagReply({ tags, sink, heldSentences: heldSentences(rules, DEFAULT_SETTINGS.heldSentences), tailSentences: DEFAULT_SETTINGS.tailSentences });
    const missing = replyMissing(() => reply.released, "Fixture rule: the turn is ending with no reply. Write it now.");
    const lines: unknown[] = [];
    const texts = { continueAfterRule: (fields: object) => (lines.push(fields), "[Go on]") };
    const { runner, recorder, clock } = rigAgent(author, [firstCall, repeated], { channel: reply, stream: rules, runEnd: missing, texts });

    await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect(lines).toEqual([{ shown: "The hall is dark. Her candle gutters. ", form: { tags: true }, tags }]);
    expect(sink.text).toBe("The hall is dark. Her candle gutters. Something moves; the cold reaches her first. She runs.");
    expect(reply.released).toBe(true);
    expect(missing.fired).toBe(0);
    const [cut] = recorder.of("call_ended").map((record) => record.event);
    expect(cut?.stop).toBe("cut");
    expect(cut?.usage.input).toBeGreaterThan(0);
    expect(cut?.usage.output).toBeGreaterThan(0);
  });

  test("as a message's streamed text, gone on with from its last sentence, is joined with nothing twice", async () => {
    const sink = new SinkRecorder();
    const rules = bannedPhrase(true);
    const reply = new MessageReply({ sink, stream: true, heldSentences: heldSentences(rules, DEFAULT_SETTINGS.heldSentences), tailSentences: DEFAULT_SETTINGS.tailSentences });
    const first: Reply = { pieces: [{ text: "The hall is dark. Her candle gutters. " }, { wait: 10 }, { text: "Something moves, and a shiver ran down her spine. " }] };
    const again: Reply = { pieces: [{ text: "Her candle gutters.\nSomething moves; the cold reaches her first." }] };
    const { runner, clock } = rigAgent(author, [first, again], { channel: reply, stream: rules });

    await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect(sink.text).toBe("The hall is dark. Her candle gutters. Something moves; the cold reaches her first.");
    expect(reply.released).toBe(true);
  });
});
