// Opening and closing a session (§11), through the harness: only when the host says so, the
// summary it opened with carried in every mode, closing as the work of the turn that did it (that
// turn off the path, the session is open again), the fact `session.turns` a rule can test, and a
// branch that starts as its source stood at a turn.
import { afterEach, expect, test } from "bun:test";
import type { Carry, Scope, TurnRequest } from "../../src/contract";
import { CHAT, PROMPT, type RecordedRequest, request, type Stage, stage, textOf, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const S1: Scope = { user: USER, chat: CHAT, session: "s1" };
const SUMMARY = "Fixture summary: the storm broke last night, and the supply boat is late.";
const LAST_PROMPT = String(PROMPT.at(-1)!.content);

function carried(req: RecordedRequest): string | undefined {
  const texts = req.messages.map((message) => textOf(message));
  const between = texts.slice(texts.lastIndexOf(LAST_PROMPT) + 1, -1);
  expect(between.length).toBeLessThanOrEqual(1);
  return between[0];
}

function turn(id: string, carry: Carry, extra: Partial<TurnRequest> = {}): TurnRequest {
  return request(id, { lead: "lead", carry, ...extra });
}

const said = (text: string) => ({ pieces: [{ text }] });

test("a session opens and closes only on the host's word; closing belongs to the turn that did it, and that turn off the path leaves the session open", async () => {
  const s = (open = await stage({ answers: Array.from({ length: 4 }, (_, i) => said(`<intent>Intent ${i + 1}.</intent><reply>Reply ${i + 1}.</reply>`)) }));
  const sessions = s.harness.sessions!;
  expect(await sessions.get(S1)).toBeUndefined();
  expect(await sessions.open(S1, { summary: SUMMARY })).toMatchObject({ id: "s1", user: USER, chat: CHAT, state: "open", turns: 0 });

  for (const req of [turn("t1", "nothing"), turn("t2", "nothing", { parent: "t1" }), turn("t3", "nothing", { parent: "t2" })]) expect((await s.turn(req)).outcome.status).toBe("released");
  // Turns played do not close it.
  expect(await sessions.get(S1)).toMatchObject({ state: "open", turns: 3 });
  expect(await sessions.close({ ...S1, turn: "t3" })).toMatchObject({ state: "closed", closedBy: "t3", turns: 3 });
  expect(await sessions.get(S1)).toMatchObject({ state: "closed", closedBy: "t3", closedHow: "turn", closedAt: s.clock.now() });

  // The host takes the turn that closed it off the path: open again, as it stood before that turn.
  await s.harness.turnLeft({ ...S1, turn: "t3" });
  const reopened = await sessions.get(S1);
  expect(reopened).toMatchObject({ state: "open", turns: 2 });
  expect(reopened?.closedBy).toBeUndefined();
  expect(reopened?.closedAt).toBeUndefined();

  // Its swipe plays on in the open session, and carries only the summary it opened with in the mode "nothing".
  expect((await s.turn(turn("t3b", "nothing", { kind: "swipe", parent: "t2" }))).outcome.status).toBe("released");
  expect(await sessions.get(S1)).toMatchObject({ state: "open", turns: 3 });
  const nothing = carried(s.model.requests[3]!)!;
  expect(nothing).toContain(SUMMARY);
  expect(nothing).not.toContain("Intent");
});

test("the summary the session opened with comes before the turns it carries; `session.turns` counts the turns on the path, this one with them", async () => {
  const rule = "---\ndescription: Fixture - a long scene.\nagents: [lead]\nfact: session.turns >= 3\nat: turn-start\n---\nFixture rule: this scene has run for {{session.turns}} turns.\n";
  const s = (open = await stage({ files: { ".rules/fixture-long-scene.md": rule }, answers: Array.from({ length: 4 }, (_, i) => said(`<intent>Intent ${i + 1}.</intent><reply>Reply ${i + 1}.</reply>`)) }));
  await s.harness.sessions!.open(S1, { summary: SUMMARY });
  for (const req of [turn("t1", "continuing"), turn("t2", "continuing", { parent: "t1" }), turn("t3", "continuing", { parent: "t2" }), turn("t3b", "continuing", { kind: "swipe", parent: "t2" })]) {
    expect((await s.turn(req)).outcome.status).toBe("released");
  }
  const briefings = s.model.requests.map((req) => textOf(req.messages.at(-1)!));
  expect(briefings.map((text) => text.includes("Fixture rule: this scene has run for 3 turns."))).toEqual([false, false, true, true]);

  const third = carried(s.model.requests[2]!)!;
  const at = [SUMMARY, "Intent 1.", "Intent 2."].map((part) => third.indexOf(part));
  expect(at.every((place) => place >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
});

test("a branch starts as its source stood at a turn: its next turn carries what led there, and the source is listed beside it", async () => {
  const s = (open = await stage({ answers: Array.from({ length: 4 }, (_, i) => said(`<intent>Intent ${i + 1}.</intent><reply>Reply ${i + 1}.</reply>`)) }));
  const sessions = s.harness.sessions!;
  await sessions.open(S1, { summary: SUMMARY });
  for (const req of [turn("t1", "continuing"), turn("t2", "continuing", { parent: "t1" }), turn("t3", "continuing", { parent: "t2" })]) expect((await s.turn(req)).outcome.status).toBe("released");

  const S2: Scope = { ...S1, session: "s2" };
  expect(await sessions.fork({ ...S1, turn: "t2" }, S2)).toMatchObject({ id: "s2", state: "open", turns: 2, from: { chat: CHAT, session: "s1", turn: "t2" } });
  const branched = { ...turn("u3", "continuing", { parent: "t2" }), scope: { ...S2, turn: "u3" } };
  expect((await s.turn(branched)).outcome.status).toBe("released");
  const text = carried(s.model.requests[3]!)!;
  for (const part of [SUMMARY, "Intent 1.", "Intent 2."]) expect(text).toContain(part);
  expect(text).not.toContain("Intent 3.");

  expect((await sessions.list(USER, CHAT)).sessions.map((view) => [view.id, view.turns])).toEqual([
    ["s1", 3],
    ["s2", 3],
  ]);
});
