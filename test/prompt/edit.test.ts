// The owner's edits to the prompt map (§4.8 L369): made by RPH on the map as found in a turn's prompt
// and kept with the preset. Invented.
import { expect, test } from "bun:test";
import { promptMapApi } from "../../src/prompt/edit";
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
