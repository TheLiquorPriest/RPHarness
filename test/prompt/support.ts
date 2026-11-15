// Invented prompts of two presets, laid out as a host would lay them out, and a host's prompt and
// lore ports in memory. Preset A's chat application names its blocks; preset B's names none, and
// puts its instructions and its style rules in one message. Everything here is invented.
import type { ActivatedLore, AgentRef, Environment, FileText, JsonObject, JsonValue, LocatedSlices, LoreEntry, PresetRef, PromptMap, PromptMessage, PromptPort, PromptRole, RawBlock, RawLayout, RawPart, Scope, SliceKind, ToolCtx } from "../../src/contract";
import type { Guidance, PartKind, PromptPart } from "../../src/files/api";
import { parsePart } from "../../src/files/parts";
import { SHIPPED_GUIDANCE } from "../../src/harness/shipped";
import type { Item } from "../../src/prompt/names";
import { TurnPrompt } from "../../src/prompt/prompt";
import { textHash } from "../../src/prompt/text";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import { promptMapWrite } from "../../src/prompt/tools";
import { memoryJobs } from "../../src/testing/rig";
import type { ToolText } from "../../src/tools/kit";

export const SCOPE: Scope = { user: "u-1", chat: "c-1", session: "s-1", turn: "t-1" };
export const LEAD: AgentRef = { id: "lead", definition: "lead" };

/** A call's context, as `agent` makes it. */
export function ctxOf(agent: AgentRef = LEAD): ToolCtx {
  return { scope: SCOPE, agent, run: "run-1", callId: "call-1", signal: new AbortController().signal, onUpdate: () => {} };
}

/** One of RPH's own shipped files, parsed as the loader parses it; `text` in place of the file's own, to see what an edit does. */
async function shippedPart(kind: PartKind, name: string, text?: string): Promise<PromptPart | undefined> {
  const path = `.${kind}/${name}.md`;
  const body = text ?? (await Bun.file(`${SHIPPED_GUIDANCE}${path}`).text());
  const file: FileText = { status: "read", path, level: "shipped", kind: "generated", text: body, start: 1, end: body.split("\n").length, lines: body.split("\n").length, bytes: body.length, hash: textHash(body), modified: 0 };
  const parsed = parsePart(file, name, kind, []);
  if (parsed.problems.length > 0) throw new Error(`${path}: ${parsed.problems.map((problem) => problem.message).join(" ")}`);
  return parsed.part;
}

/** The shipped prompt parts, as the guidance gives them; `edits` in place of a part's file. */
export function shippedParts(edits: Readonly<Record<string, string>> = {}): Pick<Guidance, "part"> {
  return { part: (name) => shippedPart("prompts", name, edits[name]) };
}

/** A tool's shipped file as the harness reads it: its description and its arguments'. */
export async function shippedTool(name: string): Promise<ToolText> {
  const part = await shippedPart("tools", name);
  if (part?.format !== "template") throw new Error(`.tools/${name}.md is not a template`);
  const given = part.header["arguments"];
  const args: Record<string, string> = {};
  if (typeof given === "object" && given !== null && !Array.isArray(given)) for (const [key, text] of Object.entries(given)) if (typeof text === "string") args[key] = text;
  return { description: part.render().text.trimEnd(), arguments: args };
}

/** One message as the interceptor saw it, before neighbours were joined. */
export interface PartSpec {
  text: string;
  kind: RawPart["kind"];
  role?: PromptRole;
  /** For history: the chat message's place on the path; its id is `m<index>`. */
  index?: number;
  /** The speaker's name, for history. */
  name?: string;
}

/** A message of the prompt: one part, or several the chat application joined with a blank line. */
export type MessageSpec = { role: PromptRole; parts: PartSpec[] };

export interface BuiltPrompt {
  messages: PromptMessage[];
  layout: RawLayout;
}

