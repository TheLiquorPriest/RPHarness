// The prompt map in a whole turn (§4.8): on a chat's first turn, with nothing learned, the lead's
// `prompt` gives the map of the prompt by its raw layout, and the text of a part by the name the
// map gives it; a sub-agent given a part by a `prompt:` name, by its definition or by `delegate`,
// gets that part's text and nothing else of the prompt; and the turn's folder holds the views.
import { afterEach, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { RawBlock } from "../../src/contract";
import { PROMPT, request, type Stage, stage, textOf, WatchedSink } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CHIEF = "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [prompt, delegate]\ngiven: [prompt:*]\n---\nFixture chief: you run the turn.\n";
const READER = "---\nname: reader\ndescription: Fixture reader.\nmodel: default\ntools: []\ngiven: [prompt:Main Prompt]\n---\nFixture reader: say what you were given.\n";
const PRESET = String(PROMPT[0]!.content);
const CARD = String(PROMPT[1]!.content);
const NEWEST = String(PROMPT.at(-1)!.content);
/** The chat application's own breakdown of the prompt into blocks, by name. */
const BLOCKS: RawBlock[] = [
  { name: "Main Prompt", type: "main", text: PRESET },
  { name: "Char Description", type: "character", text: CARD },
];

function lastResult(messages: readonly Message[]): string {
  const result = messages.filter((message) => message.role === "toolResult").at(-1);
  return result === undefined ? "" : textOf(result);
}

test("on a first turn with nothing learned, the lead reads the map and a part by its name, and a sub-agent given parts by prompt: names gets those parts' text and no more", async () => {
  const s = (open = await stage({
    files: { ".agents/chief.md": CHIEF, ".agents/reader.md": READER },
    answers: [
      { pieces: [{ call: "prompt", args: {} }] },
      { pieces: [{ call: "prompt", args: { names: ["Main Prompt"] } }] },
      { pieces: [{ call: "delegate", args: { agent: "reader", brief: "Fixture brief: say what you were given.", attach: ["prompt:Char Description"] } }] },
      { pieces: [{ text: "Fixture reader: done." }] },
      { pieces: [{ text: "<reply>No boat tonight.</reply>" }] },
    ],
  }));
  const req = request("t1", { lead: "chief" });
  await s.host.givePrompt(req.scope, { messages: req.prompt, blocks: BLOCKS });
  const outcome = await s.harness.answer(req, new WatchedSink(s.clock), new AbortController().signal);
  expect(outcome.status).toBe("released");
  const [, mapped, named, reader] = s.model.requests;

  // The map names each block by the chat application's name, and the rest by place.
  const map = lastResult(mapped!.messages);
  for (const name of ["Main Prompt", "Char Description", "message[6]"]) expect(map).toContain(name);
  // A part by its name: its text, exactly as it stands in the prompt.
  const part = lastResult(named!.messages);
  expect(part).toContain(PRESET);
  expect(part).not.toContain(CARD);

  // The sub-agent: the part its definition names and the part it was handed, and nothing else of the prompt.
  const given = reader!.messages.map((message) => textOf(message)).join("\n");
  expect(given).toContain(PRESET);
  expect(given).toContain(CARD);
  expect(given).not.toContain(NEWEST);

  // The turn's folder holds the views of the prompt, the whole of it among them.
  const places = await s.env.files.places(req.scope);
  const whole = await s.env.files.read(req.scope, `${places.turn}assembled-preset-prompt.md`);
  expect(whole.status === "read" && whole.text.includes(NEWEST) && whole.text.includes(PRESET)).toBe(true);
});
