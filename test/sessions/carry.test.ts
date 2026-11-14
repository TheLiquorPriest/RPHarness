// What a session carries into the lead's context (§11, §10.2 block 3), through the harness on the
// scripted rig: in the continuing mode, what the lead did in the session's earlier turns on the
// path (its intent records, its calls and what came back), oldest first, as one text after the
// assembled prompt and before the briefing. A swipe carries the turns before the one it replaces
// and never the abandoned attempt; a turn the host took off the path is not carried; no earlier
// turn's thinking ever reaches a request.
import { afterEach, expect, test } from "bun:test";
import type { TurnRequest } from "../../src/contract";
import { CHAT, PROMPT, type RecordedRequest, request, type Stage, stage, textOf, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const TIDE = "chats/wren-hale/lighthouse/persistent-workspace/tide.md";
const LAST_PROMPT = String(PROMPT.at(-1)!.content);

function turn(id: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return request(id, { lead: "lead", carry: "continuing", ...extra });
}

/** What a request carried from the session: the message between the assembled prompt and the briefing, or undefined when there is none. */
function carried(req: RecordedRequest): string | undefined {
  const texts = req.messages.map((message) => textOf(message));
  const prompt = texts.lastIndexOf(LAST_PROMPT);
  const between = texts.slice(prompt + 1, -1);
  expect(between.length).toBeLessThanOrEqual(1);
  return between[0];
}

/** Where each text is in a carried block, in the order given; -1 where it is not. */
function places(text: string, parts: readonly string[]): number[] {
  return parts.map((part) => text.indexOf(part));
}

test("continuing: the fourth turn carries the first three in order; a swipe of the third carries the first two and never the abandoned try; a turn taken off the path is not carried; no thinking is ever sent back", async () => {
  const s = (open = await stage({
    files: { [TIDE]: "High water at nine.\n" },
    answers: [
      { pieces: [{ thinking: "FIXTURE-THINKING-ONE" }, { text: "<intent>Intent one: the tide.</intent>" }, { call: "file_read", args: { path: "persistent-workspace/tide.md" } }] },
      { pieces: [{ text: "<reply>Reply one.</reply>" }] },
      { pieces: [{ thinking: "FIXTURE-THINKING-TWO" }, { text: "<intent>Intent two.</intent><reply>Reply two.</reply>" }] },
      { pieces: [{ text: "<intent>Intent three, first try.</intent><reply>Reply three.</reply>" }] },
      { pieces: [{ text: "<reply>Reply four.</reply>" }] },
      { pieces: [{ text: "<intent>Intent three, second try.</intent><reply>Reply three again.</reply>" }] },
      { pieces: [{ text: "<intent>Intent four, after the swipe.</intent><reply>Reply four again.</reply>" }] },
      { pieces: [{ text: "<reply>Reply five.</reply>" }] },
    ],
  }));
  const played = [turn("t1"), turn("t2", { parent: "t1" }), turn("t3", { parent: "t2" }), turn("t4", { parent: "t3" }), turn("t3b", { kind: "swipe", parent: "t2" }), turn("t4b", { parent: "t3b" })];
  for (const req of played) expect((await s.turn(req)).outcome.status).toBe("released");
  // The host deletes the second turn's reply: the turns after it stay on the path.
  await s.harness.turnLeft({ user: USER, chat: CHAT, session: "s1", turn: "t2" });
  expect((await s.turn(turn("t5", { parent: "t4b" }))).outcome.status).toBe("released");

  const [first, , second, third, fourth, swipe, afterSwipe, fifth] = s.model.requests;
  // Nothing before the first turn, and nothing to carry from a turn the lead did nothing in but reply.
  expect(carried(first!)).toBeUndefined();
  expect(carried(second!)).toContain("Intent one: the tide.");

  // The fourth turn: the three before it, oldest first, each with its intent record; the first with its call and what came back.
  const three = carried(fourth!)!;
  const order = places(three, ["Intent one: the tide.", "file_read", '{"path":"persistent-workspace/tide.md"}', "High water at nine.", "Intent two.", "Intent three, first try."]);
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // What the chat already shows is not carried again: the replies stay where they are, in the prompt.
  expect(three).not.toContain("Reply one.");
  expect(carried(third!)).not.toContain("Intent three");

  // The swipe of the third carries the first two and never the attempt it replaces; the turn after it carries the new attempt.
  const beforeSwipe = carried(swipe!)!;
  expect(places(beforeSwipe, ["Intent one: the tide.", "Intent two."]).every((at) => at >= 0)).toBe(true);
  expect(beforeSwipe).not.toContain("first try");
  const branch = carried(afterSwipe!)!;
  expect(branch).toContain("Intent three, second try.");
  expect(branch).not.toContain("first try");

  // The second turn, taken off the path, is carried no more; the turns around it are.
  const last = carried(fifth!)!;
  expect(last).not.toContain("Intent two.");
  expect(places(last, ["Intent one: the tide.", "Intent three, second try.", "Intent four, after the swipe."]).every((at) => at >= 0)).toBe(true);

  // Thinking goes back only within its own turn (the first turn's second call): no later turn's request carries it.
  expect(JSON.stringify(s.model.requests[1]!.messages)).toContain("FIXTURE-THINKING-ONE");
  for (const req of s.model.requests.slice(2)) expect(JSON.stringify(req.messages)).not.toContain("FIXTURE-THINKING-ONE");
  for (const req of s.model.requests.slice(3)) expect(JSON.stringify(req.messages)).not.toContain("FIXTURE-THINKING-TWO");
});
