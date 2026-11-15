// What the folder host reads from its folder, checked once at the door: each document's shape,
// with words that name the file when one is wrong, so the rest of the host works with named types.

import type {
  ActivatedLore,
  AgentRef,
  ChatRole,
  FactDef,
  FactValue,
  HistoryRange,
  JsonObject,
  JsonValue,
  LoreEntry,
  LoreKnowing,
  LoreSecret,
  PresetRef,
  PromptMap,
  PromptMessage,
  PromptPart,
  PromptRole,
  RawBlock,
  SliceKind,
  ToolTier,
} from "../../contract/index";

/** A plain object (not null, not an array): its fields are still to be checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A document that is not what the host expects: the words name the file and what is wrong. */
export class ShapeError extends Error {
  constructor(where: string, what: string) {
    super(`${where}: ${what}`);
    this.name = "ShapeError";
  }
}

function text(where: string, value: unknown, field: string): string {
  if (typeof value !== "string") throw new ShapeError(where, `"${field}" must be text`);
  return value;
}

function optionalText(where: string, value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(where, value, field);
}

function texts(where: string, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new ShapeError(where, `"${field}" must be a list of texts`);
  return value as string[];
}

function count(where: string, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ShapeError(where, `"${field}" must be a whole number, 0 or more`);
  return value;
}

function object(where: string, value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ShapeError(where, `"${field}" must be an object`);
  return value;
}

function role(where: string, value: unknown): PromptRole {
  if (value !== "system" && value !== "user" && value !== "assistant") throw new ShapeError(where, `"role" must be "system", "user" or "assistant"`);
  return value;
}

/** The slice kinds, as a block's `kind` may say one (`RawBlock.kind`). */
const SLICE_KINDS: Record<SliceKind, true> = { instructions: true, style: true, character: true, persona: true, world: true, note: true, lore: true, history: true, other: true };

function sliceKind(where: string, value: unknown, field: string): SliceKind {
  if (typeof value !== "string" || !Object.hasOwn(SLICE_KINDS, value)) throw new ShapeError(where, `"${field}" must be one of ${Object.keys(SLICE_KINDS).join(", ")}`);
  return value as SliceKind;
}

/** True when a value is JSON (finite numbers only). */
export function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}

function presetRef(where: string, value: unknown): PresetRef {
  const v = object(where, value, "preset");
  const name = optionalText(where, v.name, "preset.name");
  const revision = optionalText(where, v.revision, "preset.revision");
  return { id: text(where, v.id, "preset.id"), ...(name !== undefined ? { name } : {}), ...(revision !== undefined ? { revision } : {}) };
}

// ---------------------------------------------------------------- chats

/** A chat as `host/chats/<chat>/chat.json` describes it. */
export interface ChatRecord {
  /** The folder under `files/chats/` that holds the chat's folder: its character level. */
  character: string;
  preset: PresetRef | null;
  hiddenReadable: boolean;
  ranges: Record<string, HistoryRange>;
}

export function chatRecord(where: string, value: unknown): ChatRecord {
  const v = object(where, value, "the chat");
  const ranges: Record<string, HistoryRange> = {};
  if (v.ranges !== undefined) {
    for (const [name, raw] of Object.entries(object(where, v.ranges, "ranges"))) {
      const r = object(where, raw, `ranges.${name}`);
      ranges[name] = { from: count(where, r.from, `ranges.${name}.from`), to: count(where, r.to, `ranges.${name}.to`) };
    }
  }
  if (v.hiddenReadable !== undefined && typeof v.hiddenReadable !== "boolean") throw new ShapeError(where, `"hiddenReadable" must be true or false`);
  return {
    character: text(where, v.character, "character"),
    preset: v.preset === undefined || v.preset === null ? null : presetRef(where, v.preset),
    hiddenReadable: v.hiddenReadable === true,
    ranges,
  };
}

/** A message as a line of `messages.jsonl` holds it. */
export interface StoredMessage {
  id: string;
  role: ChatRole;
  name: string;
  text: string;
  hidden: boolean;
  summarized: boolean;
  at?: number;
}

export function storedMessage(where: string, value: unknown): StoredMessage {
  const v = object(where, value, "a message");
  if (v.at !== undefined && (typeof v.at !== "number" || !Number.isFinite(v.at))) throw new ShapeError(where, `"at" must be a time in milliseconds`);
  return {
    id: text(where, v.id, "id"),
    role: role(where, v.role),
    name: text(where, v.name, "name"),
    text: text(where, v.text, "text"),
    hidden: v.hidden === true,
    summarized: v.summarized === true,
    ...(typeof v.at === "number" ? { at: v.at } : {}),
  };
}

