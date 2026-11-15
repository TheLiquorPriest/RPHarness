// Finding every slice again in each new prompt (§4.8 "What makes a marker evergreen"): by the
// signature of its text where the text is as it was, by the chat application's block name where
// its breakdown has one, and by its place between its neighbours where neither holds.
import { expect, test } from "bun:test";
import { findName } from "../../src/prompt/names";
import type { TurnPrompt } from "../../src/prompt/prompt";
import { A_MAP, A_TEXT, B_MAP, B_TEXT, build, chatLine, LEAD, memoryHost, presetA, presetB, SCOPE, texts, turnOf, write } from "./support";

/** The markers found, in prompt order, history and lore left out. */
function markers(prompt: TurnPrompt): string[] {
  return prompt.slices.filter((slice) => slice.kind !== "history" && slice.kind !== "lore").map((slice) => slice.marker);
}

const LORE = [["e-1"], ["e-2", "e-3"], ["e-3"], ["e-1", "e-4"], ["e-2"], ["e-4"], ["e-1", "e-2", "e-3"], ["e-3", "e-1"], ["e-2"], ["e-4", "e-2"]];

test("preset A: on ten turns in which the history grows and the lore changes, every slice is found again and no text is left over", async () => {
  const host = memoryHost();
  await write(host, await turnOf(host, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]), A_MAP);
  for (const [n, lore] of LORE.entries()) {
    const prompt = await turnOf(host, presetA({ history: 4 + 2 * n, lore }), lore);
    expect(prompt.mapped).toBe(true);
    expect(markers(prompt)).toEqual(["preset.main", "persona", "card", "preset.style", "preset.after"]);
    expect(prompt.slices.filter((slice) => slice.kind === "history")).toHaveLength(4 + 2 * n);
    expect(texts(await findName(prompt, "persona", LEAD))).toEqual([A_TEXT.persona]);
  }
});

test("preset B: the slices found again on ten turns, the note wherever the history puts it", async () => {
  const host = memoryHost();
  await write(host, await turnOf(host, presetB({ history: 4, lore: ["e-3"] }), ["e-3"]), B_MAP);
  for (const [n, lore] of LORE.entries()) {
    const prompt = await turnOf(host, presetB({ history: 6 + 2 * n, lore }), lore);
    expect(markers(prompt)).toEqual(["rules", "style", "persona", "card", "note"]);
    expect(texts(await findName(prompt, "kind(style)", LEAD))).toEqual([B_TEXT.style]);
    expect(texts(await findName(prompt, "note", LEAD))).toEqual([B_TEXT.note]);
  }
});

test("a slice whose words changed is found by the chat application's block name, and where there is none, by its place", async () => {
  // Another chat on preset A: its own persona and character, and a part of its own after them. Their place alone could not tell three stretches between two slices apart; the breakdown's block names do.
  const host = memoryHost();
  await write(host, await turnOf(host, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]), A_MAP);
  const text = { persona: "Ash is the player's character: a pilgrim who walks the towpath.", card: "Wren is a lock-keeper who has never left the river." };
  const a = await turnOf(host, presetA({ history: 4, lore: ["e-2"], text }, undefined, { after: "card", text: "Out of character: no violence." }), ["e-2"]);
  expect(markers(a)).toEqual(["preset.main", "persona", "card", "message[3]", "preset.style", "preset.after"]);
  expect(texts(await findName(a, "persona", LEAD))).toEqual([text.persona]);
  expect(texts(await findName(a, "card", LEAD))).toEqual([text.card]);
  expect(texts(await findName(a, "message[3]", LEAD))).toEqual(["Out of character: no violence."]);

  // Another chat on preset B: its own persona and character, the note's weather changed; each is found between the slices around it.
  const other = memoryHost();
  await write(other, await turnOf(other, presetB({ history: 4, lore: ["e-3"] }), ["e-3"]), B_MAP);
  const persona = "The player is Bryn, a lamplighter who sees more than she says.";
  const card = "Hollis is a bookseller who buys stolen letters.";
  const note = "[Note: rain tonight, and the fog has lifted.]";
  const b = await turnOf(other, presetB({ history: 6, lore: ["e-1"], text: { persona, card, note } }), ["e-1"]);
  expect(markers(b)).toEqual(["rules", "style", "persona", "card", "note"]);
  expect(texts(await findName(b, "persona", LEAD))).toEqual([persona]);
  expect(texts(await findName(b, "card", LEAD))).toEqual([card]);
  expect(texts(await findName(b, "note", LEAD))).toEqual([note]);
});

test("two neighbours whose words both changed, with a new part between them, are not guessed: their text belongs to no slice", async () => {
  const host = memoryHost();
  await write(host, await turnOf(host, presetB({ history: 4, lore: ["e-3"] }), ["e-3"]), B_MAP);
  const built = build(
    [
      { role: "system", parts: [{ text: `${B_TEXT.rules}\n\n${B_TEXT.style}`, kind: "other" }] },
      { role: "system", parts: [{ text: "The player is Bryn.", kind: "other" }] },
      { role: "system", parts: [{ text: "Out of character: keep it short.", kind: "other" }] },
      { role: "system", parts: [{ text: "Hollis sells letters.", kind: "other" }] },
      { role: "user", parts: [chatLine(0)] },
      { role: "system", parts: [{ text: B_TEXT.note, kind: "other" }] },
      { role: "assistant", parts: [chatLine(1)] },
    ],
    [],
    { id: "preset-b", name: "Fog City", revision: "7" },
  );
  const prompt = await turnOf(host, built, []);
  expect(markers(prompt)).toEqual(["rules", "style", "message[1]", "message[2]", "message[3]", "note"]);
  expect(prompt.slices.filter((slice) => slice.from === "unclaimed").map((slice) => prompt.text(slice))).toEqual(["The player is Bryn.", "Out of character: keep it short.", "Hollis sells letters."]);
});

test("a map learned with the head at 64 is found under 32; a map learned under 32 keeps 32 characters", async () => {
  for (const head of [64, 32]) {
    const host = memoryHost();
    expect((await write(host, await turnOf(host, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]), A_MAP, head)).error).toBe(false);
    const map = await host.env.prompt.map(SCOPE);
    const starts = map?.slices.map((slice) => (JSON.parse(slice.find.signature ?? "[]") as { a: string }[])[0]?.a.length);
    expect(starts).toEqual(map?.slices.map((slice) => Math.min(head, A_TEXT[({ "preset.main": "main", persona: "persona", card: "card", "preset.style": "style", "preset.after": "post" } as const)[slice.marker as "persona"]].length)));
    // Found again on a later turn, whatever the setting is now: each signature keeps its own start.
    const later = await turnOf(host, presetA({ history: 6, lore: ["e-2"] }), ["e-2"]);
    expect(markers(later)).toEqual(["preset.main", "persona", "card", "preset.style", "preset.after"]);
  }
});
