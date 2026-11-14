// Compaction (§11), through the harness on the scripted rig. When the lead's first call of a turn
// would not fit its model's window less the reserve, and only then, or when the host asked: the
// moment before compaction first, whose rule gives the lead a call with its text; then one call
// written from the compaction part summarizes the session's earlier turns but the newest it keeps.
// The summary is an entry of the session file and the turns it stands for stay there; what is
// carried is the newest summary on the path and the turns after it.
import { afterEach, expect, test } from "bun:test";
import { type Stage, stage, textOf } from "../harness/support";
import { carried, entries, inOrder, play, played, S1, SAVE, SAVE_RULE, SAVE_TEXT, said, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** A reserve as large as the scripted model's window (64,000 tokens) less one: every first call is past it. */
const TIGHT = "compaction:\n  reserve: 63999\n  keepTurns: 2\n";
const COMPACTION_WORDS = "Write what the lead must still have after the detail is gone";

test("a first call that would not fit: the lead's call under the rule first, then one summary call written from the compaction part; the summary takes the older turns' place, the newest stay as they were, and the file keeps them all", async () => {
  const s = (open = await stage({
    config: TIGHT,
    files: { [SAVE_RULE]: SAVE },
    answers: [played(1), played(2), played(3), said("Saved."), said("Fixture summary one: the tide was checked."), played(4), said("Saved again."), said("Fixture summary two: the keeper was told."), played(5)],
  }));
  await play(s, ["t1", "t2", "t3", "t4", "t5"]);
  const [, , , save, summary, fourth, , second, fifth] = s.model.requests;
  expect(s.model.requests).toHaveLength(9);

  // The lead's call under the rule: its context as it stood, every earlier turn in full, and the rule's text after the briefing.
  expect(textOf(save!.messages.at(-1)!)).toContain(SAVE_TEXT);
  expect(inOrder(carried(save!, 2), ["Intent 1.", "Intent 2.", "Intent 3."])).toBe(true);
  expect(save!.tools.length).toBeGreaterThan(0);

  // The summary call: the compaction part, then the oldest turn as it was carried; the two newest are not in it. No tools.
  expect(summary!.messages[0]!.role).toBe("system");
  expect(textOf(summary!.messages[0]!)).toContain(COMPACTION_WORDS);
  const material = summary!.messages.slice(1).map((message) => textOf(message)).join("\n");
  expect(material).toContain("Intent 1.");
  expect(material).not.toContain("Intent 2.");
  expect(summary!.tools).toEqual([]);

  // The turn goes on with the summary in the older turn's place, and the two newest as they were.
  const four = carried(fourth!);
  expect(inOrder(four, ["Fixture summary one: the tide was checked.", "Intent 2.", "Intent 3."])).toBe(true);
  expect(four).not.toContain("Intent 1.");

  // The next compaction starts from the newest summary.
  const again = second!.messages.slice(1).map((message) => textOf(message)).join("\n");
  expect(inOrder(again, ["Fixture summary one: the tide was checked.", "Intent 2."])).toBe(true);
  expect(again).not.toContain("Intent 3.");
  const five = carried(fifth!);
  expect(inOrder(five, ["Fixture summary two: the keeper was told.", "Intent 3.", "Intent 4."])).toBe(true);
  for (const gone of ["Fixture summary one", "Intent 2."]) expect(five).not.toContain(gone);

  // The file keeps every turn's work, and each summary as the work of the turn that wrote it.
  const lines = await entries(s);
  for (const n of [1, 2, 3, 4, 5]) expect(JSON.stringify(lines)).toContain(`Intent ${n}.`);
  expect(lines.filter((line) => line.type === "compacted").map((line) => [line.turn, line.summary])).toEqual([
    ["t4", "Fixture summary one: the tide was checked."],
    ["t5", "Fixture summary two: the keeper was told."],
  ]);
  // The host is told through the trace: the rule's call, and each compaction with how many turns it kept.
  expect(s.trace.of("rule_fired").filter((record) => record.event.firing.action === "call")).toHaveLength(2);
  expect(s.trace.of("compacted").map((record) => [record.event.session, record.event.keptTurns])).toEqual([
    ["s1", 2],
    ["s1", 2],
  ]);
});

test("with no rule at the moment before compaction, the summary call is the first call made", async () => {
  const s = (open = await stage({ config: TIGHT, answers: [played(1), played(2), played(3), said("Fixture summary one."), played(4)] }));
  await play(s, ["t1", "t2", "t3", "t4"]);
  expect(s.model.requests).toHaveLength(5);
  expect(textOf(s.model.requests[3]!.messages[0]!)).toContain(COMPACTION_WORDS);
  expect(carried(s.model.requests[4]!)).toContain("Fixture summary one.");
  expect(s.trace.of("rule_fired").filter((record) => record.event.firing.action === "call")).toEqual([]);
});

test("a session whose first calls fit is never compacted, however many turns it has", async () => {
  const s = (open = await stage({ files: { [SAVE_RULE]: SAVE }, answers: [1, 2, 3, 4, 5, 6].map(played) }));
  await play(s, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  expect(s.model.requests).toHaveLength(6);
  expect(inOrder(carried(s.model.requests[5]!), ["Intent 1.", "Intent 2.", "Intent 3.", "Intent 4.", "Intent 5."])).toBe(true);
  expect((await entries(s)).filter((line) => line.type === "compacted")).toEqual([]);
  expect(s.trace.of("compacted")).toEqual([]);
});

test("a compaction the host asks for is marked, and the next turn compacts at its start, the rule's call first; a swipe of that turn finds every turn the summary stood for", async () => {
  const s = (open = await stage({
    files: { [SAVE_RULE]: SAVE },
    answers: [played(1), played(2), played(3), played(4), said("Saved."), said("Fixture summary: asked for."), played(5), said("<intent>Intent 5, again.</intent><reply>Reply 5 again.</reply>")],
  }));
  const sessions = s.harness.sessions!;
  await play(s, ["t1", "t2", "t3", "t4"]);
  expect(await sessions.compact(S1)).toMatchObject({ state: "open", turns: 4, compactAsked: true });
  await play(s, ["t5"], "t4");
  expect((await sessions.get(S1))?.compactAsked).toBeUndefined();

  const [, , , , save, summary, fifth] = s.model.requests;
  expect(textOf(save!.messages.at(-1)!)).toContain(SAVE_TEXT);
  expect(textOf(summary!.messages[0]!)).toContain(COMPACTION_WORDS);
  // The default keeps the newest three turns: the summary stands for the first.
  const five = carried(fifth!);
  expect(inOrder(five, ["Fixture summary: asked for.", "Intent 2.", "Intent 3.", "Intent 4."])).toBe(true);
  expect(five).not.toContain("Intent 1.");

  // The swipe hangs where the turn it replaces began, before the summary: every earlier turn is carried as it was, and nothing is compacted again.
  expect((await s.turn(turn("t5b", { kind: "swipe", parent: "t4" }))).outcome.status).toBe("released");
  expect(s.model.requests).toHaveLength(8);
  const back = carried(s.model.requests[7]!);
  expect(inOrder(back, ["Intent 1.", "Intent 2.", "Intent 3.", "Intent 4."])).toBe(true);
  expect(back).not.toContain("Fixture summary");
});
