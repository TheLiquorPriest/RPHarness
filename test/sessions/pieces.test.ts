// The summary call always fits (§11): what a compaction summarizes is sent in pieces when it is more
// than the model's window less the room for the answer, oldest first, each piece's summary handed to
// the next. So a session that grew under a larger window still compacts on a smaller one.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { JsonObject } from "../../src/contract";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import { promptTokens, tokensOf } from "../../src/model/tokens";
import { nextPiece } from "../../src/sessions/carry";
import { type RecordedRequest, type Stage, stage } from "../harness/support";
import { carried, inOrder, material, play, said } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** About 9,000 tokens by the model layer's estimate. */
const BULK = "The tide tables, line by line. ".repeat(930);
const TOO_LONG = { pieces: [], end: { error: "prompt is too long: the request is past this model's window" } };

/** What a request weighs, by the model layer's estimate: its messages and the tools it declares. */
function weight(req: RecordedRequest): number {
  const ratio = DEFAULT_SETTINGS.tokens.charsPerToken;
  return promptTokens(req.messages, ratio) + tokensOf(JSON.stringify(req.tools), ratio);
}

test("a session that grew under a larger window compacts on a smaller one: each summary call is sent what fits, the older turns first, and the next is handed the summary before it", async () => {
  // The provider takes what fits its window: everything at first, then no more than the smaller window less the reserve.
  let limit = Number.POSITIVE_INFINITY;
  let leads = 0;
  let summaries = 0;
  let refused = 0;
  const respond = (req: RecordedRequest) => {
    if (weight(req) > limit) {
      refused += 1;
      return TOO_LONG;
    }
    if (req.tools.length === 0) return said(`Fixture summary ${(summaries += 1)}.`);
    leads += 1;
    return said(`<intent>Intent ${leads}. ${BULK}</intent><reply>Reply ${leads}.</reply>`);
  };
  const s = (open = await stage({ answers: Array.from({ length: 12 }, () => respond) }));
  await play(s, ["t1", "t2", "t3", "t4"]);
  expect(s.trace.of("compacted")).toEqual([]);

  // The window it is played on now leaves 24,000 tokens for a call.
  await Bun.write(join(s.dir, "files", "config.yml"), "compaction:\n  reserveTokens: 40000\n  keepTurns: 1\n");
  limit = 64_000 - 40_000 + 16;
  await play(s, ["t5"], "t4");

  expect(refused).toBe(0);
  const calls = s.model.requests.filter((req) => req.tools.length === 0);
  expect(calls).toHaveLength(2);
  const [first, second] = calls.map((req) => material(req));
  expect(inOrder(first!, ["Intent 1.", "Intent 2."])).toBe(true);
  expect(first).not.toContain("Intent 3.");
  expect(inOrder(second!, ["Fixture summary 1.", "Intent 3."])).toBe(true);
  expect(second).not.toContain("Intent 2.");
  const five = carried(s.model.requests.at(-1)!);
  expect(inOrder(five, ["Fixture summary 2.", "Intent 4."])).toBe(true);
  for (const gone of ["Fixture summary 1.", "Intent 3."]) expect(five).not.toContain(gone);
});

/** Turns of the continuing mode, each item weighing what its text's length says. */
const t = (n: number, ...sizes: number[]): JsonObject => ({ n, items: sizes.map((size) => ({ intent: "x".repeat(size) })) });
/** A piece weighs 10 for its frame, and each turn 1 for its head and each item its length. */
function weigh(turns: readonly JsonObject[]): number {
  let total = 10;
  for (const turn of turns) total += 1 + (turn["items"] as { intent: string }[]).reduce((sum, item) => sum + item.intent.length, 0);
  return total;
}
const sizes = (turns: readonly JsonObject[]) => turns.map((turn) => [turn["n"], (turn["items"] as { intent: string }[]).map((item) => item.intent.length)]);

test("a piece takes the oldest turns that fit; a turn too big for a piece alone is cut between its items; an item too big alone goes alone", () => {
  // All fit.
  expect(sizes(nextPiece([t(1, 20), t(2, 20)], 100, weigh).piece)).toEqual([[1, [20]], [2, [20]]]);
  // Cut between turns.
  const between = nextPiece([t(1, 40), t(2, 40), t(3, 40)], 100, weigh);
  expect([sizes(between.piece), sizes(between.rest)]).toEqual([[[1, [40]], [2, [40]]], [[3, [40]]]]);
  // The first turn fits in no piece whole: cut between its items, the rest of it left first.
  const within = nextPiece([t(1, 50, 50, 50), t(2, 10)], 100, weigh);
  expect([sizes(within.piece), sizes(within.rest)]).toEqual([[[1, [50]]], [[1, [50, 50]], [2, [10]]]]);
  // One item past the room goes alone.
  const alone = nextPiece([t(1, 500, 20), t(2, 10)], 100, weigh);
  expect([sizes(alone.piece), sizes(alone.rest)]).toEqual([[[1, [500]]], [[1, [20]], [2, [10]]]]);
});
