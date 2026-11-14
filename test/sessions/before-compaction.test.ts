// The lead's call at the moment before compaction (§11: "the Author gets one call with the rule's
// text", so it can save what it wants kept, "before anything is summarized"). It comes only when a
// summary can follow. The turn's one reply goes out from the turn's own work (§10.7), never from that
// call: its reply tools are answered with a line of `tool-notices.md`, and what it writes is shown
// nowhere, in the tag form and the two-step form alike. It is one model call, as the user's setting
// says, so it cannot spend the turn.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { TurnOutcome } from "../../src/contract";
import { SHIPPED_GUIDANCE } from "../../src/index";
import type { Answer } from "../../src/testing/rig";
import { type RecordedRequest, type Stage, stage, textOf } from "../harness/support";
import { play, played, S1, SAVE, SAVE_RULE, SAVE_TEXT, said, TIDE, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEP_TWO = "compaction:\n  keepTurns: 2\n";
const READ_TIDE = { pieces: [{ call: "file_read", args: { path: "persistent-workspace/tide.md" } }] };

/** RPH's own tool notices with the line for a reply tool called before the turn's own work in fixture words. */
async function notices(): Promise<string> {
  const shipped = await Bun.file(join(SHIPPED_GUIDANCE, ".prompts", "tool-notices.md")).text();
  if (!/^not_now: /m.test(shipped)) throw new Error("RPH's own tool notices have no not_now line.");
  return shipped.replace(/^not_now: .*$/m, "not_now: Fixture: {{tool}} waits for the turn's own work.");
}

/** What the reply tools answered in a turn, in order: the tool, its text, whether it failed. */
function replyTools(s: Stage, turnId: string): [string, string, boolean][] {
  return s.trace
    .of("tool_ended")
    .filter((record) => record.run === turnId && (record.event.tool === "write_reply" || record.event.tool === "reply_release"))
    .map((record) => [record.event.tool, record.event.result.content.map((part) => (part.type === "text" ? part.text : "")).join(""), record.event.result.error === true]);
}

test("in the tag form, the call before compaction releases nothing: both reply tools are answered with the file's line, the reply it writes in tags is shown nowhere, and the turn's own work gives the reply", async () => {
  const s = (open = await stage({
    config: KEEP_TWO,
    files: { [SAVE_RULE]: SAVE, [TIDE]: "High water at nine.\n", ".prompts/tool-notices.md": await notices() },
    answers: [
      played(1),
      played(2),
      played(3),
      { pieces: [{ text: "<reply>Fixture: a reply written before compaction.</reply>" }, { call: "write_reply", args: { brief: "Fixture brief." } }, { call: "reply_release", args: { path: "persistent-workspace/tide.md" } }] },
      said("Fixture summary."),
      played(4),
    ],
  }));
  await play(s, ["t1", "t2", "t3"]);
  await s.harness.sessions!.compact(S1);
  const { outcome, sink } = await s.turn(turn("t4", { parent: "t3" }));

  expect(outcome).toMatchObject({ status: "released", reply: "Reply 4." });
  expect(sink.text).toBe("Reply 4.");
  expect(replyTools(s, "t4")).toEqual([
    ["write_reply", "Fixture: write_reply waits for the turn's own work.", true],
    ["reply_release", "Fixture: reply_release waits for the turn's own work.", true],
  ]);
  // One release in the turn, by its own work, after the compaction.
  const kinds = s.trace.records.filter((record) => record.run === "t4").map((record) => record.event.kind);
  expect(kinds.filter((kind) => kind === "released")).toHaveLength(1);
  expect(kinds.indexOf("compacted")).toBeLessThan(kinds.indexOf("released"));
});

test("in the two-step form, what the lead writes in the call before compaction is shown nowhere, and the turn's own work gives the reply", async () => {
  const s = (open = await stage({
    config: `reply:\n  form: two-step\n${KEEP_TWO}`,
    files: { [SAVE_RULE]: SAVE, [TIDE]: "High water at nine.\n" },
    answers: [READ_TIDE, said("Reply 1."), READ_TIDE, said("Reply 2."), READ_TIDE, said("Reply 3."), said("Fixture: the saving call's own words."), said("Fixture summary."), said("Reply 4.")],
  }));
  await play(s, ["t1", "t2", "t3"]);
  await s.harness.sessions!.compact(S1);
  const { outcome, sink } = await s.turn(turn("t4", { parent: "t3" }));

  expect(outcome).toMatchObject({ status: "released", reply: "Reply 4." });
  expect(sink.text).toBe("Reply 4.");
  expect(s.trace.of("compacted").map((record) => record.run)).toEqual(["t4"]);
});

/**
 * t1 to t3, then t4 after a compaction the host asked for, under `config` (which keeps two turns),
 * every request answered by what it is: the call before compaction calls a tool every time it is
 * asked; the summary call (the one with no tools) summarizes; the lead's own work plays its turn.
 */
async function saving(config: string): Promise<{ s: Stage; outcome: TurnOutcome; saves: number }> {
  let lead = 0;
  const saves = (req: RecordedRequest): boolean => req.messages.some((message) => textOf(message).includes(SAVE_TEXT));
  const respond = (req: RecordedRequest) => (saves(req) ? READ_TIDE : req.tools.length === 0 ? said("Fixture summary.") : played((lead += 1)));
  const s = (open = await stage({ config, files: { [SAVE_RULE]: SAVE, [TIDE]: "High water at nine.\n" }, answers: Array.from({ length: 16 }, () => respond) }));
  await play(s, ["t1", "t2", "t3"]);
  await s.harness.sessions!.compact(S1);
  const { outcome } = await s.turn(turn("t4", { parent: "t3" }));
  return { s, outcome, saves: s.model.requests.filter(saves).length };
}

test("the call before compaction is one model call, whose tools run: it cannot spend the turn's calls, and the turn still answers", async () => {
  const { s, outcome, saves } = await saving(`limits:\n  turn:\n    calls: 4\n${KEEP_TWO}`);
  expect(outcome).toMatchObject({ status: "released", reply: "Reply 4." });
  expect(saves).toBe(1);
  expect(s.trace.of("tool_ended").filter((record) => record.run === "t4" && record.event.tool === "file_read")).toHaveLength(1);
  expect(s.trace.of("compacted").map((record) => record.run)).toEqual(["t4"]);
});

test("the user's setting gives the call before compaction more model calls", async () => {
  const { outcome, saves } = await saving("compaction:\n  keepTurns: 2\n  saveCalls: 3\n");
  expect(outcome).toMatchObject({ status: "released", reply: "Reply 4." });
  expect(saves).toBe(3);
});

/** Every first call is past the reserve (the scripted model's window is 64,000 tokens). */
const TIGHT = "compaction:\n  reserve: 63999\n  keepTurns: 2\n";

/** Plays t1 to t5 under the save rule; each turn's whole work is one model call, none of them a call before compaction. */
async function noCallBeforeCompaction(files: Record<string, string>, answer: (n: number) => Answer): Promise<void> {
  const s = (open = await stage({ config: TIGHT, files: { [SAVE_RULE]: SAVE, ...files }, answers: [1, 2, 3, 4, 5].map(answer) }));
  await play(s, ["t1", "t2", "t3", "t4", "t5"]);
  expect(s.model.requests).toHaveLength(5);
  expect(s.model.requests.filter((req) => req.messages.some((message) => textOf(message).includes(SAVE_TEXT)))).toEqual([]);
  expect(s.trace.of("rule_fired").filter((record) => record.event.firing.action === "call")).toEqual([]);
  expect(s.trace.of("compacted")).toEqual([]);
}

test("with the compaction part emptied, no summary can follow, and the moment before compaction never comes", async () => {
  await noCallBeforeCompaction({ ".prompts/compaction.md": "---\ndescription: Fixture - emptied.\n---\n" }, played);
});

test("with nothing carried from the turns a compaction would summarize, the moment before compaction never comes", async () => {
  await noCallBeforeCompaction({}, (n) => said(`<reply>Reply ${n}.</reply>`));
});
