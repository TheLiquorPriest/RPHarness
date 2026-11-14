// The turn folder's views (§5.3), built from the map with the same names as the `prompt` tool: the
// whole prompt with roles and markers, the history it holds and what it left out, every instruction
// slice in order, the persona, the character. The part's header says which files are written.
import { expect, test } from "bun:test";
import type { FileOp, FilesPort } from "../../src/contract";
import { promptViews, writeViews } from "../../src/prompt/views";
import { A_MAP, A_TEXT, LEAD, memoryHost, presetA, SCOPE, shippedParts, turnOf, write } from "./support";

async function mapped() {
  const host = memoryHost();
  await write(host, await turnOf(host, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]), A_MAP);
  return { host, prompt: await turnOf(host, presetA({ history: 4, lore: ["e-1"] }), ["e-1"]) };
}

test("with a map: every instruction slice in order under its marker, the persona, the character, the history and what the window left out, and the whole prompt", async () => {
  const { prompt } = await mapped();
  const views = await promptViews(prompt, shippedParts(), LEAD, [{ from: 0, to: 120, covered: true }]);
  const byFile = Object.fromEntries(views.map((view) => [view.file, view.text]));
  expect(Object.keys(byFile)).toEqual(["assembled-preset-prompt.md", "visible-chat-history.md", "preset-guidance.md", "persona.md", "character.md"]);
  expect(byFile["preset-guidance.md"]).toBe(`[preset.main]\n${A_TEXT.main}\n\n[preset.after]\n${A_TEXT.post}`);
  expect(byFile["persona.md"]).toBe(`[persona]\n${A_TEXT.persona}`);
  expect(byFile["character.md"]).toBe(`[card]\n${A_TEXT.card}`);
  expect(byFile["visible-chat-history.md"]?.split("\n\n")).toEqual([
    "#0 (m0) Tam, user\nTam: I ask about the river, time 0.",
    "#1 (m1) Wren, assistant\nWren: The river is high tonight, answer 1.",
    "#2 (m2) Tam, user\nTam: I ask about the river, time 2.",
    "#3 (m3) Wren, assistant\nWren: The river is high tonight, answer 3.",
    "Messages #0 to #119 of the chat are not in this prompt; the story's record covers them. chat_read reads them.",
  ]);
  const whole = byFile["assembled-preset-prompt.md"] ?? "";
  expect(whole.startsWith(`message[0] - system, ${A_TEXT.main.length} characters\n\n[preset.main]\n${A_TEXT.main}\n\nmessage[1] - system`)).toBe(true);
  expect(whole).toContain(`message[2] - system, ${A_TEXT.persona.length + 2 + A_TEXT.card.length} characters\n\n[persona]\n${A_TEXT.persona}\n\n[card]\n${A_TEXT.card}`);
  for (const text of Object.values(A_TEXT)) expect(whole).toContain(text);
});

test("with no map, a view whose part the prompt does not have is not written; the part's list decides which files there are", async () => {
  const host = memoryHost();
  const prompt = await turnOf(host, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]);
  expect((await promptViews(prompt, shippedParts(), LEAD)).map((view) => view.file)).toEqual(["assembled-preset-prompt.md", "visible-chat-history.md"]);
  const shipped = await Bun.file(`${import.meta.dir}/../../guidance/.prompts/prompt-map.md`).text();
  const edited = shipped.replace('  assembled-preset-prompt.md: "*"\n', "").replace("  visible-chat-history.md: history\n", "  history.md: history[-1:]\n");
  expect((await promptViews(prompt, shippedParts({ "prompt-map": edited }), LEAD)).map((view) => [view.file, view.text])).toEqual([["history.md", "#1 (m1) Wren, assistant\nWren: The river is high tonight, answer 1."]]);
});

test("the views are written in the turn's folder by the harness, and one the files refuse is logged", async () => {
  const { host, prompt } = await mapped();
  const writes: [string, FileOp, string][] = [];
  const files = {
    write: async (_scope: unknown, path: string, op: FileOp, by: string) => {
      writes.push([path, op, by]);
      return path.endsWith("persona.md") ? { status: "refused" as const, path, reason: "generated" as const } : { status: "written" as const, path, kind: "generated" as const, bytes: 0, hash: null, before: null };
    },
  } as unknown as FilesPort;
  await writeViews(files, SCOPE, "turns/t-1/", await promptViews(prompt, shippedParts(), LEAD), host.env.log);
  expect(writes.map(([path, , by]) => [path, by])).toEqual([
    ["turns/t-1/assembled-preset-prompt.md", "harness"],
    ["turns/t-1/visible-chat-history.md", "harness"],
    ["turns/t-1/preset-guidance.md", "harness"],
    ["turns/t-1/persona.md", "harness"],
    ["turns/t-1/character.md", "harness"],
  ]);
  expect(writes[3]?.[1]).toEqual({ op: "write", text: `[persona]\n${A_TEXT.persona}\n` });
  expect(host.logged).toContain("A view of the prompt could not be written in the turn's folder.");
});