/** The prompt and its layout, as a host lays it out: each block found by its text in the parts that are neither history nor lore. */
export function build(spec: readonly MessageSpec[], blocks: readonly RawBlock[], preset: PresetRef | null, from: RawLayout["blocksFrom"] = blocks.length > 0 ? "breakdown" : null): BuiltPrompt {
  const messages: PromptMessage[] = [];
  const raws: RawLayout["messages"] = [];
  for (const message of spec) {
    let text = "";
    const parts: RawPart[] = [];
    for (const [at, part] of message.parts.entries()) {
      if (at > 0) text += "\n\n";
      const start = text.length;
      text += part.text;
      const found: RawPart["blocks"] = [];
      if (part.kind === "other")
        blocks.forEach((block, b) => {
          const where = part.text.indexOf(block.text);
          if (block.text !== "" && where >= 0) found.push({ block: b, start: start + where, end: start + where + block.text.length });
        });
      parts.push({ start, end: text.length, role: part.role ?? message.role, hash: textHash(part.text), kind: part.kind, ...(part.index !== undefined ? { source: { id: `m${part.index}`, index: part.index } } : {}), blocks: found });
    }
    const name = message.parts.find((part) => part.name !== undefined)?.name;
    messages.push({ role: message.role, content: text, ...(name !== undefined ? { name } : {}) });
    raws.push({ role: message.role, length: text.length, hash: textHash(text), parts });
  }
  return { messages, layout: { messages: raws, complete: true, blocks: [...blocks], blocksFrom: blocks.length > 0 ? from : null, preset } };
}

// ---------------------------------------------------------------- the chat and its lore

/** The chat's messages: speakers taking turns, each line its own. */
export function chatLine(index: number): PartSpec {
  const player = index % 2 === 0;
  return { text: player ? `Tam: I ask about the river, time ${index}.` : `Wren: The river is high tonight, answer ${index}.`, kind: "history", role: player ? "user" : "assistant", index, name: player ? "Tam" : "Wren" };
}

export const ENTRIES: Record<string, LoreEntry> = {
  "e-1": { id: "e-1", source: "River Book", title: "The Gilded Hart", keys: ["inn"], text: "[The Gilded Hart] An inn on the river road, its sign a golden deer." },
  "e-2": { id: "e-2", source: "River Book", title: "The Ferry", keys: ["ferry"], text: "[The Ferry] A flat barge on a rope, worked by hand." },
  "e-3": { id: "e-3", source: "River Book", title: "Old Weir", keys: ["weir"], text: "[Old Weir] A broken dam upstream, where smugglers meet." },
  "e-4": { id: "e-4", source: "River Book", title: "The Toll", keys: ["toll"], text: "[The Toll] Two coppers a head, paid at the near bank.", knowing: { by: "characters", names: ["Wren"] } },
};

/** The lore part for the entries that activated, in that order. */
export function lorePart(ids: readonly string[]): PartSpec {
  return { text: ids.map((id) => ENTRIES[id]?.text ?? "").join("\n"), kind: "lore", role: "system" };
}

// ---------------------------------------------------------------- preset A: named blocks

export const PRESET_A: PresetRef = { id: "preset-a", name: "River Tales", revision: "1" };

export const A_TEXT = {
  main: "You are the narrator of a slow fantasy tale on a river. Keep to what the characters can see and hear.",
  persona: "Tam is the player's character: a travelling tinker with a cart and a lame mule.",
  card: "Wren is a ferrywoman of forty, patient, sharp with fools, who knows every family on both banks.",
  style: "Write in the past tense and the third person. No more than three paragraphs. Never speak for Tam.",
  post: "Stay in the scene. End on something Tam can answer.",
};

/** Preset A's blocks, by the part of the prompt each is. */
export const A_BLOCKS: Record<keyof typeof A_TEXT, Omit<RawBlock, "text">> = {
  main: { name: "Main Prompt", type: "main", role: "system" },
  persona: { name: "Persona", type: "persona", role: "system" },
  card: { name: "Character Description", type: "character", role: "system" },
  style: { name: "Style Guide", type: "custom", role: "system" },
  post: { name: "Post-History Instructions", type: "post_history", role: "system" },
};

export interface TurnShape<T> {
  /** How many chat messages are in the prompt, from #0. */
  history: number;
  lore: string[];
  /** Words in place of the shipped ones. */
  text?: Partial<T>;
}

type AKey = keyof typeof A_TEXT;

/**
 * Preset A's prompt: the main prompt, the lore, the persona and card joined in one message, the
 * style, the history, and the instruction after it; in `order`, with `extra` text after a part.
 * Its breakdown names each block with its text in this prompt, as the breakdown of the turn before
 * does when nothing changed since.
 */
