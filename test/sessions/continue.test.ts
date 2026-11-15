// A continue (§10.10: the same turn, extended), as a host sends one: the continued turn's own id,
// the kind `continue`, and that turn's own parent. Its work goes on from where that turn stands in
// the session file, so what the turn already did stays carried, by the continue and by every turn
// after it, and a closing the turn made still holds.
import { afterEach, expect, test } from "bun:test";
import type { Scope, TurnRequest } from "../../src/contract";
import { CHAT, PROMPT, type RecordedRequest, request, type Stage, stage, textOf, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const S1: Scope = { user: USER, chat: CHAT, session: "s1" };
const LAST_PROMPT = String(PROMPT.at(-1)!.content);

/** What a request carried from the session: the message between the assembled prompt and the briefing. */
function carried(req: RecordedRequest): string {
  const texts = req.messages.map((message) => textOf(message));
  const between = texts.slice(texts.lastIndexOf(LAST_PROMPT) + 1, -1);
  expect(between.length).toBe(1);
  return between[0]!;
}

/** Whether every part is in the text, in the order given. */
function inOrder(text: string, parts: readonly string[]): boolean {
  const at = parts.map((part) => text.indexOf(part));
  return at.every((place) => place >= 0) && at.every((place, i) => i === 0 || place > at[i - 1]!);
}

const said = (text: string) => ({ pieces: [{ text }] });

function turn(id: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return request(id, { lead: "lead", carry: "continuing", ...extra });
}

test("a continue goes on from the turn it continues: that turn's work stays carried by the continue and by the turn after it, and the closing it made still holds", async () => {
  const s = (open = await stage({
    answers: [
      said("<intent>Intent one.</intent><reply>Reply one.</reply>"),
      said("<intent>Intent two.</intent><reply>Reply two.</reply>"),
      said("<intent>Intent three.</intent><reply>Reply three.</reply>"),
      said("<intent>Intent three, continued.</intent><reply>More of reply three.</reply>"),
      said("<intent>Intent four.</intent><reply>Reply four.</reply>"),
    ],
  }));
  const sessions = s.harness.sessions!;
  for (const req of [turn("t1"), turn("t2", { parent: "t1" }), turn("t3", { parent: "t2" })]) expect((await s.turn(req)).outcome.status).toBe("released");
  expect(await sessions.close({ ...S1, turn: "t3" })).toMatchObject({ state: "closed", closedBy: "t3" });

  // The continue, as a host sends it.
  expect((await s.turn(turn("t3", { kind: "continue", parent: "t2" }))).outcome.status).toBe("released");
  expect(await sessions.get(S1)).toMatchObject({ state: "closed", closedBy: "t3", turns: 3 });
  expect((await s.turn(turn("t4", { parent: "t3" }))).outcome.status).toBe("released");

  const [, , , continued, fourth] = s.model.requests;
  // The continue is given what its turn already did, after the turns before it.
  expect(inOrder(carried(continued!), ["Intent one.", "Intent two.", "Intent three."])).toBe(true);
  // The turn after it carries the continued turn whole: what it did first, then what the continue added.
  expect(inOrder(carried(fourth!), ["Intent one.", "Intent two.", "Intent three.", "Intent three, continued."])).toBe(true);

  // One turn entry for the continued turn: its work and the continue's hang in one line of entries.
  const read = await s.env.files.read(S1, "sessions/s1/s1.jsonl");
  if (read.status !== "read") throw new Error(`The session file is not there: ${read.status}`);
  const entries = read.text
    .split("\n")
    .filter((line) => line !== "")
    .slice(1)
    .map((line) => JSON.parse(line) as { type: string; id: string; parent: string | null; turn?: string });
  expect(entries.filter((entry) => entry.type === "turn" && entry.turn === "t3")).toHaveLength(1);
  const third = entries.filter((entry) => entry.turn === "t3" && entry.type !== "spent");
  for (const [i, entry] of third.entries()) if (i > 0) expect(entry.parent).toBe(third[i - 1]!.id);
});

test("a continue that compacts carries the summary, the turns kept, and what its turn did already; the turn after it carries the summary and the continued turn whole", async () => {
  const s = (open = await stage({
    config: "compaction:\n  keepTurns: 1\n",
    answers: [
      said("<intent>Intent one.</intent><reply>Reply one.</reply>"),
      said("<intent>Intent two.</intent><reply>Reply two.</reply>"),
      said("<intent>Intent three.</intent><reply>Reply three.</reply>"),
      said("Fixture summary: the bell was rung."),
      said("<intent>Intent three, continued.</intent><reply>More of reply three.</reply>"),
      said("<intent>Intent four.</intent><reply>Reply four.</reply>"),
    ],
  }));
  for (const req of [turn("t1"), turn("t2", { parent: "t1" }), turn("t3", { parent: "t2" })]) expect((await s.turn(req)).outcome.status).toBe("released");
  await s.harness.sessions!.compact(S1);
  expect((await s.turn(turn("t3", { kind: "continue", parent: "t2" }))).outcome.status).toBe("released");
  expect((await s.turn(turn("t4", { parent: "t3" }))).outcome.status).toBe("released");

  const [, , , summary, continued, fourth] = s.model.requests;
  const sent = summary!.messages.map((message) => textOf(message)).join("\n");
  expect(sent).toContain("Intent one.");
  expect(sent).not.toContain("Intent three.");
  expect(inOrder(carried(continued!), ["Fixture summary: the bell was rung.", "Intent two.", "Intent three."])).toBe(true);
  expect(inOrder(carried(fourth!), ["Fixture summary: the bell was rung.", "Intent two.", "Intent three.", "Intent three, continued."])).toBe(true);
  for (const req of [continued!, fourth!]) expect(carried(req)).not.toContain("Intent one.");
});
