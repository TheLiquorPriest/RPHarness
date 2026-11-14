import { describe, expect, test } from "bun:test";
import { lastSentences, Release, sentenceEnds } from "../../src/reply";

function release(held: number): { release: Release; sent: string[] } {
  const sent: string[] = [];
  return { release: new Release((text) => sent.push(text), held), sent };
}

describe("holding a reply back by sentences", () => {
  test("with nothing held back, every piece goes out as it comes", () => {
    const { release: r, sent } = release(0);
    r.hold("The rain");
    r.flush();
    r.hold(" stops");
    r.flush();
    expect(sent).toEqual(["The rain", " stops"]);
    expect(r.held).toBe("");
  });

  test("held back by one sentence, only the sentence in progress waits", () => {
    const { release: r, sent } = release(1);
    r.hold("The rain stops. A door opens. Some");
    r.flush();
    expect(sent.join("")).toBe("The rain stops. A door opens. ");
    expect(r.held).toBe("Some");
    r.hold("one steps in.");
    r.flush();
    // "in." has nothing after it yet: it may still go on, so it is not an end.
    expect(r.held).toBe("Someone steps in.");
    r.hold(" ");
    r.flush();
    expect(r.held).toBe("");
  });

  test("held back by two, the last whole sentence waits as well", () => {
    const { release: r, sent } = release(2);
    r.hold("One. Two. Thr");
    r.flush();
    expect(sent.join("")).toBe("One. ");
    expect(r.held).toBe("Two. Thr");
  });

  test("a dropped sentence is never sent; flushing all sends the rest", () => {
    const { release: r, sent } = release(1);
    r.hold("Kept. Dropped half");
    r.flush();
    expect(r.drop()).toBe("Dropped half");
    r.hold("New end.");
    r.flush(true);
    expect(sent.join("")).toBe("Kept. New end.");
    expect(r.shown).toBe("Kept. New end.");
  });

  test("sentence ends take closing quotes and line breaks, and full-width stops", () => {
    const text = `"Stop!" she said. Then\nquiet。次`;
    expect(sentenceEnds(text).map((end) => text.slice(0, end))).toEqual([`"Stop!" `, `"Stop!" she said. `, `"Stop!" she said. Then\n`, `"Stop!" she said. Then\nquiet。`]);
  });

  test("the last sentences of what was shown", () => {
    expect(lastSentences("A one. B two. C three. ", 2)).toBe("B two. C three. ");
    expect(lastSentences("A one. B two. ", 5)).toBe("A one. B two. ");
    expect(lastSentences("A one. ", 0)).toBe("");
  });

  test("refuses a holdback that is not a whole number of sentences", () => {
    expect(() => new Release(() => {}, -1)).toThrow();
    expect(() => new Release(() => {}, 0.5)).toThrow();
  });
});
