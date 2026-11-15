// Claim i (§18.1 row 0.2, §10.7): when nothing has been shown for a set interval, a progress line
// is emitted, so a long silent turn stays alive. The interval is a setting.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import { KeepAlive, TagReply } from "../../src/reply";
import { FakeClock, rigAgent, said, SinkRecorder, tool, user } from "./support";

const MINUTE = 60_000;
const author = { id: "author", definition: "author" };
const tags = { reply: "reply", intent: "intent" };

/** A turn whose lead waits twelve minutes on a tool, then writes the reply, under a progress setting of `silenceMs`. */
async function silentTurn(silenceMs: number): Promise<{ sink: SinkRecorder; startedAt: number }> {
  const clock = new FakeClock();
  const sink = new SinkRecorder(clock);
  const alive = new KeepAlive({ sink, clock, silenceMs, still: ({ elapsed }) => `Fixture: still working (${elapsed}).` });
  const reply = new TagReply({ tags, sink: alive.sink, heldSentences: 0, tailSentences: DEFAULT_SETTINGS.tailSentences, onReleased: () => alive.sink.finish({ calls: 2, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }) });
  const consult = tool("consult", async (_args, ctx) => (await clock.sleep(12 * MINUTE, ctx.signal), said("consulted")));
  const { runner } = rigAgent(author, [{ pieces: [{ text: "<intent>Consult first.</intent>" }, { call: "consult" }] }, { pieces: [{ text: "<reply>At last, the answer.</reply>" }] }], { clock, tools: [consult], channel: reply });
  const startedAt = clock.now();
  alive.start();
  const outcome = await clock.settle(runner.start({ messages: [user("Take your time.")] }).done);
  expect(outcome.status).toBe("done");
  return { sink, startedAt };
}

/** The longest stretch with nothing shown, from the turn's start to its reply. */
function longestSilence(sink: SinkRecorder, startedAt: number): number {
  const shown = [startedAt, ...sink.lines.map((line) => line.at), ...sink.pieces.map((piece) => piece.at)].sort((a, b) => a - b);
  return Math.max(...shown.slice(1).map((at, n) => at - shown[n]!));
}

describe("a long silent turn", () => {
  test("gets a progress line each time nothing has been shown for the set interval", async () => {
    const { sink, startedAt } = await silentTurn(5 * MINUTE);
    expect(sink.lines.map((line) => [line.line, line.at - startedAt])).toEqual([
      ["Fixture: still working (5:00).", 5 * MINUTE],
      ["Fixture: still working (10:00).", 10 * MINUTE],
    ]);
    expect(sink.text).toBe("At last, the answer.");
    expect(sink.pieces[0]!.at - startedAt).toBe(12 * MINUTE);
    expect(longestSilence(sink, startedAt)).toBe(5 * MINUTE);
    expect(sink.finished).toHaveLength(1);
  });

  test("a twelve-minute silence under a nine-minute setting gets one line, and no silence reaches ten minutes", async () => {
    const { sink, startedAt } = await silentTurn(9 * MINUTE);
    expect(sink.lines.map((line) => line.at - startedAt)).toEqual([9 * MINUTE]);
    expect(longestSilence(sink, startedAt)).toBeLessThan(10 * MINUTE);
  });

  test("the interval is the setting: three minutes gives a line every three minutes until the reply comes", async () => {
    const { sink, startedAt } = await silentTurn(3 * MINUTE);
    // At 12:00 the tool's wait and the next line fall due together; the tool's came first, and the reply it led to started the silence over.
    expect(sink.lines.map((line) => line.at - startedAt)).toEqual([3, 6, 9].map((m) => m * MINUTE));
    expect(sink.pieces[0]!.at - startedAt).toBe(12 * MINUTE);
    expect(longestSilence(sink, startedAt)).toBe(3 * MINUTE);
  });
});
