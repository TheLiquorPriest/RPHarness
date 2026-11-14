// `chat_read` and `chat_search` over the folder host's seeded chat: whole messages by position or
// id, hidden and summarized ones marked, an id the chat does not have said rather than thrown, a
// long answer clipped as every result is, and a search that never reaches a hidden message.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KIT_SEED } from "../../../src/testing/kit";
import { type Bench, bench, LEAD, textOf, turnGate } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(() => b.close());

const MESSAGES = KIT_SEED.messages;
const HIDDEN = MESSAGES.find((m) => m.hidden === true)!;
const SHOWN = MESSAGES.filter((m) => m.hidden !== true);

describe("chat_read", () => {
  test("with nothing named, every message of the chat comes whole, in order, with its position and id", async () => {
    const result = await b.call("chat_read", {});
    const answer = textOf(result);

    expect(result.error).toBeUndefined();
    const at = SHOWN.map((m) => answer.indexOf(m.text));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((x, y) => x - y));
    for (const m of MESSAGES) expect(answer).toContain(`#${MESSAGES.indexOf(m)} (${m.id}) ${m.name}`);
  });

  test("a hidden message is listed and marked, and its text is kept back while the chat's setting says so; a summarized one is marked", async () => {
    const answer = textOf(await b.call("chat_read", {}));

    expect(answer).not.toContain(HIDDEN.text);
    expect(answer).toContain(`(${HIDDEN.id}) ${HIDDEN.name} (hidden)`);
    expect(answer).toContain(`(kit-m3) Wren (summarized): ${MESSAGES[3]!.text}`);
  });

  test("a stretch by ids gives those messages and no others", async () => {
    const answer = textOf(await b.call("chat_read", { from_id: "kit-m1", to_id: "kit-m3" }));

    expect(answer).toContain(MESSAGES[1]!.text);
    expect(answer).toContain(MESSAGES[3]!.text);
    expect(answer).not.toContain(MESSAGES[0]!.text);
    expect(answer).not.toContain(MESSAGES[4]!.text);
  });

  test("by position, a stretch from a message to the end, and the last few", async () => {
    const from = textOf(await b.call("chat_read", { from: 4 }));
    const last = textOf(await b.call("chat_read", { last: 2 }));

    for (const answer of [from, last]) {
      expect(answer).toContain(MESSAGES[4]!.text);
      expect(answer).toContain(MESSAGES[5]!.text);
      expect(answer).not.toContain(MESSAGES[1]!.text);
    }
  });

  test("an id the chat does not have is said, not thrown", async () => {
    const result = await b.call("chat_read", { from_id: "kit-m1", to_id: "kit-m99" });

    expect(result.error).toBe(true);
    expect(textOf(result)).toContain("kit-m99");
  });

  test("a stretch past the end says how long the chat is", async () => {
    const result = await b.call("chat_read", { from: 40, to: 45 });

    expect(result.error).toBe(true);
    expect(textOf(result)).toContain(`${MESSAGES.length} messages`);
  });

  test("an answer longer than the clip setting is clipped with the note every result gets, and the whole is kept in the turn's folder", async () => {
    const whole = textOf(await b.call("chat_read", {}));
    const clip = 120;
    expect(whole.length).toBeGreaterThan(clip);

    const gate = await turnGate(b, { clipChars: clip });
    const read = textOf((await gate.after({ agent: LEAD, callId: "call-clip", tool: "chat_read", args: {} }, await b.call("chat_read", {}))).result);

    expect(read.startsWith(whole.slice(0, clip))).toBe(true);
    expect(read).not.toContain(MESSAGES[5]!.text);
    const note = read.slice(clip);
    expect(note).toContain(`${clip} of ${whole.length} characters`);
    const kept = /in (\S+\.md)\./.exec(note)?.[1];
    expect(kept).toBeDefined();
    const file = await b.host.files.read(KIT_SEED.scope, kept!);
    expect(file.status === "read" ? file.text : "").toBe(whole);
  });
});

describe("chat_search", () => {
  test("finds a message by its words, with its position, id and the words around the match", async () => {
    const answer = textOf(await b.call("chat_search", { query: "lantern" }));

    expect(answer).toContain("#1 (kit-m1) Wren");
    expect(answer).toContain("lantern");
    expect(answer).not.toContain("kit-m0");
  });

  test("a hidden message is never found while the chat keeps its text from agents", async () => {
    const result = await b.call("chat_search", { query: "quillfeather" });

    expect(result.error).toBeUndefined();
    expect(textOf(result)).not.toContain(HIDDEN.id);
    expect(textOf(result)).toBe("Nothing found.");
  });
});