export function presetA(shape: TurnShape<typeof A_TEXT>, order: AKey[] = ["main", "persona", "card", "style", "post"], extra?: { after: AKey; text: string }): BuiltPrompt {
  const text = { ...A_TEXT, ...shape.text };
  const spec: MessageSpec[] = [];
  const front = order.filter((key) => key !== "post");
  for (const [at, key] of front.entries()) {
    if (key === "card" && front[at - 1] === "persona") continue;
    const joined = key === "persona" && front[at + 1] === "card";
    spec.push({ role: "system", parts: joined ? [{ text: text.persona, kind: "other" }, { text: text.card, kind: "other" }] : [{ text: text[key], kind: "other" }] });
    if (key === "main") spec.push({ role: "system", parts: [lorePart(shape.lore)] });
    if (extra !== undefined && (extra.after === key || (joined && extra.after === "card"))) spec.push({ role: "system", parts: [{ text: extra.text, kind: "other" }] });
  }
  for (let index = 0; index < shape.history; index++) {
    const line = chatLine(index);
    spec.push({ role: line.role ?? "user", parts: [line] });
  }
  if (order.includes("post")) spec.push({ role: "system", parts: [{ text: text.post, kind: "other" }] });
  return build(
    spec,
    order.map((key) => ({ ...A_BLOCKS[key], text: text[key] })),
    PRESET_A,
  );
}

/** The kinds Lumiverse's own blocks say for preset A's: the persona's slot, the card's, and the preset's own text; the style guide left unmarked. */
const A_KINDS: Partial<Record<string, SliceKind>> = { "Main Prompt": "instructions", Persona: "persona", "Character Description": "character", "Post-History Instructions": "instructions" };

/** A prompt whose blocks carry the kinds the chat application's own blocks say (`RawBlock.kind`). */
export function markedA(built: BuiltPrompt): BuiltPrompt {
  return { ...built, layout: { ...built.layout, blocks: built.layout.blocks.map((block) => ({ ...block, ...(A_KINDS[block.name] !== undefined ? { kind: A_KINDS[block.name] } : {}) })) } };
}

// ---------------------------------------------------------------- preset B: no blocks

export const PRESET_B: PresetRef = { id: "preset-b", name: "Fog City", revision: "7" };

export const B_TEXT = {
  rules: "You run a mystery in a city of fog. Every clue must be found in play; never hand the player an answer.",
  style: "Style: short sentences, present tense, the senses first. One reply is one beat.",
  persona: "The player is Ash, a constable thrown off the force for asking the wrong questions.",
  card: "Marrow is a fence on Lantern Street who trades in favours and keeps a ledger of debts.",
  note: "[Note: the fog is thick tonight; lamps carry no further than a few steps.]",
};

/** Preset B's prompt: rules and style in one message, the persona, the card, the lore, the history with a note two messages from its end. */
export function presetB(shape: TurnShape<typeof B_TEXT>): BuiltPrompt {
  const text = { ...B_TEXT, ...shape.text };
  const spec: MessageSpec[] = [
    { role: "system", parts: [{ text: `${text.rules}\n\n${text.style}`, kind: "other" }] },
    { role: "system", parts: [{ text: text.persona, kind: "other" }] },
    { role: "system", parts: [{ text: text.card, kind: "other" }] },
    { role: "system", parts: [lorePart(shape.lore)] },
  ];
  for (let index = 0; index < shape.history; index++) {
    if (index === shape.history - 2) spec.push({ role: "system", parts: [{ text: text.note, kind: "other" }] });
    const line = chatLine(index);
    spec.push({ role: line.role ?? "user", parts: [line] });
  }
  return build(spec, [], PRESET_B);
}

// ---------------------------------------------------------------- a host in memory

export interface MemoryHost {
  env: Pick<Environment, "prompt" | "lore" | "log" | "store">;
  /** The layout and the lore of the prompt the next turn reads. */
  set(prompt: BuiltPrompt, activated: readonly string[]): void;
  /** Maps as saved, by preset id; what each turn was found to hold; the log. */
  maps: Map<string, PromptMap>;
  located: LocatedSlices[];
  logged: string[];
}

