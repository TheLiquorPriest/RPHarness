// A session file whose last line was cut off part-way (a write that stopped, a process that ended
// mid-line), read by a harness started again: the cut line is passed over, and what is written
// after it stays whole, so every later restart finds the session's history as it stood.
import { afterEach, expect, test } from "bun:test";
import type { Scope, TurnRequest } from "../../src/contract";
import { createHarness } from "../../src/index";
import { scriptedModel } from "../../src/testing/rig";
import { CHAT, PROMPT, type RecordedRequest, request, type Stage, stage, textOf, USER, WatchedSink } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const S1: Scope = { user: USER, chat: CHAT, session: "s1" };
const LAST_PROMPT = String(PROMPT.at(-1)!.content);

/** What a request carried from the session: the message between the assembled prompt and the briefing, or undefined when there is none. */
function carried(req: RecordedRequest): string | undefined {
  const texts = req.messages.map((message) => textOf(message));
  const between = texts.slice(texts.lastIndexOf(LAST_PROMPT) + 1, -1);
  expect(between.length).toBeLessThanOrEqual(1);
  return between[0];
}

/** Whether every part is in the text, in the order given. */
function inOrder(text: string | undefined, parts: readonly string[]): boolean {
  if (text === undefined) return false;
  const at = parts.map((part) => text.indexOf(part));
  return at.every((place) => place >= 0) && at.every((place, i) => i === 0 || place > at[i - 1]!);
}

function turn(id: string, parent?: string): TurnRequest {
  return request(id, { lead: "lead", carry: "continuing", ...(parent !== undefined ? { parent } : {}) });
}

/** A harness started again over the same host, with ids of its own: it plays one turn, and is closed once its lines are written. */
async function restarted(s: Stage, name: string, text: string, req: TurnRequest): Promise<RecordedRequest> {
  const model = scriptedModel([{ pieces: [{ text }] }], { clock: s.clock });
  let next = 0;
  const again = createHarness(s.env, { models: { agentModel: async () => model.agentModel() }, ids: () => `${name}-${(next += 1)}` });
  try {
    await s.host.givePrompt(req.scope, { messages: req.prompt });
    expect((await again.answer(req, new WatchedSink(s.clock), new AbortController().signal)).status).toBe("released");
  } finally {
    await again.close();
  }
  return model.requests[0]!;
}

test("after a line cut off part-way, the first turn played after a restart stays whole, and a second restart still carries every turn before it", async () => {
  const s = (open = await stage({ answers: [{ pieces: [{ text: "<intent>Intent one.</intent><reply>Reply one.</reply>" }] }, { pieces: [{ text: "<intent>Intent two.</intent><reply>Reply two.</reply>" }] }] }));
  await s.harness.sessions!.open(S1, { summary: "Fixture summary: the lamp room is cold." });
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  expect((await s.turn(turn("t2", "t1"))).outcome.status).toBe("released");
  // The process ended part-way through writing a line.
  expect((await s.env.files.write(S1, "sessions/s1/s1.jsonl", { op: "append", text: '{"type":"result","id":"cut-off","par' }, "harness")).status).toBe("written");

  const third = await restarted(s, "second", "<intent>Intent three.</intent><reply>Reply three.</reply>", turn("t3", "t2"));
  expect(inOrder(carried(third), ["Fixture summary: the lamp room is cold.", "Intent one.", "Intent two."])).toBe(true);

  const fourth = await restarted(s, "third", "<intent>Intent four.</intent><reply>Reply four.</reply>", turn("t4", "t3"));
  expect(inOrder(carried(fourth), ["Fixture summary: the lamp room is cold.", "Intent one.", "Intent two.", "Intent three."])).toBe(true);

  const again = createHarness(s.env, { models: { agentModel: async () => scriptedModel([]).agentModel() }, ids: () => "unused" });
  try {
    expect(await again.sessions!.get(S1)).toMatchObject({ state: "open", turns: 4 });
  } finally {
    await again.close();
  }
});
