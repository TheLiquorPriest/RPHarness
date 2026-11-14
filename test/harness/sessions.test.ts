// What a session keeps between its turns (§6.3, §10.10): what the user's rules remember, as each
// turn left it. A swipe starts from its parent's, not from the attempt it replaces, and the
// session goes on along the path the turns name.
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
