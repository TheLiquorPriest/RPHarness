// A learned map (§4.8 steps 2 and 3): `prompt_map_write` takes the mapper's slices, RPH writes each
// one's finder from the prompt as it stands, the host keeps the map for the preset, and every part
// of the prompt then belongs to a named slice with a kind. The player's edits survive a new mapping.
import { expect, test } from "bun:test";
import { findName } from "../../src/prompt/names";
import { A_MAP, A_TEXT, B_MAP, B_TEXT, LEAD, memoryHost, PRESET_A, presetA, presetB, texts, turnOf, write } from "./support";

test("preset A: the mapper's map is kept for the preset, and every part of the prompt belongs to a named slice with a kind", async () => {
  const host = memoryHost();
  const prompt = await turnOf(host, presetA({ history: 4, lore: ["e-1"] }), ["e-1"]);
  expect(await write(host, prompt, A_MAP)).toEqual({ text: "The map of River Tales is saved: 5 slices.", error: false });
  const saved = host.maps.get(PRESET_A.id);
  expect(saved?.slices.map((slice) => [slice.marker, slice.kind, slice.behaviour, slice.find.block])).toEqual([
    ["preset.main", "instructions", "fixed", "Main Prompt"],
    ["persona", "persona", "fixed", "Persona"],
    ["card", "character", "fixed", "Character Description"],
    ["preset.style", "style", "fixed", "Style Guide"],
    ["preset.after", "instructions", "fixed", "Post-History Instructions"],
  ]);
  expect(saved?.slices.every((slice) => typeof slice.find.signature === "string")).toBe(true);
  expect(prompt.mapped).toBe(true);
  expect(prompt.slices.filter((slice) => slice.from === "unclaimed")).toEqual([]);
  expect(prompt.slices.map((slice) => [slice.marker, slice.kind])).toEqual([
    ["preset.main", "instructions"],
    ["message[1]", "lore"],
    ["persona", "persona"],
    ["card", "character"],
    ["preset.style", "style"],
    ["history[#0]", "history"],
    ["history[#1]", "history"],
    ["history[#2]", "history"],
    ["history[#3]", "history"],
    ["preset.after", "instructions"],
  ]);
  expect(texts(await findName(prompt, "kind(style)", LEAD))).toEqual([A_TEXT.style]);
  expect(texts(await findName(prompt, "card", LEAD))).toEqual([A_TEXT.card]);
});

test("preset B: a slice can begin partway through a part, and the one before it ends there", async () => {
  const host = memoryHost();
  const prompt = await turnOf(host, presetB({ history: 4, lore: ["e-3"] }), ["e-3"]);
  expect(await write(host, prompt, B_MAP)).toEqual({ text: "The map of Fog City is saved: 5 slices.", error: false });
  expect(prompt.slices.filter((slice) => slice.from === "unclaimed")).toEqual([]);
  expect(prompt.slices.every((slice) => slice.kind !== "other")).toBe(true);
  expect(texts(await findName(prompt, "rules", LEAD))).toEqual([B_TEXT.rules]);
  expect(texts(await findName(prompt, "kind(style)", LEAD))).toEqual([B_TEXT.style]);
  expect(texts(await findName(prompt, "note", LEAD))).toEqual([B_TEXT.note]);
});

test("text the map leaves out is named in the answer; a map that cannot be made is not saved, and the answer says why", async () => {
  const host = memoryHost();
  const prompt = await turnOf(host, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]);
  expect(await write(host, prompt, A_MAP.slice(0, 4))).toEqual({
    text: "The map of River Tales is saved: 4 slices.\nText that belongs to no slice: message[6]. Read it with prompt, and write the map again to give it a slice.",
    error: false,
  });
  const other = memoryHost();
  const fresh = await turnOf(other, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]);
  const bad = await write(other, fresh, [
    { marker: "main", kind: "instructions", line: "", behaviour: "fixed", parts: ["Main Prompt"] },
    { marker: "also.main", kind: "instructions", line: "", behaviour: "fixed", parts: ["Main Prompt"] },
    { marker: "chat", kind: "history", line: "", behaviour: "turn", parts: ["history[#0]"] },
    { marker: "ghost", kind: "other", line: "", behaviour: "fixed", parts: ["Nothing Here"] },
  ]);
  expect(bad).toEqual({
    text: ["chat: history[#0] is not a part a slice is made of. Chat history goes by message and lore by entry, without a map.", "ghost: this prompt has no part named Nothing Here."].join("\n"),
    error: true,
  });
  expect(other.maps.size).toBe(0);
  const same = await write(other, fresh, [
    { marker: "main", kind: "instructions", line: "", behaviour: "fixed", parts: ["Main Prompt"] },
    { marker: "also.main", kind: "instructions", line: "", behaviour: "fixed", parts: ["Main Prompt"] },
  ]);
  expect(same.text.split("\n")[0]).toBe("main and also.main begin at the same place. Give the later one its first words as starts.");
  expect(other.maps.size).toBe(0);
});

test("the player's rename survives a new mapping", async () => {
  const host = memoryHost();
  const first = await turnOf(host, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]);
  await write(host, first, A_MAP);
  // On the Prompt page, the player renames `card` and says what it is in their own words.
  const map = host.maps.get(PRESET_A.id);
  if (map === undefined) throw new Error("no map was saved");
  host.maps.set(PRESET_A.id, { ...map, slices: map.slices.map((slice) => (slice.marker === "card" ? { ...slice, marker: "card.wren", line: "Wren, as the player sees her.", edited: true as const } : slice)) });
  // A later turn, and the mapper maps the prompt again, calling it `card` once more.
  const later = await turnOf(host, presetA({ history: 6, lore: ["e-2"] }), ["e-2"]);
  expect(await write(host, later, A_MAP)).toEqual({ text: "The map of River Tales is saved: 5 slices.\nThe player's own slices are kept as the player left them: card.wren.", error: false });
  const saved = host.maps.get(PRESET_A.id);
  expect(saved?.slices.map((slice) => slice.marker)).toEqual(["preset.main", "persona", "card.wren", "preset.style", "preset.after"]);
  expect(saved?.slices.find((slice) => slice.marker === "card.wren")).toMatchObject({ line: "Wren, as the player sees her.", edited: true, kind: "character" });
  expect(texts(await findName(later, "card.wren", LEAD))).toEqual([A_TEXT.card]);
  expect(await findName(later, "card", LEAD)).toBeUndefined();
});