// ---------------------------------------------------------------- lore

function knowing(where: string, value: unknown): LoreKnowing {
  const v = object(where, value, "knowing");
  if (v.by === "anyone") return { by: "anyone" };
  if (v.by === "characters") return { by: "characters", names: texts(where, v.names, "knowing.names") };
  if (v.by === "gate") {
    if (typeof v.open !== "boolean") throw new ShapeError(where, `"knowing.open" must be true or false`);
    return { by: "gate", gate: text(where, v.gate, "knowing.gate"), open: v.open };
  }
  throw new ShapeError(where, `"knowing.by" must be "anyone", "characters" or "gate"`);
}

export function loreEntry(where: string, value: unknown): LoreEntry {
  const v = object(where, value, "the entry");
  const revision = optionalText(where, v.revision, "revision");
  const secrets: LoreSecret[] | undefined =
    v.secrets === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(v.secrets)) throw new ShapeError(where, `"secrets" must be a list`);
          return v.secrets.map((s, i) => {
            const o = object(where, s, `secrets[${i}]`);
            return { id: text(where, o.id, `secrets[${i}].id`), heldBy: texts(where, o.heldBy, `secrets[${i}].heldBy`) };
          });
        })();
  return {
    id: text(where, v.id, "id"),
    source: text(where, v.source, "source"),
    title: text(where, v.title, "title"),
    keys: texts(where, v.keys, "keys"),
    text: text(where, v.text, "text"),
    ...(revision !== undefined ? { revision } : {}),
    ...(v.knowing !== undefined ? { knowing: knowing(where, v.knowing) } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
  };
}

function activated(where: string, value: unknown): ActivatedLore[] {
  if (!Array.isArray(value)) throw new ShapeError(where, `"activated" must be a list`);
  return value.map((raw, i) => {
    const v = object(where, raw, `activated[${i}]`);
    const how = v.how;
    if (how !== undefined && how !== "constant" && how !== "keyword" && how !== "vector" && how !== "sticky") throw new ShapeError(where, `"activated[${i}].how" must be "constant", "keyword", "vector" or "sticky"`);
    return { id: text(where, v.id, `activated[${i}].id`), source: text(where, v.source, `activated[${i}].source`), title: text(where, v.title, `activated[${i}].title`), ...(how !== undefined ? { how } : {}) };
  });
}

// ---------------------------------------------------------------- prompts

/** A message of a given prompt, flagged as a chat application's interceptor would flag it. */
export interface GivenMessage extends PromptMessage {
  /** Chat history, standalone lore, or anything else (absent: anything else). */
  kind?: "history" | "lore" | "other";
  /** For history: the chat message, by id and place on the path. */
  source?: { id: string; index: number };
}

/**
 * A prompt given to the folder host for a turn (`host/chats/<chat>/turns/<turn>/prompt.json`): its
 * messages as sent, the chat application's breakdown into blocks where there is one, and which lore
 * entries activated. The folder host joins no messages, so each message is one part.
 */
export interface GivenPrompt {
  messages: GivenMessage[];
  blocks?: RawBlock[];
  blocksFrom?: "breakdown" | "dry-run";
  activated?: ActivatedLore[];
}

function promptContent(where: string, value: unknown): string | PromptPart[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new ShapeError(where, `"content" must be text or a list of parts`);
  return value.map((raw, i): PromptPart => {
    const p = object(where, raw, `content[${i}]`);
    if (p.type === "text") return { type: "text", text: text(where, p.text, `content[${i}].text`) };
    if (p.type === "image") return { type: "image", data: text(where, p.data, `content[${i}].data`), mimeType: text(where, p.mimeType, `content[${i}].mimeType`) };
    throw new ShapeError(where, `"content[${i}].type" must be "text" or "image"`);
  });
}

function givenMessage(where: string, value: unknown): GivenMessage {
  const v = object(where, value, "a message");
  const name = optionalText(where, v.name, "name");
  const kind = v.kind;
  if (kind !== undefined && kind !== "history" && kind !== "lore" && kind !== "other") throw new ShapeError(where, `"kind" must be "history", "lore" or "other"`);
  let source: { id: string; index: number } | undefined;
  if (v.source !== undefined) {
    const s = object(where, v.source, "source");
    source = { id: text(where, s.id, "source.id"), index: count(where, s.index, "source.index") };
  }
  return { role: role(where, v.role), content: promptContent(where, v.content), ...(name !== undefined ? { name } : {}), ...(kind !== undefined ? { kind } : {}), ...(source !== undefined ? { source } : {}) };
}

