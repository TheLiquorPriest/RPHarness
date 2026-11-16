// The passive notices (§4.8 "What code does every turn"): each turn's prompt is compared with the
// turn it follows. What is expected to change (the history grows, other lore activates, a slice
// that changes with the scene) says nothing; a fixed slice whose words changed, a slice that is
// gone, text that belongs to no slice, slices in another order and another preset each give their
// own notice, one line each from a file. Nothing is held back.
import { expect, test } from "bun:test";
import type { PromptNotice } from "../../src/contract";
import { promptTurn } from "../../src/prompt/memory";
import { noticeLines, promptWords } from "../../src/prompt/words";
import { A_MAP, B_MAP, type BuiltPrompt, LEAD, memoryHost, type MemoryHost, presetA, presetB, SCOPE, shippedParts, write } from "./support";

const LORE = [["e-1"], ["e-2", "e-3"], ["e-3"], ["e-1", "e-4"], ["e-2"], ["e-4"], ["e-1", "e-2", "e-3"], ["e-3", "e-1"], ["e-2"], ["e-4", "e-2"]];

/** One turn of the chat: the host holds `built`, and the turn follows `parent`. */
async function play(host: MemoryHost, turn: string, built: BuiltPrompt, lore: string[], parent?: string) {
  host.set(built, lore);
  return promptTurn({ env: host.env, scope: { ...SCOPE, turn }, messages: built.messages, parent, by: LEAD });
}

/** A chat on preset A mapped at its first turn and played for ten more, each turn with more history and other lore. */
async function mappedA(): Promise<MemoryHost> {
  const host = memoryHost();
  const first = await play(host, "t-0", presetA({ history: 2, lore: ["e-1"] }), ["e-1"], undefined);
  expect(first.located.notices).toEqual([{ kind: "unmapped" }]);
  await write(host, first.prompt, A_MAP);
  for (const [n, lore] of LORE.entries()) {
    const { located } = await play(host, `t-${n + 1}`, presetA({ history: 4 + 2 * n, lore }), lore, `t-${n}`);
    expect(located.notices).toEqual([]);
    expect(located.unclaimed).toEqual([]);
  }
  return host;
}

test("preset A: ten turns in which the history grows and the lore changes give no notice; each change after them gives exactly its own", async () => {
  const host = await mappedA();
  const after = (built: BuiltPrompt, turn: string) => play(host, turn, built, ["e-2"], "t-10");
  const shape = { history: 24, lore: ["e-2"] };
  const notices = async (built: BuiltPrompt, turn: string): Promise<PromptNotice[]> => (await after(built, turn)).located.notices;

  expect(await notices(presetA(shape), "same")).toEqual([]);
  expect(await notices(presetA({ ...shape, text: { style: "Write in the present tense." } }), "words")).toEqual([{ kind: "changed", marker: "preset.style" }]);
  expect(await notices(presetA(shape, ["main", "persona", "card", "style"]), "removed")).toEqual([{ kind: "gone", marker: "preset.after" }]);
  expect(await notices(presetA(shape, undefined, { after: "style", text: "Out of character: no violence." }), "added")).toEqual([{ kind: "unclaimed", message: 4, start: 0, end: 30 }]);
  expect(await notices(presetA(shape, ["main", "style", "persona", "card", "post"]), "swapped")).toEqual([{ kind: "order", markers: ["preset.style"] }]);
  const host2 = await mappedA();
  host2.set(presetA(shape), ["e-2"]);
  const revised = presetA(shape);
  revised.layout.preset = { id: "preset-a", name: "River Tales", revision: "2" };
  host2.set(revised, ["e-2"]);
  const { located } = await promptTurn({ env: host2.env, scope: { ...SCOPE, turn: "revised" }, messages: revised.messages, parent: "t-10", by: LEAD });
  expect(located.notices).toEqual([{ kind: "preset", was: { id: "preset-a", name: "River Tales", revision: "1" }, now: { id: "preset-a", name: "River Tales", revision: "2" } }]);
});

test("preset B: ten turns give no notice, nor does the note that changes with the scene; the host is given where each slice was found", async () => {
  const host = memoryHost();
  const first = await play(host, "t-0", presetB({ history: 4, lore: ["e-3"] }), ["e-3"], undefined);
  await write(host, first.prompt, B_MAP);
  for (const [n, lore] of LORE.entries()) {
    const note = n % 3 === 0 ? "[Note: a bell is ringing somewhere in the fog.]" : undefined;
    const { located } = await play(host, `t-${n + 1}`, presetB({ history: 6 + 2 * n, lore, ...(note !== undefined ? { text: { note } } : {}) }), lore, `t-${n}`);
    expect(located.notices).toEqual([]);
  }
  const last = host.located.at(-1);
  expect(last?.slices.filter((slice) => slice.kind !== "history" && slice.kind !== "lore").map((slice) => slice.marker)).toEqual(["rules", "style", "persona", "card", "note"]);
  expect(last?.preset?.id).toBe("preset-b");
});

test("each notice is one line of the file, for the briefing and the prompt tool", async () => {
  const host = await mappedA();
  const { prompt } = await play(host, "lines", presetA({ history: 24, lore: ["e-2"], text: { style: "Present tense." } }, ["main", "style", "persona", "card"], { after: "card", text: "Be brief." }), ["e-2"], "t-10");
  expect(noticeLines(prompt, await promptWords(shippedParts()))).toEqual([
    "The text of preset.style, which the map says is fixed, has changed since the turn before.",
    "preset.after is not in this prompt.",
    "Text that belongs to no part of the map: message[4], 9 characters.",
    "preset.style moved: the prompt's parts are in a different order than the turn before.",
  ]);
});
