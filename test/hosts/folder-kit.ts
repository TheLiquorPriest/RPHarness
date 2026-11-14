// How the folder host takes the kit's seed: the seed laid out as the folder host's directory, plus
// what the kit cannot seed for every host (facts, a tools manifest and what runs its tools), and
// the factory the kit calls. Everything here is invented.

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue, ToolResult } from "../../src/contract/index";
import type { FolderHost, GivenPrompt, ToolHandler } from "../../src/hosts/folder/index";
import { createFolderHost } from "../../src/hosts/folder/index";
import type { KitFactory, KitSeed } from "../../src/testing/kit/index";

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The folder of a seeded level. */
export function levelDir(place: string, seed: KitSeed, level: KitSeed["files"][number]["level"]): string {
  const files = join(place, "files");
  if (level === "shipped") return join(files, "defaults");
  if (level === "global") return files;
  if (level === "character") return join(files, "chats", seed.character);
  return join(files, "chats", seed.character, seed.scope.chat);
}

/** The facts the folder host declares in the kit's run. */
export const KIT_FACTS = {
  defs: [
    { name: "stage.unperceived", counts: "Characters on stage this turn with no perception recorded for it.", by: ["principal", "supporting", "extra"] },
    { name: "threads.open", counts: "Story threads the record holds open." },
    { name: "history.leaving.uncovered", counts: "Messages about to leave the prompt that the record does not cover.", fields: ["range"] },
  ],
  values: {
    "kit-chat": {
      "stage.unperceived": { count: 2, names: ["Wren Alder", "Tamsin"], by: { principal: 1, supporting: 1 }, namesBy: { principal: ["Wren Alder"], supporting: ["Tamsin"] } },
      "history.leaving.uncovered": { count: 3, fields: { range: { from: 12, to: 15 } } },
    },
  },
};

/** The manifest the folder host lists its tools from in the kit's run. */
export const KIT_MANIFEST = {
  tools: [
    { name: "kit_tally", family: "sums", tier: "read", description: "Adds up a list of numbers.", parameters: { type: "object", properties: { numbers: { type: "array", items: { type: "number" } } }, required: ["numbers"] } },
    { name: "kit_words", family: "sums", tier: "read", descriptionFile: "@global/.tools/kit-words.md", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "kit_stamp", family: "marks", tier: "write", lane: "engine", description: "Records a stamp under a name.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "kit_shell", family: "commands", tier: "external", description: "Runs a command.", parameters: { type: "object" }, command: ["true"] },
    { name: "kit_unrun", family: "sums", tier: "read", description: "Nothing runs this one.", parameters: { type: "object" } },
  ],
};

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** What runs the manifest's tools. */
export const KIT_HANDLERS: Record<string, ToolHandler> = {
  kit_tally: async (args: JsonValue) => {
    const numbers = typeof args === "object" && args !== null && !Array.isArray(args) && Array.isArray(args.numbers) ? args.numbers : [];
    return text(String(numbers.reduce((sum: number, n) => sum + (typeof n === "number" ? n : 0), 0)));
  },
  kit_words: async (args: JsonValue) => {
    const value = typeof args === "object" && args !== null && !Array.isArray(args) && typeof args.text === "string" ? args.text : "";
    return text(String(value.split(/\s+/).filter((w) => w !== "").length));
  },
  kit_stamp: async (args: JsonValue) => text(`stamped ${JSON.stringify(args)}`),
};

/** Lays the seed out as the folder host's directory. */
export async function layFolderSeed(seed: KitSeed, place: string): Promise<void> {
  for (const f of seed.files) await put(join(levelDir(place, seed, f.level), f.path), f.text);
  await put(join(place, "files", ".tools", "kit-words.md"), "Counts the words of a text.\n");
  const records = join(place, "host", "chats", seed.scope.chat);
  await put(join(records, "chat.json"), json({ character: seed.character, preset: seed.preset, hiddenReadable: seed.hiddenReadable, ranges: seed.ranges }));
  await put(join(records, "messages.jsonl"), seed.messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  for (const entry of seed.lore) await put(join(place, "host", "lore", `${entry.id}.json`), json(entry));
  for (const p of seed.prompts) {
    const given: GivenPrompt = { messages: p.messages, blocks: p.blocks, blocksFrom: "breakdown", activated: p.activated };
    await put(join(records, "turns", p.turn, "prompt.json"), json(given));
  }
  await put(join(place, "host", "facts.json"), json(KIT_FACTS));
  await put(join(place, "host", "tools.json"), json(KIT_MANIFEST));
}

/** Makes a folder host over `place`, laying the seed there first when the place is empty. */
export async function makeFolderHost(seed: KitSeed, place: string): Promise<FolderHost> {
  const laid = await access(join(place, "files")).then(
    () => true,
    () => false,
  );
  if (!laid) await layFolderSeed(seed, place);
  return createFolderHost({ dir: place, user: seed.scope.user, tools: KIT_HANDLERS });
}

/** The kit's factory for the folder host. */
export const folderKitFactory: KitFactory = async (seed, place) => {
  const env = await makeFolderHost(seed, place);
  return { env, close: () => env.close() };
};
