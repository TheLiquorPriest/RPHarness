// The session file (§11), as a host finds it in the session's folder after turns played through the
// harness: one line per entry, a tree by parent, the lead's intent records, messages, calls and
// results in the order they happened, a swipe as a branch from the entry before the turn, a turn
// that left the path marked and kept, and never a word of thinking. A harness started again finds
// the session in it as it stood.
import { afterEach, expect, test } from "bun:test";
import { createHarness } from "../../src/index";
import { scriptedModel } from "../../src/testing/rig";
import { CHAT, PROMPT, request, type Stage, stage, textOf, USER, WatchedSink } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const TIDE = "chats/wren-hale/lighthouse/persistent-workspace/tide.md";

type Line = Record<string, unknown> & { type: string; id: string; parent: string | null; turn?: string };

async function sessionLines(s: Stage): Promise<Line[]> {
  const read = await s.env.files.read({ user: USER, chat: CHAT, session: "s1" }, "sessions/s1/s1.jsonl");
  if (read.status !== "read") throw new Error(`The session file is not there: ${read.status}`);
  return read.text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Line);
}

test("each turn's entries hang from the one before; a swipe branches from the entry before the turn it replaces; a turn that left is marked and kept; no thinking is written", async () => {
  const s = (open = await stage({
    files: { [TIDE]: "High water at nine.\n" },
    answers: [
      { pieces: [{ thinking: "FIXTURE-THINKING-ONE" }, { text: "<intent>Check the tide.</intent>" }, { call: "file_read", args: { path: "persistent-workspace/tide.md" } }] },
      { pieces: [{ text: "<reply>The tide is high.</reply>" }] },
      { pieces: [{ thinking: "FIXTURE-THINKING-TWO" }, { text: "<intent>Answer the keeper.</intent><reply>The keeper nods.</reply>" }] },
      { pieces: [{ text: "<intent>A first try.</intent><reply>A gull cries.</reply>" }] },
      { pieces: [{ text: "<intent>A second try.</intent><reply>A bell rings.</reply>" }] },
    ],
  }));
  for (const req of [request("t1", { lead: "lead" }), request("t2", { lead: "lead", parent: "t1" }), request("t3", { lead: "lead", parent: "t2" }), request("t3b", { lead: "lead", kind: "swipe", parent: "t2" })]) {
    expect((await s.turn(req)).outcome.status).toBe("released");
  }

  const [header, ...entries] = await sessionLines(s);
  expect(header).toMatchObject({ type: "session", version: 1, id: "s1", user: USER, chat: CHAT });
  // A tree: every entry follows nothing or an entry written before it.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.parent !== null) expect(seen.has(entry.parent)).toBe(true);
    seen.add(entry.id);
  }
  // The first turn, in the order it happened, each entry following the one before; what its run spent is a mark hung from its turn entry.
  const first = entries.filter((entry) => entry.turn === "t1" && entry.type !== "spent");
  expect(first.map((entry) => entry.type)).toEqual(["turn", "intent", "message", "call", "result", "message"]);
  for (const [i, entry] of first.entries()) if (i > 0) expect(entry.parent).toBe(first[i - 1]!.id);
  expect(first[1]).toMatchObject({ text: "Check the tide." });
  expect(first[3]).toMatchObject({ tool: "file_read", args: { path: "persistent-workspace/tide.md" } });
  expect(first[4]).toMatchObject({ tool: "file_read", callId: first[3]!["callId"] });
  expect(String(first[4]!["text"])).toContain("High water at nine.");
  expect(String(first[5]!["text"])).toContain("The tide is high.");

  // The second turn follows the first one's last entry; both tries at the third hang from the second's last.
  const turnEntry = (turn: string) => entries.find((entry) => entry.type === "turn" && entry.turn === turn)!;
  const last = (turn: string) => entries.filter((entry) => entry.turn === turn && entry.type !== "spent").at(-1)!;
  expect(entries.find((entry) => entry.type === "spent" && entry.turn === "t1")).toMatchObject({ parent: turnEntry("t1").id });
  expect(turnEntry("t1").parent).toBeNull();
  expect(turnEntry("t2").parent).toBe(last("t1").id);
  expect(turnEntry("t3").parent).toBe(last("t2").id);
  expect(turnEntry("t3b")).toMatchObject({ parent: last("t2").id, kind: "swipe", follows: "t2" });
  expect(entries.filter((entry) => entry.turn === "t3" && entry.type !== "spent").map((entry) => entry.type)).toEqual(["turn", "intent", "message"]);

  const text = JSON.stringify(entries);
  expect(text).not.toContain("FIXTURE-THINKING");

  // The host takes the swipe off the path: one line more, marking it; nothing before it changed.
  await s.harness.turnLeft({ user: USER, chat: CHAT, session: "s1", turn: "t3b" });
  const [, ...after] = await sessionLines(s);
  expect(after.slice(0, entries.length)).toEqual(entries);
  expect(after.slice(entries.length)).toEqual([expect.objectContaining({ type: "left", turn: "t3b", parent: last("t3b").id })]);
});

test("a harness started again reads the session file, and its next turn carries what the earlier harness's turns did", async () => {
  const s = (open = await stage({ answers: [{ pieces: [{ text: "<intent>Intent one.</intent><reply>Reply one.</reply>" }] }, { pieces: [{ text: "<intent>Intent two.</intent><reply>Reply two.</reply>" }] }] }));
  expect((await s.turn(request("t1", { lead: "lead", carry: "continuing" }))).outcome.status).toBe("released");
  expect((await s.turn(request("t2", { lead: "lead", carry: "continuing", parent: "t1" }))).outcome.status).toBe("released");

  const model = scriptedModel([{ pieces: [{ text: "<reply>Reply three.</reply>" }] }], { clock: s.clock });
  let next = 0;
  const again = createHarness(s.env, { models: { agentModel: async () => model.agentModel() }, ids: () => `again-${(next += 1)}` });
  try {
    const req = request("t3", { lead: "lead", carry: "continuing", parent: "t2" });
    await s.host.givePrompt(req.scope, { messages: req.prompt });
    expect((await again.answer(req, new WatchedSink(s.clock), new AbortController().signal)).status).toBe("released");
    const texts = model.requests[0]!.messages.map((message) => textOf(message));
    const carried = texts[texts.lastIndexOf(String(PROMPT.at(-1)!.content)) + 1]!;
    expect(carried.indexOf("Intent one.")).toBeGreaterThanOrEqual(0);
    expect(carried.indexOf("Intent two.")).toBeGreaterThan(carried.indexOf("Intent one."));
  } finally {
    await again.close();
  }
});
