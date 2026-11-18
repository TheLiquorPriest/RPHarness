// What a session keeps between its turns (§6.3, §10.10): what the user's rules remember, as each
// turn left it. A swipe starts from its parent's, not from the attempt it replaces, and the
// session goes on along the path the turns name. A request's `parent` means one thing to the
// session file and to the rules: left out, the session's latest turn; `null`, no turn.
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const RULE = "---\ndescription: Fixture - every other turn, once a session.\nagents: [lead]\nevery: 2\nrepeat: once per session\n---\nFixture rule: the tide turns.\n";

test("a swipe starts from what the rules remembered at its parent: a rule its discarded attempt used up fires again, and the turns after it go on from the swipe", async () => {
  const s = (open = await stage({ files: { ".rules/fixture-tide.md": RULE }, answers: Array.from({ length: 5 }, () => ({ pieces: [{ text: "<reply>The lamp turns.</reply>" }] })) }));
  const turns = [
    request("t1", { lead: "lead" }),
    request("t2", { lead: "lead", parent: "t1" }),
    request("t2b", { lead: "lead", kind: "swipe", parent: "t1" }),
    request("t3", { lead: "lead", parent: "t2b" }),
    request("t4", { lead: "lead", parent: "t3" }),
  ];

  for (const req of turns) expect((await s.turn(req)).outcome.status).toBe("released");

  // Each turn's briefing, last in its request: the rule is due on the second turn of a path, once a session.
  expect(s.model.requests.map((req) => textOf(req.messages.at(-1)!).includes("Fixture rule: the tide turns."))).toEqual([false, true, true, false, false]);
});

const ONCE = "---\ndescription: Fixture - once a session, at a turn's start.\nagents: [lead]\nat: turn-start\nrepeat: once per session\n---\nFixture rule: the storm is the scene's clock.\n";

test("a request with no parent follows the session's latest turn, and one whose parent is null follows no turn, in what the session carries and in what the rules remember", async () => {
  const s = (open = await stage({
    files: { ".rules/fixture-once.md": ONCE },
    answers: [
      { pieces: [{ text: "<intent>Intent one.</intent><reply>Reply one.</reply>" }] },
      { pieces: [{ text: "<intent>Intent two.</intent><reply>Reply two.</reply>" }] },
      { pieces: [{ text: "<intent>Intent two, again.</intent><reply>Reply two again.</reply>" }] },
      { pieces: [{ text: "<intent>Intent three.</intent><reply>Reply three.</reply>" }] },
    ],
  }));
  const turns = [
    request("t1", { lead: "lead", carry: "continuing" }),
    request("t2", { lead: "lead", carry: "continuing" }),
    // A host with a tree, asking for another attempt at the session's first turn.
    request("t2b", { lead: "lead", carry: "continuing", kind: "swipe", parent: null }),
    request("t3", { lead: "lead", carry: "continuing" }),
  ];
  for (const req of turns) expect((await s.turn(req)).outcome.status).toBe("released");

  const sent = s.model.requests.map((req) => JSON.stringify(req.messages));
  // The second turn carries the first; the attempt that follows no turn carries nothing; the turn after it carries that attempt alone.
  expect(sent.map((text) => ["Intent one.", "Intent two.", "Intent two, again."].filter((intent) => text.includes(intent)))).toEqual([[], ["Intent one."], [], ["Intent two, again."]]);
  // Once a session: used up by the first turn for the second; fresh for the attempt that follows no turn, and used up by it for the turn after.
  expect(s.model.requests.map((req) => textOf(req.messages.at(-1)!).includes("Fixture rule: the storm is the scene's clock."))).toEqual([true, false, true, false]);
});

test("what the harness keeps between turns is counted by name: the session's file held read with its characters, and nothing of a run once it has ended", async () => {
  const s = (open = await stage({ answers: [{ pieces: [{ text: "<reply>The lamp turns.</reply>" }] }] }));
  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  const kept = new Map(s.harness.kept().map((k) => [k.name, k]));
  const file = kept.get("Session files held in memory");
  expect(file?.count).toBe(1);
  expect(file?.chars ?? 0).toBeGreaterThan(0);
  expect(kept.get("Sessions' opening blocks held")?.count).toBe(1);
  for (const gone of ["Turns being answered", "Runs going on", "Jobs held in memory"]) expect(kept.get(gone)?.count).toBe(0);
});
