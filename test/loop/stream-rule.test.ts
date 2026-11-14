// Claim g (§18.1 row 0.2, §5.4, §13.3, Appendix D.1): when what is being written matches a rule,
// the call is stopped, what was not yet shown is dropped, the rule's text is added and the agent
// goes on. What was released never shows the matched sentence and never repeats what was shown.
// With such a rule in force the reply is held back by one sentence; without one, not at all.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import type { StreamRules, TextChannel, Written } from "../../src/loop";
import { heldSentences, REPLY_DEFAULTS, sentenceEnds, TagReply } from "../../src/reply";
import { fired, type Reply, rigAgent, said, SinkRecorder, textOf, tool, user } from "./support";

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
    { call: "scene_note", args: { note: "she fled", closing: true } },
  ],
};
const secondCall: Reply = { pieces: [{ text: "<reply>Something moves; the cold reaches her before the sound does. " }, { wait: 10 }, { text: "She runs.</reply>" }, { call: "scene_note", args: { note: "she fled", closing: true } }] };

function setUp(inForce: boolean) {
  const sink = new SinkRecorder();
  const rules = bannedPhrase(inForce);
  const released: string[] = [];
  const reply = new TagReply({ tags, sink, heldSentences: heldSentences(rules, REPLY_DEFAULTS.heldSentences), tailSentences: REPLY_DEFAULTS.tailSentences, onReleased: (text) => released.push(text) });
  const { channel, held } = watched(reply);
  const notes: string[] = [];
  const note = tool("scene_note", async () => (notes.push("noted"), said("noted")));
  const rig = rigAgent(author, [firstCall, secondCall], { tools: [note], channel, stream: rules });
  return { ...rig, sink, rules, reply, held, released, notes };
}

describe("a rule on the stream", () => {
  test("stops the call at the match, drops what was not shown, adds the rule's text, and the agent goes on", async () => {
    const { runner, scripted, recorder, clock, sink, rules, held, released, notes } = setUp(true);

    const outcome = await clock.settle(runner.start({ messages: [user("She enters the hall.")] }).done);

    expect(outcome.status).toBe("done");
    expect(rules.fired).toBe(1);
    expect(scripted.requests).toHaveLength(2);
    // Never the matched sentence; never anything twice.
    expect(sink.text).toBe("The hall is dark. Her candle gutters. Something moves; the cold reaches her before the sound does. She runs.");
    expect(sink.text).not.toContain("shiv");
    expect(sink.pieces.map((piece) => piece.text).join("")).toBe(sink.text);
    expect(released).toEqual([sink.text]);
    // The cut call's closing call never ran; the call after it did.
    expect(notes).toEqual(["noted"]);
    const [firing] = recorder.of("rule_fired").map((record) => record.event.firing);
    expect(firing).toMatchObject({ rule: "banned-phrases", moment: "stream", watched: "reply", matched: PHRASE, action: "cut", dropped: "Something moves, and a shiver ran down her spine. " });
    expect(recorder.of("call_ended").map((record) => record.event.stop)).toEqual(["cut", "toolUse"]);
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
});
