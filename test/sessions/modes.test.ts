// The other two modes of what a session carries (§11), through the harness on the scripted rig.
// Records: the lead's own record of each earlier turn on the path, read from the file the carried
// part names in that turn's folder, and nothing else of what it did; a turn with no record carries
// nothing. Nothing: none of the earlier turns at all.
import { afterEach, expect, test } from "bun:test";
import type { Carry, TurnRequest } from "../../src/contract";
import { CHAT, PROMPT, type RecordedRequest, request, type Stage, stage, textOf, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const TIDE = "chats/wren-hale/lighthouse/persistent-workspace/tide.md";
const LAST_PROMPT = String(PROMPT.at(-1)!.content);

/** What a request carried from the session: the message between the assembled prompt and the briefing, or undefined when there is none. */
function carried(req: RecordedRequest): string | undefined {
  const texts = req.messages.map((message) => textOf(message));
  const between = texts.slice(texts.lastIndexOf(LAST_PROMPT) + 1, -1);
  expect(between.length).toBeLessThanOrEqual(1);
  return between[0];
}

/** Three turns in one mode, each with an intent record and the first with a call; a fourth after them. The host keeps a record of the first and the third. */
async function fourthTurn(carry: Carry): Promise<RecordedRequest> {
  const s = (open = await stage({
    files: { [TIDE]: "High water at nine.\n" },
    answers: [
      { pieces: [{ text: "<intent>Intent one.</intent>" }, { call: "file_read", args: { path: "persistent-workspace/tide.md" } }] },
      { pieces: [{ text: "<reply>Reply one.</reply>" }] },
      { pieces: [{ text: "<intent>Intent two.</intent><reply>Reply two.</reply>" }] },
      { pieces: [{ text: "<intent>Intent three.</intent><reply>Reply three.</reply>" }] },
      { pieces: [{ text: "<reply>Reply four.</reply>" }] },
    ],
  }));
  const turn = (id: string, parent?: string): TurnRequest => request(id, { lead: "lead", carry, ...(parent !== undefined ? { parent } : {}) });
  const record = async (id: string, text: string): Promise<void> => {
    const scope = { user: USER, chat: CHAT, session: "s1", turn: id };
    const places = await s.env.files.places(scope);
    expect((await s.env.files.write(scope, `${places.turn}output/record.md`, { op: "write", text }, "harness")).status).toBe("written");
  };
  for (const [id, parent] of [["t1"], ["t2", "t1"], ["t3", "t2"]] as const) expect((await s.turn(turn(id, parent))).outcome.status).toBe("released");
  await record("t1", "Record one: the tide was checked; high water at nine.\n");
  await record("t3", "Record three: the keeper was told.\n");
  expect((await s.turn(turn("t4", "t3"))).outcome.status).toBe("released");
  return s.model.requests[4]!;
}

test("records: the fourth turn carries the lead's records of the earlier turns that have one, oldest first, and nothing else they did", async () => {
  const text = carried(await fourthTurn("records"))!;
  const one = text.indexOf("Record one: the tide was checked; high water at nine.");
  const three = text.indexOf("Record three: the keeper was told.");
  expect(one).toBeGreaterThanOrEqual(0);
  expect(three).toBeGreaterThan(one);
  for (const absent of ["Intent one.", "Intent two.", "Intent three.", "file_read", "High water at nine.", "Reply one."]) expect(text).not.toContain(absent);
});

test("nothing: the fourth turn carries none of the earlier turns", async () => {
  expect(carried(await fourthTurn("nothing"))).toBeUndefined();
});
