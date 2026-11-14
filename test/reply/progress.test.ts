import { describe, expect, test } from "bun:test";
import { KeepAlive } from "../../src/reply";
import { FakeClock, SinkRecorder } from "../loop/support";

const MINUTE = 60_000;

function keepAlive(silenceMs: number): { alive: KeepAlive; sink: SinkRecorder; clock: FakeClock } {
  const clock = new FakeClock();
  const sink = new SinkRecorder(clock);
  const alive = new KeepAlive({ sink, clock, silenceMs, still: ({ elapsed }) => `still (${elapsed})` });
  return { alive, sink, clock };
}

describe("keeping a long turn alive", () => {
  test("a line goes out each time nothing has been shown for the set interval", () => {
    const { alive, sink, clock } = keepAlive(4 * MINUTE);
    const start = clock.now();
    alive.start();
    clock.advance(12 * MINUTE + 1);
    expect(sink.lines.map((line) => [line.line, line.at - start])).toEqual([
      ["still (4:00)", 4 * MINUTE],
      ["still (8:00)", 8 * MINUTE],
      ["still (12:00)", 12 * MINUTE],
    ]);
  });

  test("reply text starts the silence over; an empty piece does not", () => {
    const { alive, sink, clock } = keepAlive(5 * MINUTE);
    alive.start();
    clock.advance(4 * MINUTE);
    alive.sink.content("A word.");
    clock.advance(4 * MINUTE);
    alive.sink.content("");
    clock.advance(MINUTE);
    expect(sink.lines.map((line) => line.line)).toEqual(["still (9:00)"]);
  });

  test("no line after the reply's stream is over", () => {
    const { alive, sink, clock } = keepAlive(MINUTE);
    alive.start();
    alive.sink.finish({ calls: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    clock.advance(10 * MINUTE);
    expect(sink.lines).toEqual([]);
    expect(sink.finished).toHaveLength(1);
  });

  test("the interval must be more than nothing", () => {
    expect(() => keepAlive(0)).toThrow();
  });
});
