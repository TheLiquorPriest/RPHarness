// The views of the prompt in the turn's folder are written alongside the lead's run, never before its
// first call (§10.1): the first call starts while their writes are held, and a read of a view waits
// for its write, so an agent given one in that call reads it whole. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { FilesPort, PromptMessage, RawBlock } from "../../src/contract";
import type { RecordedRequest } from "../../src/testing/rig";
import { gate, request, type Stage, stage, textOf, WatchedSink } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const PERSONA = "Fixture persona: Mara is a salvage diver who will not go below the third rope.";
const PROMPT: PromptMessage[] = [
  { role: "system", content: "Fixture preset: two paragraphs at most." },
  { role: "system", content: PERSONA },
  { role: "user", content: "I check the rope before the dive." },
];
/** The chat application's block for the persona's slot, marked as the persona. */
const BLOCKS: RawBlock[] = [{ name: "Persona", type: "persona_description", role: "system", text: PERSONA, kind: "persona" }];
const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [delegate]\ngiven:\n  - prompt:*\n  - briefing\n---\nFixture lead: you run the turn.\n";
const HELPER = "---\nname: helper\ndescription: Fixture helper.\nmodel: default\ntools: []\n---\nFixture helper: answer from what you are given.\n";
const VIEWS = ["assembled-preset-prompt.md", "visible-chat-history.md", "preset-guidance.md", "persona.md", "character.md"];

test("the views' writes are held while the lead's first call starts; a delegate in that call given file:persona.md receives the persona's text once they are released", async () => {
  const held = gate();
  const written: string[] = [];
  let atFirstCall: number | undefined;
  let helper: RecordedRequest | undefined;
  const filesPort = (inner: FilesPort): FilesPort => ({
    layers: (scope) => inner.layers(scope),
    places: (scope) => inner.places(scope),
    find: (scope, query) => inner.find(scope, query),
    read: async (scope, path, range) => {
      // The helper's attachment is looked for in the chat's folder first: the views' writes are let go then, while its read of the turn's view waits.
      if (path === "persona.md") held.open();
      return inner.read(scope, path, range);
    },
    write: async (scope, path, change, by) => {
      const view = VIEWS.find((name) => path.endsWith(`/${name}`));
      if (view === undefined || by !== "harness") return inner.write(scope, path, change, by);
      await held.opened;
      const done = await inner.write(scope, path, change, by);
      written.push(view);
      return done;
    },
  });
  const s = (open = await stage({
    filesPort,
    files: { ".agents/lead.md": LEAD, ".agents/helper.md": HELPER },
    answers: [
      () => {
        atFirstCall = written.length;
        return { pieces: [{ call: "delegate", args: { agent: "helper", brief: "Say who the diver is.", attach: ["file:persona.md"] }, id: "d-1" }] };
      },
      (req) => {
        helper = req;
        return { pieces: [{ text: "She is a salvage diver." }] };
      },
      { pieces: [{ text: "<reply>The rope holds.</reply>" }] },
    ],
  }));
  const req = request("t1", { lead: "lead", prompt: PROMPT });
  await s.host.givePrompt(req.scope, { messages: PROMPT, blocks: BLOCKS });
  const outcome = await s.harness.answer(req, new WatchedSink(s.clock), new AbortController().signal);

  expect(outcome.status).toBe("released");
  expect(atFirstCall).toBe(0);
  expect(helper?.messages.map((message) => textOf(message)).join("\n")).toContain(PERSONA);
  expect(written).toContain("persona.md");
});
