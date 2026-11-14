// One resolver for names (§4.8 "Tools and names"): the same name gives the same text to the `prompt`
// tool, to what `delegate` attaches, and to what a definition's `given:` names; a name the prompt
// does not have gives nothing, and the attachment says it was not found.
import { expect, test } from "bun:test";
import { attach } from "../../src/agents/attachments";
import type { AgentRef, AttachmentRef, Environment } from "../../src/contract";
import { findName } from "../../src/prompt/names";
import { promptSlice } from "../../src/prompt/tools";
import { A_TEXT, ENTRIES, LEAD, memoryHost, presetA, SCOPE, shippedParts, texts, turnOf } from "./support";

async function turn(history = 6, lore = ["e-1", "e-4"]) {
  const host = memoryHost();
  return { host, prompt: await turnOf(host, presetA({ history, lore }), lore) };
}

test("history by message: the last few in the prompt, a stretch of the chat, one message, all of it", async () => {
  const { prompt } = await turn();
  const line = (index: number) => (index % 2 === 0 ? `Tam: I ask about the river, time ${index}.` : `Wren: The river is high tonight, answer ${index}.`);
  expect(texts(await findName(prompt, "history[-3:]", LEAD))).toEqual([line(3), line(4), line(5)]);
  expect(texts(await findName(prompt, "history[#1..#2]", LEAD))).toEqual([line(1), line(2)]);
  expect(texts(await findName(prompt, "history[#4]", LEAD))).toEqual([line(4)]);
  expect(texts(await findName(prompt, "history", LEAD))).toHaveLength(6);
  expect(await findName(prompt, "history[#40..#50]", LEAD)).toBeUndefined();
});

test("lore by entry: only an entry that activated, and only as the reader may read it", async () => {
  const { prompt } = await turn();
  expect(texts(await findName(prompt, "lore[e-1]", LEAD))).toEqual([ENTRIES["e-1"]?.text ?? ""]);
  expect(await findName(prompt, "lore[e-2]", LEAD)).toBeUndefined();
  // The toll is known only to Wren: an agent that plays Tam is given nothing of it, one that plays Wren is given it.
  const tam: AgentRef = { id: "tam-1", definition: "character", plays: "Tam" };
  const wren: AgentRef = { id: "wren-1", definition: "character", plays: "Wren" };
  expect(await findName(prompt, "lore[e-4]", tam)).toBeUndefined();
  expect(texts(await findName(prompt, "lore[e-4]", wren))).toEqual([ENTRIES["e-4"]?.text ?? ""]);
  expect(texts(await findName(prompt, "kind(lore)", tam))).toEqual([ENTRIES["e-1"]?.text ?? ""]);
});

test("a marker, a place and the whole prompt: each exactly as it stands", async () => {
  const { prompt } = await turn(2, ["e-1"]);
  expect(texts(await findName(prompt, "character description", LEAD))).toEqual([A_TEXT.card]);
  expect(texts(await findName(prompt, "message[2]", LEAD))).toEqual([`${A_TEXT.persona}\n\n${A_TEXT.card}`]);
  const whole = await findName(prompt, "*", LEAD);
  expect(whole?.filter((item) => item.type === "message")).toHaveLength(prompt.texts.length);
  expect(texts(whole?.filter((item) => item.type === "slice"))).toEqual(prompt.slices.map((slice) => prompt.text(slice)));
  expect(await findName(prompt, "kind(style)", LEAD)).toBeUndefined();
  expect(await findName(prompt, "kind(nonsense)", LEAD)).toBeUndefined();
});

test("as attachments: what delegate and a definition name is found the same way, and a name the prompt does not have attaches nothing and is listed as not found", async () => {
  const { host, prompt } = await turn(4, ["e-1"]);
  const told: AttachmentRef[][] = [];
  const env = {
    ...host.env,
    files: {} as Environment["files"],
    chat: {} as Environment["chat"],
    events: { attachments: async (_scope: unknown, _agent: unknown, refs: AttachmentRef[]) => (told.push(refs), []) } as unknown as Environment["events"],
  };
  const gm: AgentRef = { id: "gm-1", definition: "gm", parent: "lead" };
  const given = await attach({ env, scope: SCOPE, lines: undefined, most: 50, slice: promptSlice(async () => prompt, shippedParts()) }, gm, [
    { ref: "prompt:Style Guide", from: "definition" },
    { ref: "prompt:history[-1:]", from: "delegate" },
    { ref: "prompt:persona.card", from: "delegate" },
  ]);
  expect(given.blocks).toEqual([
    { name: "prompt:Style Guide", text: `[Style Guide]\n${A_TEXT.style}` },
    { name: "prompt:history[-1:]", text: "#3 (m3) Wren, assistant\nWren: The river is high tonight, answer 3." },
  ]);
  expect(given.missing).toEqual(["prompt:persona.card"]);
  expect(told[0]?.map((ref) => [ref.ref, ref.own])).toEqual([
    ["prompt:Style Guide", true],
    ["prompt:history[-1:]", true],
    ["prompt:persona.card", true],
  ]);
});