export function givenPrompt(where: string, value: unknown): GivenPrompt {
  const v = object(where, value, "the prompt");
  if (!Array.isArray(v.messages)) throw new ShapeError(where, `"messages" must be a list`);
  const messages = v.messages.map((m, i) => givenMessage(`${where} messages[${i}]`, m));
  const out: GivenPrompt = { messages };
  if (v.blocks !== undefined) {
    if (!Array.isArray(v.blocks)) throw new ShapeError(where, `"blocks" must be a list`);
    out.blocks = v.blocks.map((raw, i) => {
      const b = object(where, raw, `blocks[${i}]`);
      const id = optionalText(where, b.id, `blocks[${i}].id`);
      const kind = b.kind === undefined ? undefined : sliceKind(where, b.kind, `blocks[${i}].kind`);
      return { name: text(where, b.name, `blocks[${i}].name`), type: text(where, b.type, `blocks[${i}].type`), text: text(where, b.text, `blocks[${i}].text`), ...(b.role !== undefined ? { role: role(where, b.role) } : {}), ...(id !== undefined ? { id } : {}), ...(kind !== undefined ? { kind } : {}) };
    });
  }
  if (v.blocksFrom !== undefined) {
    if (v.blocksFrom !== "breakdown" && v.blocksFrom !== "dry-run") throw new ShapeError(where, `"blocksFrom" must be "breakdown" or "dry-run"`);
    out.blocksFrom = v.blocksFrom;
  }
  if (v.activated !== undefined) out.activated = activated(where, v.activated);
  return out;
}

/** A prompt map as the folder keeps it: the map, who learned it, and when. */
export interface KeptMap {
  map: PromptMap;
  learnedBy: AgentRef;
  at: number;
}

/** A kept map, read back. The map itself is the host's to keep whole and RPH's to read, so only its frame is checked here. */
export function keptMap(where: string, value: unknown): KeptMap {
  const v = object(where, value, "the kept map");
  const map = object(where, v.map, "map");
  if (map.format !== 1) throw new ShapeError(where, `"map.format" must be 1`);
  presetRef(where, map.preset);
  if (!Array.isArray(map.slices)) throw new ShapeError(where, `"map.slices" must be a list`);
  const by = object(where, v.learnedBy, "learnedBy");
  text(where, by.id, "learnedBy.id");
  text(where, by.definition, "learnedBy.definition");
  if (typeof v.at !== "number") throw new ShapeError(where, `"at" must be a time in milliseconds`);
  return v as unknown as KeptMap;
}

// ---------------------------------------------------------------- facts

/** `host/facts.json`: the facts the host declares, and their values by chat. */
export interface FactsDoc {
  defs: FactDef[];
  values: Record<string, Record<string, FactValue>>;
}

function factValue(where: string, value: unknown): FactValue {
  const v = object(where, value, "a fact's value");
  const out: FactValue = { count: count(where, v.count, "count") };
  if (v.names !== undefined) out.names = texts(where, v.names, "names");
  if (v.by !== undefined) {
    const by: Record<string, number> = {};
    for (const [group, n] of Object.entries(object(where, v.by, "by"))) by[group] = count(where, n, `by.${group}`);
    out.by = by;
  }
  if (v.namesBy !== undefined) {
    const namesBy: Record<string, string[]> = {};
    for (const [group, names] of Object.entries(object(where, v.namesBy, "namesBy"))) namesBy[group] = texts(where, names, `namesBy.${group}`);
    out.namesBy = namesBy;
  }
  if (v.fields !== undefined) {
    const fields = object(where, v.fields, "fields");
    if (!isJson(fields)) throw new ShapeError(where, `"fields" must be JSON`);
    out.fields = fields as Record<string, JsonValue>;
  }
  return out;
}

