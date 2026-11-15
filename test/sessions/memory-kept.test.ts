// What the rules remembered at a turn's end is kept through the host's store by user, chat and turn
// (§5.4): a turn's rules go on from the memory of the turn it follows, in its session or the scene
// before's, after a restart as before it. `every:` counts the chat's turns, `repeat: once per session`
// fires again in each new session, and a question rule's text held for the next briefing survives a
// restart. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { Scope, TurnRequest } from "../../src/contract";
import { createHarness } from "../../src/index";
import { type Answer, type RecordedRequest, type Reply, scriptedModel } from "../../src/testing/rig";
import { request, type Stage, stage, textOf, WatchedSink } from "../harness/support";
import { S1 } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const S2: Scope = { ...S1, session: "s2" };
const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [todo]\ngiven:\n  - prompt:*\n  - briefing\n---\nFixture lead: you run the turn.\n";
const EVERY = "Fixture rule: the third bell rings.";
const ONCE = "Fixture rule: the scene's weather is fog.";
const HELD = "Fixture rule: last turn's reply promised a lantern; keep to it.";
const QUESTION = "Does the reply promise a lantern?";
const RULES = {
  ".rules/fixture-every.md": `---\ndescription: Fixture - every third turn.\nagents: [lead]\nevery: 3\n---\n${EVERY}\n`,
  ".rules/fixture-once.md": `---\ndescription: Fixture - once a session, at a turn's start.\nagents: [lead]\nat: turn-start\nrepeat: once per session\n---\n${ONCE}\n`,
  ".rules/fixture-lantern.md": `---\ndescription: Fixture - a lantern promised in the reply.\nagents: [lead]\nscope: [reply]\nquestion: ${QUESTION}\n---\n${HELD}\n`,
};

/** Whether a request is the judging model's: it puts the question. */
const asks = (req: RecordedRequest): boolean => req.messages.some((message) => textOf(message).includes(QUESTION));

/** Every call's answer, by whose call it is: the judging model's or the lead's, each from its own list in order. */
function routed(lead: Reply[], judge: Reply[]): Answer[] {
  const route: Answer = (req) => {
    const next = (asks(req) ? judge : lead).shift();
    if (next === undefined) throw new Error("The fixture has no answer left for this call.");
    return next;
  };
  return Array.from({ length: lead.length + judge.length }, () => route);
}

const reply = (n: number): Reply => ({ pieces: [{ text: `<reply>Reply ${n}.</reply>` }] });
const no: Reply = { pieces: [{ text: "No." }] };

function turn(session: Scope, id: string, parent?: string): TurnRequest {
  return request(id, { scope: { ...session, turn: id }, lead: "lead", ...(parent !== undefined ? { parent } : {}) });
}

/** Which of the rules' texts a lead's request carried in its briefing, the last of its messages. */
function due(req: RecordedRequest): string[] {
  const briefing = textOf(req.messages.at(-1)!);
  return [EVERY, ONCE, HELD].filter((text) => briefing.includes(text));
}

test("an every-3 rule fires at the chat's third turn though a new scene began at the second; a once-per-session rule fires once in each scene; after a restart a question rule's held text reaches the next briefing", async () => {
  const s = (open = await stage({ files: { ".agents/lead.md": LEAD, ...RULES }, answers: routed([reply(1), reply(2), reply(3)], [no, no, { pieces: [{ text: "Yes." }] }]) }));
  await s.harness.sessions!.open(S1);
  expect((await s.turn(turn(S1, "t1"))).outcome.status).toBe("released");
  // The scene ends with its first turn; the next scene opens.
  expect(await s.harness.sessions!.close({ ...S1, turn: "t1" })).toMatchObject({ state: "closed" });
  await s.harness.sessions!.open(S2);
  expect((await s.turn(turn(S2, "t2", "t1"))).outcome.status).toBe("released");
  expect((await s.turn(turn(S2, "t3", "t2"))).outcome.status).toBe("released");
  expect(s.model.requests.filter((req) => !asks(req)).map(due)).toEqual([[ONCE], [ONCE], [EVERY]]);

  // A harness started again over the same host plays the scene's next turn.
  const model = scriptedModel(routed([reply(4)], [no]), { clock: s.clock });
  let next = 0;
  const again = createHarness(s.env, { models: { agentModel: async () => model.agentModel() }, ids: () => `again-${(next += 1)}` });
  try {
    const req = turn(S2, "t4", "t3");
    await s.host.givePrompt(req.scope, { messages: req.prompt });
    expect((await again.answer(req, new WatchedSink(s.clock), new AbortController().signal)).status).toBe("released");
  } finally {
    await again.close();
  }
  expect(model.requests.filter((req) => !asks(req)).map(due)).toEqual([[HELD]]);
});
