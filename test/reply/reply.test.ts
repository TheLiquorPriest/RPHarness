import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import type { StreamRules } from "../../src/loop";
import { heldSentences, ReplyDesk, TagReply } from "../../src/reply";

const tags = { reply: "reply", intent: "intent" };
const anyMessage = {} as AssistantMessage;

function reply(held = 0): { channel: TagReply; sent: string[]; intents: string[]; released: string[] } {
  const sent: string[] = [];
  const intents: string[] = [];
  const released: string[] = [];
  const channel = new TagReply({ tags, sink: { content: (text) => sent.push(text) }, heldSentences: held, tailSentences: 2, onIntent: (text) => intents.push(text), onReleased: (text) => released.push(text) });
  return { channel, sent, intents, released };
}

/** Writes each piece as the runner would: write, then release. */
function stream(channel: TagReply, pieces: string[]): void {
  for (const piece of pieces) {
    channel.write(piece);
    channel.release();
  }
}

describe("the reply in the tag form", () => {
  test("streams the reply as written; the intent record and working text never reach the chat", () => {
    const { channel, sent, intents, released } = reply();
    channel.begin();
    stream(channel, ["<intent>Short and", " tense.</intent>Looking.<reply>The ", "lamp gutters", ".</reply>After."]);
    channel.end(anyMessage);
    expect(sent).toEqual(["The ", "lamp gutters", "."]);
    expect(intents).toEqual(["Short and tense."]);
    expect(released).toEqual(["The lamp gutters."]);
    expect(channel.released).toBe(true);
  });

  test("one reply per generation: a second reply after the first was released is not shown", () => {
    const { channel, sent, released } = reply();
    channel.begin();
    stream(channel, ["<reply>First.</reply>"]);
    channel.end(anyMessage);
    channel.begin();
    stream(channel, ["<reply>Second.</reply>"]);
    channel.end(anyMessage);
    expect(sent.join("")).toBe("First.");
    expect(released).toEqual(["First."]);
  });

  test("a reply cut by a rule stays open: the next message's reply tag goes on with it, and what was dropped never shows", () => {
    const { channel, sent, released } = reply(1);
    channel.begin();
    stream(channel, ["<reply>One. Two. Thr"]);
    expect(channel.cut()).toBe("Thr");
    expect(channel.tail()).toBe("One. Two. ");
    channel.begin();
    stream(channel, ["<reply>Three. Four.</reply>"]);
    channel.end(anyMessage);
    expect(sent.join("")).toBe("One. Two. Three. Four.");
    expect(released).toEqual(["One. Two. Three. Four."]);
  });

  test("a closing tag read in the same piece as a cut does not release the reply", () => {
    const { channel, sent } = reply(1);
    channel.begin();
    channel.write("<reply>Kept. Bad end.</reply>");
    expect(channel.cut()).toBe("Kept. Bad end.");
    expect(sent).toEqual([]);
    expect(channel.released).toBe(false);
  });

  test("a reply left open when its message ends is released", () => {
    const { channel, sent, released } = reply(1);
    channel.begin();
    stream(channel, ["<reply>No closing tag. Still the reply"]);
    channel.end(anyMessage);
    expect(sent.join("")).toBe("No closing tag. Still the reply");
    expect(released).toHaveLength(1);
  });

  test("held back by one sentence only while a rule that interrupts covers the reply", () => {
    const covering: StreamRules = { coverReply: true, check: () => undefined };
    const elsewhere: StreamRules = { coverReply: false, check: () => undefined };
    expect(heldSentences(covering, DEFAULT_SETTINGS.heldSentences)).toBe(1);
    expect(heldSentences(elsewhere, DEFAULT_SETTINGS.heldSentences)).toBe(0);
    expect(heldSentences(undefined, DEFAULT_SETTINGS.heldSentences)).toBe(0);
  });

  test("the reply is taken only as its first text goes out: one cut before anything of it showed leaves it free for another way", () => {
    const desk = new ReplyDesk();
    const sent: string[] = [];
    const channel = new TagReply({ tags, sink: { content: (text) => sent.push(text) }, heldSentences: 1, tailSentences: 2, claim: () => desk.claim("tags") });
    channel.begin();
    stream(channel, ["<reply>Something moves, and a shiv"]);
    channel.cut();
    expect(sent).toEqual([]);
    expect(desk.taken).toBe(false);
    // Written again, it is this form's from its first sentence out.
    channel.begin();
    stream(channel, ["<reply>The cold reaches her first. ", "She runs.</reply>"]);
    channel.end(anyMessage);
    expect(sent.join("")).toBe("The cold reaches her first. She runs.");
    expect(desk.form).toBe("tags");
    expect(channel.released).toBe(true);
  });

  test("a reply another way already holds is not shown, and the agent is told so once", () => {
    const desk = new ReplyDesk();
    desk.claim("narrator-live");
    const sent: string[] = [];
    const channel = new TagReply({ tags, sink: { content: (text) => sent.push(text) }, heldSentences: 0, tailSentences: 2, claim: () => desk.claim("tags"), second: "Fixture: the reply is not yours to give." });
    channel.begin();
    stream(channel, ["<reply>Mine, ", "all mine.</reply>"]);
    channel.end(anyMessage);
    expect(sent).toEqual([]);
    expect(channel.released).toBe(false);
    expect(channel.answers()).toEqual(["Fixture: the reply is not yours to give."]);
    expect(desk.form).toBe("narrator-live");
  });
});
