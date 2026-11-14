// What a sub-agent may write (§13.4, §6.8): its writes go through the same gate as the lead's, as
// itself, with its own name and the character it plays; nothing is written under the lead's name.
import { afterEach, expect, test } from "bun:test";
import type { ApprovalAsk } from "../../src/contract";
import { definition, said, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = definition("lead", { model: "lead-model", tools: ["delegate", "file_write"] }, "Fixture lead: you run the turn.");
const CHARACTER = definition("character", { model: "character-model", tools: ["file_write", "record_beat"] }, "Fixture character: you are who you play.");

test("a sub-agent's writes pass the lead's gate as the sub-agent, with what it plays", async () => {
  const asked: ApprovalAsk[] = [];
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/character.md": CHARACTER },
    tools: {
      record_beat: { tier: "write", lane: "story", description: "Fixture: records a beat.", parameters: { properties: { what: { type: "string" } } }, run: async () => said("Recorded.") },
    },
    approvals: {
      permission: async (_scope, lane) => (lane === "story" ? "confirm" : "auto"),
      ask: async (_scope, ask) => {
        asked.push(ask);
        return { go: true };
      },
    },
    models: {
      "lead-model": [{ pieces: [{ call: "delegate", args: { agent: "character", brief: "Take in the jump.", plays: "wren-hale" }, id: "d-1" }] }, { pieces: [{ text: "Settled." }] }],
      "character-model": [
        { pieces: [{ call: "file_write", args: { path: "persistent-workspace/wren.md", op: "write", text: "Wren saw the jump fail." }, id: "w-1" }, { call: "record_beat", args: { what: "the jump failed" }, id: "b-1" }] },
        { pieces: [{ text: "Taken in." }] },
      ],
    },
  }));

  const turn = await s.play("She leaps for the far ledge.");
  const outcome = await turn.done;

  expect(outcome.status).toBe("done");
  const character = { id: "character-1", definition: "character", parent: turn.lead.id, plays: "wren-hale" };
  // The host's record of the turn's writes names the sub-agent, and only it.
  expect(await s.kept({ writes: "t1" })).toEqual([{ agent: character, path: "persistent-workspace/wren.md", before: null, after: expect.any(String) }]);
  // The player's word was asked for the sub-agent's write, as the sub-agent's.
  expect(asked).toEqual([{ agent: character, callId: "b-1", tool: "record_beat", lane: "story", args: { what: "the jump failed" }, at: expect.any(Number) }]);
  const approval = s.trace.of("approval_asked")[0];
  expect(approval?.agent).toEqual(character);
  expect(approval?.parent).toEqual({ agent: turn.lead.id, run: "t1", call: "d-1" });
});
