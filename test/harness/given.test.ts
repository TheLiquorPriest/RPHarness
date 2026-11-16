// What the lead is given by name (§5.4 `given:`, §10.2): beyond the prompt, what the session carries
// and the briefing, every name a sub-agent's definition may name is found the same way (a file, a
// stretch of the chat, a view the host gives) and placed after the briefing, laid out by RPH's own
// given part; a name nothing could be found for says so in one line, and the host keeps the list.
import { afterEach, expect, test } from "bun:test";
import type { AttachmentRef } from "../../src/contract";
import { request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const NAMES = ["file:persistent-workspace/notes.md", "chat:history[-2:]", "fixture-view", "no-such-view"];
const CHIEF = `---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: []\ngiven: [prompt:*, briefing, ${NAMES.map((name) => JSON.stringify(name)).join(", ")}]\n---\nFixture chief: you run the turn.\n`;

test("the lead is given each other name it names, after the briefing, as a sub-agent would be; a name nobody could give is said in one line, and the host is given the list", async () => {
  const s = (open = await stage({
    files: { ".agents/chief.md": CHIEF, "chats/wren-hale/lighthouse/persistent-workspace/notes.md": "Fixture note: the boat is two days late." },
    chat: [
      { id: "m0", role: "user", name: "Reader", text: "Fixture: I climb the stairs." },
      { id: "m1", role: "assistant", name: "Wren", text: "Fixture: the lamp turns." },
      { id: "m2", role: "user", name: "Reader", text: "Fixture: I ask about the boat." },
    ],
    events: (inner) => ({
      ...inner,
      attachments: async (scope, agent, refs, moment) => [...(await inner.attachments(scope, agent, refs, moment)), ...refs.filter((ref) => ref.ref === "fixture-view").map((ref) => ({ name: ref.ref, text: "Fixture view: the storm is an hour off." }))],
    }),
    answers: [{ pieces: [{ text: "<reply>No boat tonight.</reply>" }] }],
  }));

  const { outcome } = await s.turn(request("t1", { lead: "chief" }));

  expect(outcome.status).toBe("released");
  const sent = s.model.requests[0]!.messages;
  expect(textOf(sent.at(-2)!)).toStartWith("# Briefing for this turn");
  expect(textOf(sent.at(-1)!)).toBe(
    [
      "## What you have been given",
      "",
      "### file:persistent-workspace/notes.md",
      "",
      "Fixture note: the boat is two days late.",
      "",
      "### chat:history[-2:]",
      "",
      "#1 Wren: Fixture: the lamp turns.",
      "",
      "#2 Reader: Fixture: I ask about the boat.",
      "",
      "### fixture-view",
      "",
      "Fixture view: the storm is an hour off.",
      "",
      "no-such-view could not be found.",
    ].join("\n"),
  );
  const told = s.told.filter((told) => told.kind === "attachments").map((told) => (told.payload as AttachmentRef[]).map((ref) => [ref.ref, ref.from, ref.own]));
  expect(told).toEqual([NAMES.map((name) => [name, "definition", !name.endsWith("view")])]);
});
