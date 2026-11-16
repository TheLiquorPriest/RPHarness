// How much of the prompt's front was the same as the turn before, and which slice broke it (§4.8
// "The foundation for caching"), reported with each turn; the turn before is the one this turn
// follows, so a swipe is measured against its parent and not against the attempt it replaces.
import { expect, test } from "bun:test";
import { promptTurn } from "../../src/prompt/memory";
import { A_MAP, A_TEXT, type BuiltPrompt, LEAD, memoryHost, type MemoryHost, presetA, SCOPE, write } from "./support";

async function play(host: MemoryHost, turn: string, built: BuiltPrompt, lore: string[], parent: string | null | undefined) {
  host.set(built, lore);
  return (await promptTurn({ env: host.env, scope: { ...SCOPE, turn }, messages: built.messages, parent, by: LEAD })).located;
}

/** The length of the prompt's first `count` messages, one after another. */
function lengthOf(built: BuiltPrompt, count: number): number {
  return built.messages.slice(0, count).reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
}

test("the front held to where the prompt first differs, and the slice there broke it", async () => {
  const host = memoryHost();
  const first = presetA({ history: 4, lore: ["e-1"] });
  host.set(first, ["e-1"]);
  const opened = await promptTurn({ env: host.env, scope: { ...SCOPE, turn: "t-1" }, messages: first.messages, parent: null, by: LEAD });
  // With no turn before, nothing of it is known to be the same.
  expect(opened.located.front).toEqual({ length: 0, brokenBy: "Main Prompt" });
  await write(host, opened.prompt, A_MAP);

  const same = await play(host, "t-2", first, ["e-1"], "t-1");
  expect(same.front).toEqual({ length: lengthOf(first, first.messages.length) });

  // The history grew: the front holds through the messages that were there, to the first new one.
  const grown = presetA({ history: 6, lore: ["e-1"] });
  expect((await play(host, "t-3", grown, ["e-1"], "t-2")).front).toEqual({ length: lengthOf(grown, 8), brokenBy: "history[#4]" });

  // Other lore: the front breaks at the lore, after the main prompt.
  expect((await play(host, "t-4", presetA({ history: 6, lore: ["e-2"] }), ["e-2"], "t-3")).front).toEqual({ length: A_TEXT.main.length, brokenBy: "message[1]" });

  // A swipe of t-4 is measured against t-3, the turn it follows; the style's words changed, so the front breaks there.
  const swipe = presetA({ history: 6, lore: ["e-1"], text: { style: "Write in the present tense." } });
  expect((await play(host, "t-4b", swipe, ["e-1"], "t-3")).front).toEqual({ length: lengthOf(swipe, 3), brokenBy: "preset.style" });
});

test.skip("a chat keeps only its newest turns to be compared with; a turn it no longer keeps is not compared", async () => {
  // hardening
  const host = memoryHost();
  const built = presetA({ history: 2, lore: ["e-1"] });
  for (const turn of ["t-1", "t-2", "t-3", "t-4"]) await play(host, turn, built, ["e-1"], undefined);
  expect((await play(host, "t-5", built, ["e-1"], "t-4")).front).toEqual({ length: lengthOf(built, built.messages.length) });
  // Three are kept (t-3, t-4, t-5): t-1 is gone, so a turn that follows it is measured as one with none before it.
  expect((await play(host, "t-1b", built, ["e-1"], "t-1")).front).toEqual({ length: 0, brokenBy: "Main Prompt" });
  // No turn named: the chat's newest kept turn.
  expect((await play(host, "t-6", built, ["e-1"], undefined)).front.brokenBy).toBeUndefined();
});