export function factsDoc(where: string, value: unknown): FactsDoc {
  const v = object(where, value, "the facts");
  if (!Array.isArray(v.defs)) throw new ShapeError(where, `"defs" must be a list`);
  const defs = v.defs.map((raw, i): FactDef => {
    const d = object(where, raw, `defs[${i}]`);
    return {
      name: text(where, d.name, `defs[${i}].name`),
      counts: text(where, d.counts, `defs[${i}].counts`),
      ...(d.by !== undefined ? { by: texts(where, d.by, `defs[${i}].by`) } : {}),
      ...(d.fields !== undefined ? { fields: texts(where, d.fields, `defs[${i}].fields`) } : {}),
    };
  });
  const values: Record<string, Record<string, FactValue>> = {};
  if (v.values !== undefined) {
    for (const [chat, facts] of Object.entries(object(where, v.values, "values"))) {
      const kept: Record<string, FactValue> = {};
      for (const [name, raw] of Object.entries(object(where, facts, `values.${chat}`))) kept[name] = factValue(`${where} values.${chat}.${name}`, raw);
      values[chat] = kept;
    }
  }
  return { defs, values };
}

// ---------------------------------------------------------------- tools

/** A tool as the manifest lists it. Its description is given in the manifest, or as a file of the agents' tree (`descriptionFile`, a path in their view). */
export interface ManifestTool {
  name: string;
  family: string;
  tier: ToolTier;
  lane?: string;
  description?: string;
  descriptionFile?: string;
  parameters: JsonObject;
  /** A command to run: such a tool is not run by the folder host. */
  command?: JsonValue;
}

/** The manifest's tools. An entry that is not a tool rejects the whole manifest, with words that say which. */
export function manifest(where: string, value: unknown): ManifestTool[] {
  const v = object(where, value, "the manifest");
  if (!Array.isArray(v.tools)) throw new ShapeError(where, `"tools" must be a list`);
  return v.tools.map((raw, i): ManifestTool => {
    const at = `${where} tools[${i}]`;
    const t = object(at, raw, "a tool");
    const tier = t.tier;
    if (tier !== "read" && tier !== "write" && tier !== "external") throw new ShapeError(at, `"tier" must be "read", "write" or "external"`);
    const parameters = object(at, t.parameters, "parameters");
    if (!isJson(parameters)) throw new ShapeError(at, `"parameters" must be JSON`);
    if (parameters.type !== "object") throw new ShapeError(at, `"parameters" must be an object schema ("type": "object")`);
    if (parameters.properties !== undefined && !isRecord(parameters.properties)) throw new ShapeError(at, `"parameters.properties" must be an object`);
    const description = optionalText(at, t.description, "description");
    const descriptionFile = optionalText(at, t.descriptionFile, "descriptionFile");
    if ((description === undefined) === (descriptionFile === undefined)) throw new ShapeError(at, `give "description" or "descriptionFile", one of the two`);
    const lane = optionalText(at, t.lane, "lane");
    if (t.command !== undefined && !isJson(t.command)) throw new ShapeError(at, `"command" must be JSON`);
    return {
      name: text(at, t.name, "name"),
      family: text(at, t.family, "family"),
      tier,
      parameters: parameters as JsonObject,
      ...(lane !== undefined ? { lane } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(descriptionFile !== undefined ? { descriptionFile } : {}),
      ...(t.command !== undefined ? { command: t.command as JsonValue } : {}),
    };
  });
}

// ---------------------------------------------------------------- the writes journal

/** One agent write, as the turn's journal keeps it, so the lead can drop that agent's writes (§13.4). */
export interface JournalLine {
  agent: AgentRef;
  /** The path in the agents' view. */
  path: string;
  /** The file's text before this write; null when it was not there. */
  before: string | null;
  /** The file's hash after this write; null when the write deleted it. */
  after: string | null;
}

export function journalLine(where: string, value: unknown): JournalLine {
  const v = object(where, value, "a journal line");
  const agent = object(where, v.agent, "agent");
  const parent = optionalText(where, agent.parent, "agent.parent");
  const job = optionalText(where, agent.job, "agent.job");
  const plays = optionalText(where, agent.plays, "agent.plays");
  if (v.before !== null && typeof v.before !== "string") throw new ShapeError(where, `"before" must be text or null`);
  if (v.after !== null && typeof v.after !== "string") throw new ShapeError(where, `"after" must be text or null`);
  return {
    agent: {
      id: text(where, agent.id, "agent.id"),
      definition: text(where, agent.definition, "agent.definition"),
      ...(parent !== undefined ? { parent } : {}),
      ...(job !== undefined ? { job } : {}),
      ...(plays !== undefined ? { plays } : {}),
    },
    path: text(where, v.path, "path"),
    before: v.before,
    after: v.after,
  };
}

