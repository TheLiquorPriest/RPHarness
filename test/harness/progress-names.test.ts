// The progress lines a person reads in the chat's thinking block name things as a person does: an
// agent as the host calls it (a second of one kind by its number), never by its handle; a tool by
// what it is doing, from its file's `doing:`, and by its own name only where its file gives none.
import { afterEach, expect, test } from "bun:test";
import type { NamesPort } from "../../src/contract";
import { request, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CHIEF = "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [delegate, weather]\n---\nFixture chief: you run the turn.\n";
const GM = "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: [file_read]\n---\nFixture GM: rule on what you are asked.\n";
const PROGRESS = "---\ndescription: Fixture progress lines.\nformat: lines\n---\ntool: {{name}}{{#nth}} ({{nth}}){{/nth}}: {{#doing}}{{doing}}{{/doing}}{{^doing}}{{tool}}{{/doing}}.\ndelegate: Asking {{name}}{{#nth}} ({{nth}}){{/nth}}.\nstill: Still working ({{elapsed}}).\n";

test("an agent is named as the host calls it, a second of its kind by its number, and a tool by what it is doing, or by its name where its file says nothing", async () => {
  const named: { agent: string; nth: number }[] = [];
  const names: NamesPort = {
    agent: (_scope, agent, nth) => {
      named.push({ agent: agent.id, nth });
      return { name: agent.definition === "gm" ? "the GM" : "the chief" };
    },
  };
  const s = (open = await stage({
    names,
    files: { ".agents/chief.md": CHIEF, ".agents/gm.md": GM, ".prompts/progress.md": PROGRESS },
    tools: { weather: { tier: "read", description: "Fixture: the weather.", run: async () => ({ content: [{ type: "text", text: "Rain." }] }) } },
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-1" }] },
      { pieces: [{ call: "file_read", args: { path: "persistent-workspace/none.md" }, id: "r-1" }] },
      { pieces: [{ text: "The jump fails." }] },
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the climb." }, id: "d-2" }] },
      { pieces: [{ text: "The climb holds." }] },
      { pieces: [{ call: "weather", args: {}, id: "w-1" }] },
      { pieces: [{ text: "<reply>She climbs in the rain.</reply>" }] },
    ],
  }));

  const { outcome, sink } = await s.turn(request("t1", { lead: "chief" }));

  expect(outcome.status).toBe("released");
  expect(sink.lines.map((line) => line.line)).toEqual([
    "the chief: giving another agent a task.",
    "Asking the GM.",
    "the GM: reading a file.",
    "the chief: giving another agent a task.",
    "Asking the GM (2).",
    "the chief: weather.",
  ]);
  // The host is told which of the turn's agents of its kind each is; no line holds a handle.
  expect(named.filter((name) => name.agent.startsWith("gm-")).map((name) => name.nth)).toContain(2);
  expect(sink.lines.some((line) => /\bgm-\d|chief-\d/.test(line.line))).toBe(false);
});
