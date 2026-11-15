// The turn folder's views (§5.3), built from the map with the same names as the `prompt` tool: the
// whole prompt with roles and markers, the history it holds and what it left out, every instruction
// slice in order, the persona, the character. The part's header says which files are written. RPH
// is their one writer: before a map is learned, the kinds the chat application's blocks say give the
// persona, the character and the preset's guidance.
import { expect, test } from "bun:test";
import type { FileOp, FilesPort } from "../../src/contract";
import { promptViews, writeViews } from "../../src/prompt/views";
import { A_MAP, A_TEXT, LEAD, markedA, memoryHost, presetA, SCOPE, shippedParts, turnOf, write } from "./support";

async function mapped() {
  const host = memoryHost();
  await write(host, await turnOf(host, presetA({ history: 2, lore: ["e-1"] }), ["e-1"]), A_MAP);
  return { host, prompt: await turnOf(host, presetA({ history: 4, lore: ["e-1"] }), ["e-1"]) };
}

test("with no map: persona.md, character.md and preset-guidance.md come from the host's kinds, the last holding every instruction block in order under its block name; once a map is learned: the same files from the map's slices, with the same text", async () => {
  const host = memoryHost();
  const views = async (history: number) => {
    const prompt = await turnOf(host, markedA(presetA({ history, lore: ["e-1"] })), ["e-1"]);
    return { prompt, byFile: Object.fromEntries((await promptViews(prompt, shippedParts(), LEAD)).map((view) => [view.file, view.text])) };
  };
  const first = await views(2);
  expect(first.prompt.mapped).toBe(false);
  expect(Object.keys(first.byFile)).toEqual(["assembled-preset-prompt.md", "visible-chat-history.md", "preset-guidance.md", "persona.md", "character.md"]);
  expect(first.byFile["preset-guidance.md"]).toBe(`[Main Prompt]\n${A_TEXT.main}\n\n[Post-History Instructions]\n${A_TEXT.post}`);
  expect(first.byFile["persona.md"]).toBe(`[Persona]\n${A_TEXT.persona}`);
  expect(first.byFile["character.md"]).toBe(`[Character Description]\n${A_TEXT.card}`);

  expect((await write(host, first.prompt, A_MAP)).error).toBe(false);
  const later = await views(4);
  expect(later.prompt.mapped).toBe(true);
  expect(later.byFile["preset-guidance.md"]).toBe(`[preset.main]\n${A_TEXT.main}\n\n[preset.after]\n${A_TEXT.post}`);
  expect(later.byFile["persona.md"]).toBe(`[persona]\n${A_TEXT.persona}`);
  expect(later.byFile["character.md"]).toBe(`[card]\n${A_TEXT.card}`);
});

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
  await writeViews(files, SCOPE, "turns/t-1/", promptViews(prompt, shippedParts(), LEAD), host.env.log).done;
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

test("each stretch the host says it left out is told in the prompt map's view_left_out line, with whether the story's record covers it; with the line edited, the edited words show", async () => {
  const { prompt } = await mapped();
  const left = [{ from: 0, to: 40, covered: true }, { from: 40, to: 60, covered: false }, { from: 70, to: 71 }];
  const told = async (edits?: Record<string, string>) => (await promptViews(prompt, shippedParts(edits), LEAD, left)).find((view) => view.file === "visible-chat-history.md")?.text.split("\n\n").slice(-3);
  expect(await told()).toEqual([
    "Messages #0 to #39 of the chat are not in this prompt; the story's record covers them. chat_read reads them.",
    "Messages #40 to #59 of the chat are not in this prompt. chat_read reads them.",
    "Messages #70 to #70 of the chat are not in this prompt. chat_read reads them.",
  ]);
  const shipped = await Bun.file(`${import.meta.dir}/../../guidance/.prompts/prompt-map.md`).text();
  const edited = shipped.replace(/^view_left_out: .*$/m, "view_left_out: Chat messages {{from}} to {{last}} are missing{{#covered}} (in the record){{/covered}}.");
  expect(edited).not.toBe(shipped);
  expect(await told({ "prompt-map": edited })).toEqual(["Chat messages 0 to 39 are missing (in the record).", "Chat messages 40 to 59 are missing.", "Chat messages 70 to 70 are missing."]);
  // With the line taken out, a stretch left out is not told at all.
  const without = shipped.replace(/^view_left_out: .*\n/m, "");
  expect((await told({ "prompt-map": without }))?.some((text) => text.includes("not in this prompt"))).toBe(false);
});
