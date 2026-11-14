// A closing is judged by its turn (§11 "Closing belongs to the turn that did it"; "You can close one
// too"), not by where it sits in the session's tree: the host's own closing, which names no turn,
// holds whatever is swiped after it, and a closing made as the work of a turn that later turns
// already follow holds while that turn is on the path.
import { afterEach, expect, test } from "bun:test";
import type { Scope, TurnRequest } from "../../src/contract";
import { CHAT, request, type Stage, stage, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const S1: Scope = { user: USER, chat: CHAT, session: "s1" };
const said = (text: string) => ({ pieces: [{ text }] });

function turn(id: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return request(id, { lead: "lead", ...extra });
}

test("the host's closing holds when the newest turn is swiped; a closing as the work of an earlier turn holds while that turn is on the path", async () => {
  const s = (open = await stage({ answers: Array.from({ length: 5 }, (_, i) => said(`<reply>Reply ${i + 1}.</reply>`)) }));
  const sessions = s.harness.sessions!;
  for (const req of [turn("t1"), turn("t2", { parent: "t1" })]) expect((await s.turn(req)).outcome.status).toBe("released");

  // The host closes it, naming no turn; then the newest turn is swiped.
  expect(await sessions.close(S1)).toMatchObject({ state: "closed" });
  expect((await s.turn(turn("t2b", { kind: "swipe", parent: "t1" }))).outcome.status).toBe("released");
  expect(await sessions.get(S1)).toMatchObject({ state: "closed" });

  // In another session: a closing as the work of the first turn, which the second already follows.
  const S2: Scope = { ...S1, session: "s2" };
  const at = (id: string, extra: Partial<TurnRequest> = {}): TurnRequest => ({ ...turn(id, extra), scope: { ...S2, turn: id } });
  for (const req of [at("u1"), at("u2", { parent: "u1" })]) expect((await s.turn(req)).outcome.status).toBe("released");
  expect(await sessions.close({ ...S2, turn: "u1" })).toMatchObject({ state: "closed", closedBy: "u1" });
  // That turn off the path: open again.
  await s.harness.turnLeft({ ...S2, turn: "u1" });
  expect(await sessions.get(S2)).toMatchObject({ state: "open" });
});
