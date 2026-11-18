// The owner's edits to the prompt map (§4.8 L369): made by RPH on the map as found in a turn's prompt
// and kept with the preset. Invented.
import { expect, test } from "bun:test";
import { between, keptPrompt, promptMapApi } from "../../src/prompt/edit";
import { promptTurn } from "../../src/prompt/memory";
import { A_MAP, A_TEXT, LEAD, memoryHost, PRESET_A, presetA, SCOPE, write } from "./support";

test("show gives the map's slices with their text; a rename, a merge and a split are saved marked edited, and found again", async () => {
  const host = memoryHost();
  const built = presetA({ history: 2, lore: ["e-1"] });
  host.set(built, ["e-1"]);
  const { prompt } = await promptTurn({ env: host.env, scope: SCOPE, messages: built.messages, parent: null, by: LEAD });
  await write(host, prompt, A_MAP);
  const api = promptMapApi(host.env);

  const shown = await api.show(SCOPE);
  expect(shown?.slices.find((s) => s.marker === "card")).toMatchObject({ text: A_TEXT.card, found: "signature" });

  expect(await api.edit(SCOPE, { edit: "rename", marker: "card", to: "card.wren" }, LEAD)).toMatchObject({ status: "saved" });
  expect(await api.edit(SCOPE, { edit: "merge", markers: ["persona", "card.wren"], as: "people" }, LEAD)).toMatchObject({ status: "saved" });
  expect(await api.edit(SCOPE, { edit: "split", marker: "preset.main", at: "Keep to what", second: "preset.sight" }, LEAD)).toMatchObject({ status: "saved" });
  expect(await api.edit(SCOPE, { edit: "line", marker: "ghost", line: "x" }, LEAD)).toMatchObject({ status: "refused" });

  const saved = host.maps.get(PRESET_A.id);
  expect(saved?.slices.filter((s) => s.edited === true).map((s) => s.marker)).toEqual(["preset.main", "preset.sight", "people"]);
  const after = await api.show(SCOPE);
  expect(after?.slices.find((s) => s.marker === "people")?.text).toContain(A_TEXT.card);
  expect(after?.slices.find((s) => s.marker === "preset.sight")?.text).toBe("Keep to what the characters can see and hear.");
});

test("a merge joins slices that sit side by side and is refused over a part of the prompt between them; its line is both lines, and a split's second part says whose part it is", async () => {
  const host = memoryHost();
  const built = presetA({ history: 2, lore: ["e-1"] });
  host.set(built, ["e-1"]);
  const { prompt } = await promptTurn({ env: host.env, scope: SCOPE, messages: built.messages, parent: null, by: LEAD });
  await write(host, prompt, A_MAP);
  const api = promptMapApi(host.env);

  // The persona and the card stand between the main prompt and the style guide.
  expect(await api.edit(SCOPE, { edit: "merge", markers: ["preset.main", "preset.style"], as: "rules" }, LEAD)).toMatchObject({ status: "refused" });
  const kept = await keptPrompt(host.env, SCOPE);
  if (kept === undefined) throw new Error("no kept prompt");
  const stretches = (marker: string) => ({ marker, spans: kept.prompt.slices.find((s) => s.from === "map" && s.marker === marker)?.spans ?? [] });
  expect(between(kept.prompt, [stretches("preset.main"), stretches("preset.style")])).toMatchObject({ marker: "preset.main", other: "preset.style", between: expect.stringMatching(/\S/) });
  expect(between(kept.prompt, [stretches("persona"), stretches("card")])).toBeUndefined();
  expect(host.maps.get(PRESET_A.id)?.slices.some((s) => s.edited === true)).toBe(false);

  expect(await api.edit(SCOPE, { edit: "merge", markers: ["persona", "card"], as: "people" }, LEAD)).toMatchObject({ status: "saved" });
  expect(host.maps.get(PRESET_A.id)?.slices.find((s) => s.marker === "people")?.line).toBe("Who the player's character is. Who Wren is.");

  expect(await api.edit(SCOPE, { edit: "split", marker: "preset.main", at: "Keep to what", second: "preset.sight" }, LEAD)).toMatchObject({ status: "saved" });
  const slices = host.maps.get(PRESET_A.id)?.slices;
  // The second part has a line of its own (this host holds no guidance, so no words: the line is the file's, `edit_second_part`), never the first part's.
  expect(slices?.find((s) => s.marker === "preset.main")?.line).toBe("How the narrator tells the tale.");
  expect(slices?.find((s) => s.marker === "preset.sight")?.line).not.toBe("How the narrator tells the tale.");
});

test("a renamed slice is named by its new marker in what the chat's turns kept, and the turn after is not told it is gone", async () => {
  const host = memoryHost();
  const built = presetA({ history: 2, lore: ["e-1"] });
  host.set(built, ["e-1"]);
  const { prompt } = await promptTurn({ env: host.env, scope: SCOPE, messages: built.messages, parent: null, by: LEAD });
  await write(host, prompt, A_MAP);
  const api = promptMapApi(host.env);
  // The first turn was played before the map existed; the second, on the same prompt, with it; the third has a changed style guide, which broke its front and is told of.
  expect((await api.show(SCOPE))?.notices).toContainEqual({ kind: "unmapped" });
  await promptTurn({ env: host.env, scope: { ...SCOPE, turn: "t-2" }, messages: built.messages, parent: SCOPE.turn ?? null, by: LEAD });
  const changed = presetA({ history: 2, lore: ["e-1"], text: { style: "Write in the present tense. No more than two paragraphs." } });
  host.set(changed, ["e-1"]);
  const third = { ...SCOPE, turn: "t-3" };
  await promptTurn({ env: host.env, scope: third, messages: changed.messages, parent: "t-2", by: LEAD });
  const before = await api.show(third);
  expect(before?.notices).toContainEqual({ kind: "changed", marker: "preset.style" });
  expect(before?.front.brokenBy).toBe("preset.style");

  expect(await api.edit(third, { edit: "rename", marker: "preset.style", to: "preset.house" }, LEAD)).toMatchObject({ status: "saved" });
  const after = await api.show(third);
  expect(after?.slices.map((s) => s.marker)).toContain("preset.house");
  expect(after?.front.brokenBy).toBe("preset.house");
  expect(after?.notices).toContainEqual({ kind: "changed", marker: "preset.house" });
  expect(host.located.at(-1)?.front.brokenBy).toBe("preset.house");

  // The fourth turn, on the same prompt, is compared with what the third kept, under the new name.
  await promptTurn({ env: host.env, scope: { ...SCOPE, turn: "t-4" }, messages: changed.messages, parent: "t-3", by: LEAD });
  expect(host.located.at(-1)?.notices.filter((n) => n.kind === "gone" || n.kind === "changed")).toEqual([]);
});
