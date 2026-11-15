// The map from the first turn (§4.8): with nothing learned, the raw layout names the prompt's parts,
// by the chat application's block names where it gave them and by place where it did not, and each
// block is of the kind its own block says.
import { expect, test } from "bun:test";
import { findName } from "../../src/prompt/names";
import { TurnPrompt } from "../../src/prompt/prompt";
import { A_TEXT, B_TEXT, type BuiltPrompt, ENTRIES, LEAD, markedA, memoryHost, presetA, presetB, SCOPE } from "./support";

async function first(built: BuiltPrompt, lore: string[]) {
  const host = memoryHost();
  host.set(built, lore);
  return TurnPrompt.read({ env: host.env, scope: SCOPE, messages: built.messages });
}

test("preset A: each block under the chat application's name, the lore and the history by what they are", async () => {
  const prompt = await first(presetA({ history: 4, lore: ["e-1", "e-2"] }), ["e-1", "e-2"]);
  const named = prompt.slices.map((slice) => [slice.marker, slice.kind, prompt.text(slice)]);
  expect(named).toEqual([
    ["Main Prompt", "other", A_TEXT.main],
    ["message[1]", "lore", `${ENTRIES["e-1"]?.text}\n${ENTRIES["e-2"]?.text}`],
    ["Persona", "other", A_TEXT.persona],
    ["Character Description", "other", A_TEXT.card],
    ["Style Guide", "other", A_TEXT.style],
    ["history[#0]", "history", "Tam: I ask about the river, time 0."],
    ["history[#1]", "history", "Wren: The river is high tonight, answer 1."],
    ["history[#2]", "history", "Tam: I ask about the river, time 2."],
    ["history[#3]", "history", "Wren: The river is high tonight, answer 3."],
    ["Post-History Instructions", "other", A_TEXT.post],
  ]);
  // Every instruction character is under a name the chat application gave.
  const instructions = prompt.slices.filter((slice) => slice.kind === "other");
  expect(instructions.every((slice) => slice.from === "block")).toBe(true);
  expect(prompt.slices.find((slice) => slice.marker === "Persona")?.block).toEqual({ name: "Persona", type: "persona" });
});

test("a block the host marks persona is the persona slice before a map is learned; kind(character) gives the card's blocks in order; kind(instructions) gives the preset's own blocks in order under their block names; an unmarked block is other", async () => {
  const prompt = await first(markedA(presetA({ history: 2, lore: ["e-1"] })), ["e-1"]);
  expect(prompt.slices.filter((slice) => slice.from === "block").map((slice) => [slice.marker, slice.kind])).toEqual([
    ["Main Prompt", "instructions"],
    ["Persona", "persona"],
    ["Character Description", "character"],
    ["Style Guide", "other"],
    ["Post-History Instructions", "instructions"],
  ]);
  const found = async (name: string) => (await findName(prompt, name, LEAD))?.flatMap((item) => (item.type === "slice" ? [[item.slice.marker, item.text]] : []));
  expect(await found("kind(persona)")).toEqual([["Persona", A_TEXT.persona]]);
  expect(await found("kind(character)")).toEqual([["Character Description", A_TEXT.card]]);
  expect(await found("kind(instructions)")).toEqual([
    ["Main Prompt", A_TEXT.main],
    ["Post-History Instructions", A_TEXT.post],
  ]);
  expect(await found("kind(other)")).toEqual([["Style Guide", A_TEXT.style]]);
});

test("preset B: with no blocks, every part is named by its place, the history by message", async () => {
  const prompt = await first(presetB({ history: 4, lore: ["e-3"] }), ["e-3"]);
  const named = prompt.slices.map((slice) => [slice.marker, slice.kind, prompt.text(slice)]);
  expect(named).toEqual([
    ["message[0]", "other", `${B_TEXT.rules}\n\n${B_TEXT.style}`],
    ["message[1]", "other", B_TEXT.persona],
    ["message[2]", "other", B_TEXT.card],
    ["message[3]", "lore", ENTRIES["e-3"]?.text],
    ["history[#0]", "history", "Tam: I ask about the river, time 0."],
    ["history[#1]", "history", "Wren: The river is high tonight, answer 1."],
    ["message[6]", "other", B_TEXT.note],
    ["history[#2]", "history", "Tam: I ask about the river, time 2."],
    ["history[#3]", "history", "Wren: The river is high tonight, answer 3."],
  ]);
  expect(prompt.slices.some((slice) => slice.from === "block")).toBe(false);
});

test("a layout that is not of this prompt names each message by its place alone", async () => {
  const built = presetA({ history: 2, lore: ["e-1"] });
  const host = memoryHost();
  host.set(presetA({ history: 3, lore: ["e-1"] }), ["e-1"]);
  const prompt = await TurnPrompt.read({ env: host.env, scope: SCOPE, messages: built.messages });
  expect(prompt.cut.fits).toBe(false);
  expect(prompt.slices.map((slice) => slice.marker)).toEqual(built.messages.map((_, at) => `message[${at}]`));
  expect(prompt.text(prompt.slices[2] ?? { spans: [] })).toBe(`${A_TEXT.persona}\n\n${A_TEXT.card}`);
});

test("a host that cannot give the layout: the prompt is still named by place, and the log says why", async () => {
  const built = presetB({ history: 2, lore: ["e-3"] });
  const host = memoryHost();
  const prompt = await TurnPrompt.read({ env: host.env, scope: SCOPE, messages: built.messages });
  expect(prompt.slices.map((slice) => slice.marker)).toEqual(built.messages.map((_, at) => `message[${at}]`));
  expect(host.logged).toContain("The host could not give the prompt's layout.");
});
