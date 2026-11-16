// A session's file is held in memory only while something works on it (a turn, a call of the
// sessions API): once its lines are written and nothing holds it, the harness lets it go, and the
// file on disk is what the next turn finds. So a session the host prunes between turns is not kept
// alive from memory.
import { afterEach, expect, test } from "bun:test";
import type { Scope, TurnRequest } from "../../src/contract";
import { CHAT, PROMPT, request, type Stage, stage, textOf, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const S1: Scope = { user: USER, chat: CHAT, session: "s1" };
const FILE = "sessions/s1/s1.jsonl";
const said = (text: string) => ({ pieces: [{ text }] });

function turn(id: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return request(id, { lead: "lead", carry: "continuing", ...extra });
}

test("a session file the host deletes between turns is begun anew by the next turn, which carries nothing from it (with no session kept read between turns)", async () => {
  const s = (open = await stage({ config: "sessions:\n  held: 0\n", answers: [1, 2, 3].map((n) => said(`<intent>Intent ${n}.</intent><reply>Reply ${n}.</reply>`)) }));
  for (const req of [turn("t1"), turn("t2", { parent: "t1" })]) expect((await s.turn(req)).outcome.status).toBe("released");
  expect((await s.harness.sessions!.list(USER, CHAT)).sessions.map((view) => view.id)).toEqual(["s1"]);

  // The host prunes the session.
  expect((await s.env.files.write(S1, FILE, { op: "delete" }, "harness")).status).toBe("written");
  expect((await s.turn(turn("t3", { parent: "t2" }))).outcome.status).toBe("released");

  const texts = s.model.requests[2]!.messages.map((message) => textOf(message));
  expect(texts.slice(texts.lastIndexOf(String(PROMPT.at(-1)!.content)) + 1, -1)).toEqual([]);
  const read = await s.env.files.read(S1, FILE);
  if (read.status !== "read") throw new Error(`The session file is not there: ${read.status}`);
  const lines = read.text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { type: string; turn?: string });
  expect(lines[0]).toMatchObject({ type: "session", id: "s1" });
  expect(new Set(lines.slice(1).map((line) => line.turn))).toEqual(new Set(["t3"]));
});
