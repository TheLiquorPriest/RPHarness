import { describe, expect, test } from "bun:test";
import { type ReplyTags, type TagPart, TagParser } from "../../src/reply";

const tags: ReplyTags = { reply: "reply", intent: "intent" };

/** The text of each part of a whole message, after reading it in the given pieces. */
function read(parser: TagParser, pieces: string[]): { reply: string; intent: string; outside: string; marks: string[] } {
  const out = { reply: "", intent: "", outside: "", marks: [] as string[] };
  const take = (part: TagPart): void => {
    if (part.kind === "text") out[part.role ?? "outside"] += part.text;
    else out.marks.push(`${part.kind}:${part.role}`);
  };
  for (const piece of pieces) parser.push(piece).forEach(take);
  parser.end().forEach(take);
  return out;
}

const message = "<intent>Weigh the door first.</intent>Checking the map.<reply>The door holds, barely.</reply>Done.";
const whole = { reply: "The door holds, barely.", intent: "Weigh the door first.", outside: "Checking the map.Done.", marks: ["open:intent", "close:intent", "open:reply", "close:reply"] };

describe("the tag parser", () => {
  test("tells the reply, the intent record and working text apart", () => {
    expect(read(new TagParser(tags), [message])).toEqual(whole);
  });

  test("finds every tag wherever the stream splits it, into two or three pieces", () => {
    for (let i = 1; i < message.length; i += 1) {
      expect(read(new TagParser(tags), [message.slice(0, i), message.slice(i)])).toEqual(whole);
      for (let j = i + 1; j < message.length; j += 1) {
        expect(read(new TagParser(tags), [message.slice(0, i), message.slice(i, j), message.slice(j)])).toEqual(whole);
      }
    }
  });

  test("holds back nothing but a possible tag: read one character at a time, the reply so far is out at once", () => {
    const parser = new TagParser(tags);
    let reply = "";
    const start = message.indexOf("<reply>") + "<reply>".length;
    const end = message.indexOf("</reply>");
    for (let at = 0; at < message.length; at += 1) {
      for (const part of parser.push(message[at] ?? "")) if (part.kind === "text" && part.role === "reply") reply += part.text;
      if (at >= start && at < end) expect(reply).toBe(message.slice(start, at + 1));
    }
  });

  test("takes its names from configuration: other names make other tags", () => {
    const parser = new TagParser({ reply: "scene", intent: "aim" });
    const out = read(parser, ["<aim>Keep it short.</aim><reply>not this</reply><sce", "ne>The bell rings.</scene>"]);
    expect(out.reply).toBe("The bell rings.");
    expect(out.intent).toBe("Keep it short.");
    expect(out.outside).toBe("<reply>not this</reply>");
  });

  test("inside the reply only its own closing tag counts, and a lone '<' is not held", () => {
    const parser = new TagParser(tags);
    const parts = parser.push("<reply>She wrote <intent> on the wall; 2 < 3");
    const reply = parts.flatMap((part) => (part.kind === "text" && part.role === "reply" ? [part.text] : [])).join("");
    expect(reply).toBe("She wrote <intent> on the wall; 2 < 3");
    expect(parser.inside).toBe("reply");
  });

  test("a '<' still held when the message ends is text after all", () => {
    expect(read(new TagParser(tags), ["<reply>Wait", " </rep"]).reply).toBe("Wait </rep");
  });

  test("refuses names a tag cannot have, and one name for both parts", () => {
    expect(() => new TagParser({ reply: "re ply", intent: "intent" })).toThrow();
    expect(() => new TagParser({ reply: "", intent: "intent" })).toThrow();
    expect(() => new TagParser({ reply: "same", intent: "same" })).toThrow();
  });
});
