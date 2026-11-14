// The `prompt` tool (§4.8): on the first turn, with nothing learned, the raw layout answers it: the
// map with no names, and the text of any part by name. Its words are lines of a file.
import { expect, test } from "bun:test";
import type { JsonValue } from "../../src/contract";
import { TurnPrompt } from "../../src/prompt/prompt";
import { promptTool } from "../../src/prompt/tools";
import { A_TEXT, B_TEXT, type BuiltPrompt, ctxOf, memoryHost, presetA, presetB, SCOPE, shippedParts, shippedTool } from "./support";

async function call(built: BuiltPrompt, lore: string[], args: JsonValue, edits: Record<string, string> = {}) {
  const host = memoryHost();
  host.set(built, lore);
  const prompt = await TurnPrompt.read({ env: host.env, scope: SCOPE, messages: built.messages });
  const tool = promptTool({ prompt: async () => prompt, guidance: shippedParts(edits), texts: new Map([["prompt", await shippedTool("prompt")]]), env: host.env });
  const result = await tool.run(args, ctxOf());
  return { text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""), error: result.error === true, tool };
}

test("with no names, the first turn's map: the chat application's block names, the lore, the history, and the notice that nothing is mapped", async () => {
  const { text, tool } = await call(presetA({ history: 4, lore: ["e-1", "e-2"] }), ["e-1", "e-2"], {});
  expect(tool.description).toContain("history[-30:]");
  expect(text.split("\n")).toEqual([
    "This prompt has no map yet. Its parts are named by the chat application's own block names where it gave them, and by their place where it did not: message[3] is the fourth message.",
    `Main Prompt - other, ${A_TEXT.main.length} characters`,
    "message[1] - lore, 119 characters",
    `Persona - other, ${A_TEXT.persona.length} characters`,
    `Character Description - other, ${A_TEXT.card.length} characters`,
    `Style Guide - other, ${A_TEXT.style.length} characters`,
    "history - 4 chat messages, #0 to #3, 154 characters",
    `Post-History Instructions - other, ${A_TEXT.post.length} characters`,
    "Lore entries in this prompt, each read as lore[id]: e-1, e-2",
    "This preset's prompt has not been mapped yet. The whole prompt is in front of you as always. Its parts are named by place until it is mapped.",
  ]);
});

test("with names, each part's text exactly as it stands, under its head", async () => {
  const { text, error } = await call(presetA({ history: 4, lore: ["e-1"] }), ["e-1"], { names: ["Persona", "history[-2:]"] });
  expect(error).toBe(false);
  expect(text).toBe(
    [`[Persona]\n${A_TEXT.persona}`, "#2 (m2) Tam, user\nTam: I ask about the river, time 2.", "#3 (m3) Wren, assistant\nWren: The river is high tonight, answer 3."].join("\n\n"),
  );
});

test("preset B, with no blocks: the parts go by place, and a name the prompt does not have says so", async () => {
  const built = presetB({ history: 4, lore: ["e-3"] });
  const { text } = await call(built, ["e-3"], { names: ["message[0]", "Main Prompt"] });
  expect(text).toBe(`[message[0]]\n${B_TEXT.rules}\n\n${B_TEXT.style}\n\nThis prompt has no part named Main Prompt.`);
  const unknown = await call(built, ["e-3"], { names: ["persona"] });
  expect(unknown).toMatchObject({ text: "This prompt has no part named persona.", error: true });
});

test("the words are the file's: a line taken out of it takes those words out of the answer", async () => {
  const shipped = await Bun.file(`${import.meta.dir}/../../guidance/.prompts/prompt-map.md`).text();
  const edited = shipped
    .split("\n")
    .filter((line) => !line.startsWith("slice_head:"))
    .join("\n");
  const { text } = await call(presetA({ history: 2, lore: [] }), [], { names: ["Style Guide"] }, { "prompt-map": edited });
  expect(text).toBe(A_TEXT.style);
});

test("with no prompt in view, the tool says so", async () => {
  const host = memoryHost();
  const tool = promptTool({ prompt: async () => undefined, guidance: shippedParts(), texts: new Map(), env: host.env });
  const result = await tool.run({}, ctxOf());
  expect(result).toEqual({ content: [{ type: "text", text: "There is no prompt to read: this work is not for a reply." }], error: true });
});
