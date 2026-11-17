import { describe, expect, onTestFinished, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPLY } from "../../src/harness/settings/reply";
import { KeepAlive } from "../../src/reply";
import { gate, request, stage, WatchedSink } from "../harness/support";
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

  test("no number 540 or 600 appears in src/reply: the bound is read from the settings list", async () => {
    const folder = join(import.meta.dir, "..", "..", "src", "reply");
    const found: string[] = [];
    for (const name of await readdir(folder)) {
      const text = await readFile(join(folder, name), "utf8");
      for (const match of text.matchAll(/\b(?:540|600)(?:_?000)?\b/g)) found.push(`${name}: ${match[0]}`);
    }
    expect(found).toEqual([]);
  });

  test("with the still row removed from the chat's progress.md, no line comes from the shipped file, the turn's time limit is held at 540 s, and the trace carries progress_missing with it", async () => {
    const held = gate();
    const s = await stage({
      files: { ".prompts/progress.md": "---\ndescription: Fixture progress lines, with no row that keeps a turn alive.\nformat: lines\n---\nstarted: Fixture: reading.\nwriting: Fixture: writing.\n" },
      answers: [{ pieces: [{ hold: held }, { text: "<reply>The lamp holds.</reply>" }] }],
    });
    onTestFinished(() => s.close());
    const sink = new WatchedSink(s.clock);
    const turn = s.turn(request("t1", { lead: "lead" }), sink);
    try {
      await s.trace.seen((record) => record.event.kind === "call_started");
      s.clock.advance(MINUTE);
      expect(s.trace.of("progress_missing").map((record) => record.event)).toEqual([{ kind: "progress_missing", time: REPLY.silence.advise.above * 1000 }]);
      // The turn's own time runs out at the held limit, before the ten minutes.
      s.clock.advance(8 * MINUTE);
      const { outcome } = await turn;
      expect(outcome).toMatchObject({ status: "limit", limit: { limit: "time", per: "turn", max: 540_000 } });
      expect(sink.lines.map((line) => line.line)).toEqual(["Fixture: reading."]);
      expect(s.trace.of("progress_missing")).toHaveLength(1);
    } finally {
      held.open();
      await turn;
    }
  });
});
