// A harness started again (every update restarts RPE) finds the session as it stood: a session file
// whose last line was cut off part-way (a write that stopped, a process that ended mid-line) has the
// cut line passed over, and what is written after it stays whole, so every later restart finds the
// session's history as it stood; the lead's opening block is the one the session file keeps, so the
// cached front holds; and what the session file and the store keep is plain JSON, carried whole.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { JsonObject, Scope, TurnRequest } from "../../src/contract";
import type { RuleMemory } from "../../src/files/api";
import { keepMemory, keptOpening, memoryAt, type Opening, Sessions } from "../../src/harness/sessions";
import { createHarness } from "../../src/index";
import { lineOf, parseSession, SessionLog } from "../../src/sessions/file";
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

const lead = (words: string, tools: string) => `---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [${tools}]\ngiven:\n  - prompt:*\n  - session:carry\n  - briefing\n---\nFixture lead: ${words}\n`;

test("a harness started again mid-scene sends the lead the same opening block and the same tool list, byte for byte; a file edited in between reaches the briefing as changed, not the block", async () => {
  const s = (open = await stage({ files: { ".agents/lead.md": lead("first words.", "todo") }, answers: [{ pieces: [{ text: "<intent>Intent one.</intent><reply>Reply one.</reply>" }] }] }));
  await s.harness.sessions!.open(S1);
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");

  await Bun.write(join(s.dir, "files", ".agents", "lead.md"), lead("second words.", "todo, file_read"));
  const second = await restarted(s, "second", "<intent>Intent two.</intent><reply>Reply two.</reply>", turn("t2", "t1"));
  const first = s.model.requests[0]!;
  expect(textOf(first.messages[0]!)).toContain("Fixture lead: first words.");
  expect(textOf(second.messages[0]!)).toBe(textOf(first.messages[0]!));
  expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
  expect(second.tools.map((tool) => tool.name)).not.toContain("file_read");
  expect(textOf(second.messages.at(-1)!)).toContain("Fixture lead: second words.");
});

test("an Opening and a RuleMemory survive a round trip through JSON unchanged", async () => {
  const s = (open = await stage({ answers: [] }));
  // Each with a field no code here knows, as a later package may add one.
  const opening = {
    text: "Fixture opening block.",
    snapshot: { agent: "lead", parts: [{ part: "definition", path: ".agents/lead.md", level: "global", hash: "0f1e", layered: true }] },
    skills: "Fixture skills.",
    tools: ["todo"],
    given: ["prompt:*", "briefing"],
    outOfReach: ["web"],
    declared: { todo: { description: "Fixture todo.", parameters: { type: "object", properties: { items: { type: "array" } }, required: ["items"] } } },
    closing: "Fixture closing.",
    form: "tags",
    stream: true,
    tags: { reply: "reply", intent: "intent" },
    intentFile: "intent.md",
    contract: "Fixture contract.",
    later: { added: ["by a later package"] },
  } as unknown as Opening;
  const parsed = parseSession(lineOf({ type: "opening", id: "o1", parent: null, at: 0, lead: "lead", opening: opening as unknown as JsonObject }));
  expect(keptOpening(new SessionLog(parsed.entries), "lead")).toStrictEqual(opening);

  const memory = {
    turns: 4,
    fired: { "fixture-every lead": 3 },
    held: [{ agent: "lead", firing: { rule: "fixture-lantern", path: ".rules/fixture-lantern.md", level: "global", moment: "after-message", watched: "reply", matched: "yes" }, text: "Fixture held text." }],
    session: { id: "s1", fired: ["fixture-once lead"] },
    later: { added: 1 },
  } as unknown as RuleMemory;
  // Kept, and let go of in memory at once: what is read back is the store's.
  await keepMemory(new Sessions().of(S1), s.env, { ...S1, turn: "t4" }, memory, new Set());
  expect(await memoryAt(new Sessions().of(S1), s.env, S1, new SessionLog(), null, "t4")).toStrictEqual(memory);
});