/** A host's prompt and lore ports over the invented chat. Lore keeps from a reader that plays a character what the character may not know. */
export function memoryHost(): MemoryHost {
  let layout: RawLayout | undefined;
  let activated: ActivatedLore[] = [];
  const maps = new Map<string, PromptMap>();
  const located: LocatedSlices[] = [];
  const logged: string[] = [];
  const kept = new Map<string, JsonValue>();
  const prompt: PromptPort = {
    async layout() {
      if (layout === undefined) throw new Error("no prompt yet");
      return layout;
    },
    async map() {
      const id = layout?.preset?.id;
      return id === undefined ? undefined : maps.get(id);
    },
    async saveMap(_scope, map) {
      maps.set(map.preset.id, structuredClone(map));
    },
    async saveLocated(_scope, found) {
      located.push(found);
    },
  };
  const mayKnow = (entry: LoreEntry, reader: AgentRef) => reader.plays === undefined || entry.knowing === undefined || (entry.knowing.by === "characters" && entry.knowing.names.includes(reader.plays));
  const env: MemoryHost["env"] = {
    prompt,
    lore: {
      async read(_scope, ids, reader) {
        return ids.flatMap((id) => {
          const entry = ENTRIES[id];
          return entry !== undefined && mayKnow(entry, reader) ? [entry] : [];
        });
      },
      async search() {
        return [];
      },
      async activated() {
        return activated;
      },
    },
    log: {
      debug: () => {},
      info: (message) => void logged.push(message),
      warn: (message) => void logged.push(message),
      error: (message) => void logged.push(message),
    },
    // Each user's values apart, as a host keeps them: the same key is one value per user.
    store: {
      async get(scope, key) {
        return kept.get(JSON.stringify([scope.user, key]));
      },
      async set(scope, key, value) {
        kept.set(JSON.stringify([scope.user, key]), structuredClone(value));
      },
      async update(scope, key, change) {
        const at = JSON.stringify([scope.user, key]);
        const value = change(kept.get(at));
        if (value === undefined) kept.delete(at);
        else kept.set(at, structuredClone(value));
        return value;
      },
      async delete(scope, key) {
        kept.delete(JSON.stringify([scope.user, key]));
      },
      async list(scope, prefix) {
        return [...kept.keys()].flatMap((at) => {
          const [user, key] = JSON.parse(at) as [string, string];
          return user === scope.user && key.startsWith(prefix) ? [key] : [];
        });
      },
      jobs: memoryJobs(),
    },
  };
  return {
    env,
    set(built, ids) {
      layout = built.layout;
      activated = ids.map((id) => ({ id, source: ENTRIES[id]?.source ?? "", title: ENTRIES[id]?.title ?? "", how: "keyword" as const }));
    },
    maps,
    located,
    logged,
  };
}

// ---------------------------------------------------------------- maps as a mapper writes them

const MAPPER: AgentRef = { id: "mapper-1", definition: "mapper", job: "job-1" };

export const A_MAP: JsonObject[] = [
  { marker: "preset.main", kind: "instructions", line: "How the narrator tells the tale.", behaviour: "fixed", parts: ["Main Prompt"] },
  { marker: "persona", kind: "persona", line: "Who the player's character is.", behaviour: "fixed", parts: ["Persona"] },
  { marker: "card", kind: "character", line: "Who Wren is.", behaviour: "fixed", parts: ["Character Description"] },
  { marker: "preset.style", kind: "style", line: "Tense, person and length.", behaviour: "fixed", parts: ["Style Guide"] },
  { marker: "preset.after", kind: "instructions", line: "What to end a reply on.", behaviour: "fixed", parts: ["Post-History Instructions"] },
];

export const B_MAP: JsonObject[] = [
  { marker: "rules", kind: "instructions", line: "How the mystery is run.", behaviour: "fixed", parts: ["message[0]"] },
  { marker: "style", kind: "style", line: "How a reply reads.", behaviour: "fixed", parts: ["message[0]"], starts: "Style:" },
  { marker: "persona", kind: "persona", line: "Who Ash is.", behaviour: "fixed", parts: ["message[1]"] },
  { marker: "card", kind: "character", line: "Who Marrow is.", behaviour: "fixed", parts: ["message[2]"] },
  { marker: "note", kind: "note", line: "The weather of the scene.", behaviour: "scene", parts: ["message[6]"] },
];

/** The prompt of a turn the host holds `built` for, with `lore` activated. */
export async function turnOf(host: MemoryHost, built: BuiltPrompt, lore: string[]): Promise<TurnPrompt> {
  host.set(built, lore);
  return TurnPrompt.read({ env: host.env, scope: SCOPE, messages: built.messages });
}

/** A mapper's `prompt_map_write` call on `prompt`, its signatures keeping `head` characters (the setting's default when not given): the answer's text, and whether it is an error. */
export async function write(host: MemoryHost, prompt: TurnPrompt, slices: JsonValue, head = DEFAULT_SETTINGS.signatureHead): Promise<{ text: string; error: boolean }> {
  const tool = promptMapWrite({ prompt: async () => prompt, guidance: shippedParts(), texts: new Map([["prompt_map_write", await shippedTool("prompt_map_write")]]), env: host.env, signatureHead: head });
  const result = await tool.run({ slices }, ctxOf(MAPPER));
  return { text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""), error: result.error === true };
}

/** The texts a name found, in order. */
export function texts(items: Item[] | undefined): string[] | undefined {
  return items?.map((item) => (item.type === "slice" ? item.text : item.type === "entry" ? item.entry.text : `(${item.type})`));
}
