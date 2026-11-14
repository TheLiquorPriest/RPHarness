// The records mode's fold (§11, the records row): once the records a turn would carry pass the set
// size, they are folded into the scene's summary by the same compaction call, all but the newest
// kept; the turns after carry the summary and the records from there.
import { afterEach, expect, test } from "bun:test";
import type { TurnRequest } from "../../src/contract";
import { CHAT, PROMPT, type RecordedRequest, request, type Stage, stage, textOf, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LAST_PROMPT = String(PROMPT.at(-1)!.content);
const COMPACTION_WORDS = "Write what the lead must still have after the detail is gone";
/** About 40 tokens of records past the first: the second record takes the carried records past the set size. */
const FOLD = "compaction:\n  records: 50\n  keepTurns: 1\n";
const RECORD = (n: string) => `Record ${n}: ${"the lamp was trimmed and the log was kept. ".repeat(3)}\n`;

const said = (text: string) => ({ pieces: [{ text }] });

function carried(req: RecordedRequest): string {
  const texts = req.messages.map((message) => textOf(message));
  const between = texts.slice(texts.lastIndexOf(LAST_PROMPT) + 1, -1);
  expect(between.length).toBe(1);
  return between[0]!;
}

test("records past the set size are folded into the summary by one compaction call; the newest record is kept as it was", async () => {
  const s = (open = await stage({ config: FOLD, answers: [said("<reply>Reply one.</reply>"), said("<reply>Reply two.</reply>"), said("Fixture fold: record one in short."), said("<reply>Reply three.</reply>")] }));
  const turn = (id: string, parent?: string): TurnRequest => request(id, { lead: "lead", carry: "records", ...(parent !== undefined ? { parent } : {}) });
  const record = async (id: string, n: string): Promise<void> => {
    const scope = { user: USER, chat: CHAT, session: "s1", turn: id };
    const places = await s.env.files.places(scope);
    expect((await s.env.files.write(scope, `${places.turn}output/record.md`, { op: "write", text: RECORD(n) }, "harness")).status).toBe("written");
  };
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  await record("t1", "one");
  expect((await s.turn(turn("t2", "t1"))).outcome.status).toBe("released");
  await record("t2", "two");
  expect((await s.turn(turn("t3", "t2"))).outcome.status).toBe("released");

  const [, second, fold, third] = s.model.requests;
  expect(s.model.requests).toHaveLength(4);
  // One record carried is under the size: nothing was folded before the third turn.
  expect(carried(second!)).toContain("Record one:");
  // The fold: the compaction part, and the older record; the newest is kept.
  expect(textOf(fold!.messages[0]!)).toContain(COMPACTION_WORDS);
  const material = fold!.messages.slice(1).map((message) => textOf(message)).join("\n");
  expect(material).toContain("Record one:");
  expect(material).not.toContain("Record two:");
  const three = carried(third!);
  expect(three.indexOf("Fixture fold: record one in short.")).toBeGreaterThanOrEqual(0);
  expect(three.indexOf("Record two:")).toBeGreaterThan(three.indexOf("Fixture fold: record one in short."));
  expect(three).not.toContain("Record one:");
});
