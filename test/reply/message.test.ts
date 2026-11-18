import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import { MessageReply, ReplyDesk } from "../../src/reply";

const anyMessage = { content: [] } as unknown as AssistantMessage;

describe("the reply as a message's text", () => {
  test("streamed, the reply is taken only as its first text goes out: one cut before anything of it showed leaves it free for another way", () => {
    const desk = new ReplyDesk();
    const sent: string[] = [];
    const begun: string[] = [];
    const channel = new MessageReply({ sink: { content: (text) => sent.push(text) }, stream: true, heldSentences: 1, tailSentences: 2, claim: () => desk.claim("narrator-live"), onBegin: () => begun.push(sent.join("")) });
    const write = (pieces: string[]): void => {
      for (const piece of pieces) {
        channel.write(piece);
        channel.release();
      }
    };
    channel.begin();
    write(["Something moves, and a shiv"]);
    channel.cut();
    expect(sent).toEqual([]);
    expect(desk.taken).toBe(false);
    expect(begun).toEqual([]);
    // Written again, it is this form's from its first sentence out, and begins as that sentence shows.
    channel.begin();
    write(["The cold reaches her first. ", "She runs."]);
    channel.end(anyMessage);
    expect(sent.join("")).toBe("The cold reaches her first. She runs.");
    expect(begun).toEqual([""]);
    expect(desk.form).toBe("narrator-live");
    expect(channel.released).toBe(true);
  });

  test("after release, a message of plain text with no calls is working text, as text after a reply's closing tag is: nothing reaches the sink, and nothing answers it", () => {
    const desk = new ReplyDesk();
    const sent: string[] = [];
    const released: string[] = [];
    const channel = new MessageReply({ sink: { content: (text) => sent.push(text) }, stream: false, heldSentences: 0, tailSentences: 2, claim: () => desk.claim("message"), onReleased: (text) => released.push(text) });
    const message = (text: string): void => {
      channel.begin();
      channel.write(text);
      channel.release();
      channel.end(anyMessage);
    };
    message("Wren shakes her head.");
    expect(sent).toEqual(["Wren shakes her head."]);
    expect(channel.answers()).toEqual([]);
    desk.out();
    for (const text of ["The tide turned; nothing else changed.", "A boat after all."]) {
      message(text);
      expect({ sent, released, answers: channel.answers() }).toEqual({ sent: ["Wren shakes her head."], released: ["Wren shakes her head."], answers: [] });
    }
  });
});
