// The agents' thinking in the chat's thinking block (§10.7, `progress.thinking`): a stretch at a time, in order with the progress
// lines, never one stretch inside another's, none after the reply has begun to go out; thinking shown is no silence. Everything here
// is invented.
import { describe, expect, onTestFinished, test } from "bun:test";
import type { AgentRef, ThinkingPiece } from "../../src/contract";
import { KeepAlive, ThinkingFeed, type ThinkingShown } from "../../src/reply";
import { request, stage, WatchedSink } from "../harness/support";
import { FakeClock, SinkRecorder } from "../loop/support";

const LEAD: AgentRef = { id: "lead-1", definition: "lead" };
const GM: AgentRef = { id: "gm-2", definition: "gm" };
const WREN: AgentRef = { id: "character-3", definition: "character", plays: "char-wren" };

function feed(shown: ThinkingShown, open: () => boolean = () => true): { thinking: ThinkingFeed; given: [string, string, boolean][] } {
  const given: [string, string, boolean][] = [];
  const thinking = new ThinkingFeed({ sink: { thinking: (piece) => given.push([piece.agent.definition, piece.text, piece.first]) }, shown, lead: LEAD.id, open });
  return { thinking, given };
}

describe("the thinking a turn's agents give the chat", () => {
  test("one stretch at a time: a call that thinks while another's is shown is held, given whole when that one ends, and goes on as it is written", () => {
    const { thinking, given } = feed("all");
    thinking.piece(LEAD, 1, "The lamp first.");
    thinking.piece(GM, 1, "A roll for the stair.");
    thinking.piece(LEAD, 1, " Then the stair.");
    thinking.piece(WREN, 1, "Wren is cold.");
    thinking.ended(LEAD, 1);
    thinking.piece(GM, 1, " It holds.");
    thinking.ended(WREN, 1);
    thinking.ended(GM, 1);
    expect(given).toEqual([
      ["lead", "The lamp first.", true],
      ["lead", " Then the stair.", false],
      ["gm", "A roll for the stair.", true],
      ["gm", " It holds.", false],
      ["character", "Wren is cold.", true],
    ]);
  });

  test("calls held that ended are given whole in the order they began; a progress line between two pieces heads the next one again; a call made again begins its own stretch", () => {
    const { thinking, given } = feed("all");
    thinking.piece(LEAD, 1, "One.");
    thinking.piece(WREN, 1, "Wren waits.");
    thinking.piece(GM, 1, "The GM rules.");
    thinking.ended(GM, 1);
    thinking.agentEnded(WREN);
    thinking.lined();
    thinking.piece(LEAD, 1, "Two.");
    thinking.ended(LEAD, 1);
    thinking.piece(LEAD, 1, "Again.");
    expect(given).toEqual([
      ["lead", "One.", true],
      ["lead", "Two.", true],
      ["character", "Wren waits.", true],
      ["gm", "The GM rules.", true],
      ["lead", "Again.", true],
    ]);
  });

  test("the lead's alone where the setting says so, none with the progress lines alone, and nothing once the chat no longer takes it", () => {
    const lead = feed("lead");
    lead.thinking.piece(GM, 1, "The GM rules.");
    lead.thinking.piece(LEAD, 1, "The lead thinks.");
    expect(lead.given).toEqual([["lead", "The lead thinks.", true]]);
    const lines = feed("lines");
    lines.thinking.piece(LEAD, 1, "The lead thinks.");
    expect(lines.given).toEqual([]);
    let open = true;
    const closing = feed("all", () => open);
    closing.thinking.piece(LEAD, 1, "Before.");
    closing.thinking.piece(GM, 1, "Held.");
    open = false;
    closing.thinking.piece(LEAD, 1, "After.");
    closing.thinking.ended(LEAD, 1);
    expect(closing.given).toEqual([["lead", "Before.", true]]);
  });
});

/** A sink that takes thinking, recording everything it is given in order. */
class ThinkingSink extends WatchedSink {
  readonly shown: string[] = [];
  readonly thoughts: ThinkingPiece[] = [];

  thinking(piece: ThinkingPiece): void {
    this.thoughts.push(piece);
    this.shown.push(`${piece.first ? "heads " : ""}${piece.agent.definition}: ${piece.text}`);
  }

  override progress(line: string): void {
    this.shown.push(`line: ${line}`);
    super.progress(line);
  }

  override content(delta: string): void {
    this.shown.push(`reply: ${delta}`);
    super.content(delta);
  }
}

describe("thinking and the silence", () => {
  test("thinking shown starts the silence over, and every progress line, the silence's own among them, is told", () => {
    const clock = new FakeClock();
    const sink = new ThinkingSink(clock);
    let lined = 0;
    const alive = new KeepAlive({ sink, clock, silenceMs: 60_000, still: ({ elapsed }) => `still (${elapsed})`, lined: () => lined++ });
    alive.start();
    clock.advance(50_000);
    alive.sink.thinking?.({ agent: LEAD, text: "Thinking.", first: true });
    clock.advance(50_000);
    expect(sink.lines).toEqual([]);
    clock.advance(10_000);
    expect(sink.lines.map((l) => l.line)).toEqual(["still (1:50)"]);
    alive.sink.progress("A tool.");
    expect(lined).toBe(2);
    // A sink that shows no thinking is given none, and its silence is not started over by any.
    expect(new KeepAlive({ sink: new SinkRecorder(clock), clock, silenceMs: 60_000, still: () => "still" }).sink.thinking).toBeUndefined();
  });

  test("a turn's thinking reaches a sink that takes it as the model writes it, after the turn's first line and before its reply; with the progress lines alone, none does", async () => {
    const answers = () => [{ pieces: [{ thinking: "The lamp first." }, { thinking: " Then the stair." }, { text: "<reply>The lamp holds.</reply>" }] }];
    const s = await stage({ answers: answers() });
    onTestFinished(() => s.close());
    const sink = new ThinkingSink(s.clock);
    const { outcome } = await s.turn(request("t1", { lead: "lead" }), sink);
    expect(outcome.status).toBe("released");
    expect(sink.shown.filter((line) => !line.startsWith("line:")).slice(0, 2)).toEqual(["heads lead: The lamp first.", "lead:  Then the stair."]);
    expect(sink.shown.findIndex((line) => line.startsWith("line:"))).toBeLessThan(sink.shown.findIndex((line) => line.startsWith("heads")));
    expect(sink.shown.findIndex((line) => line.startsWith("reply:"))).toBeGreaterThan(sink.shown.findIndex((line) => line === "lead:  Then the stair."));

    const quiet = await stage({ config: "progress:\n  thinking: lines\n", answers: answers() });
    onTestFinished(() => quiet.close());
    const none = new ThinkingSink(quiet.clock);
    expect((await quiet.turn(request("t1", { lead: "lead" }), none)).outcome.status).toBe("released");
    expect(none.thoughts).toEqual([]);
  });
});
