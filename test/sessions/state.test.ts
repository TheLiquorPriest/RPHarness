// What the harness keeps of a session beside its file in memory (each lead's opening block, what the
// rules remembered of each turn, the replies that went out with no intent record) is not kept for
// the life of the process: the host closing the session lets it go, and a turn keeps the rules'
// memory there only of the turns a later turn can still follow. The session file keeps the opening
// block, so a session open again goes on with its own.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { RuleMemory } from "../../src/files/api";
import { keepOnly, memoryAt, Sessions } from "../../src/harness/sessions";
import { SessionLog } from "../../src/sessions/file";
import { type Stage, stage, textOf } from "../harness/support";
import { played, S1, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const lead = (words: string) => `---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [todo]\ngiven:\n  - prompt:*\n  - session:carry\n  - briefing\n---\nFixture lead: ${words}\n`;

test("a session closed and opened again by its closing turn leaving the path goes on with its own opening block", async () => {
  const s = (open = await stage({ files: { ".agents/lead.md": lead("first words.") }, answers: [played(1), played(2), played(3)] }));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  expect((await s.turn(turn("t2", { parent: "t1" }))).outcome.status).toBe("released");
  expect(await s.harness.sessions!.close({ ...S1, turn: "t2" })).toMatchObject({ state: "closed" });

  await Bun.write(join(s.dir, "files", ".agents", "lead.md"), lead("second words."));
  await s.harness.turnLeft({ ...S1, turn: "t2" });
  expect((await s.turn(turn("t2b", { kind: "swipe", parent: "t1" }))).outcome.status).toBe("released");

  const opening = (n: number) => textOf(s.model.requests[n]!.messages[0]!);
  expect(opening(2)).toBe(opening(1));
  expect(opening(2)).toContain("Fixture lead: first words.");
  expect(s.model.requests[2]!.tools).toEqual(s.model.requests[1]!.tools);
  // The edit reaches the briefing as a changed file.
  expect(textOf(s.model.requests[2]!.messages.at(-1)!)).toContain("Fixture lead: second words.");
});

test("the rules' memory is kept in memory for the turns given, and a turn that follows one let go, which the store does not hold either, starts from the nearest kept before it", async () => {
  const s = (open = await stage({ answers: [] }));
  const sessions = new Sessions();
  const state = sessions.of(S1);
  const log = new SessionLog([
    { type: "turn", id: "e1", parent: null, at: 0, turn: "t1", kind: "new", lead: "lead" },
    { type: "turn", id: "e2", parent: "e1", at: 0, turn: "t2", kind: "new", lead: "lead" },
    { type: "turn", id: "e3", parent: "e1", at: 0, turn: "t2b", kind: "swipe", lead: "lead" },
  ]);
  const memory = (name: string) => ({ fixture: name }) as unknown as RuleMemory;
  for (const name of ["t1", "t2", "t2b"]) state.memories.set(name, memory(name));

  keepOnly(state, new Set(["t1", "t2b"]));
  expect([...state.memories.keys()]).toEqual(["t1", "t2b"]);
  expect(await memoryAt(state, s.env, S1, log, "e2", undefined)).toEqual(memory("t1"));
  expect(await memoryAt(state, s.env, S1, log, "e3", undefined)).toEqual(memory("t2b"));

  sessions.drop(S1);
  expect(sessions.of(S1).memories.size).toBe(0);
});
