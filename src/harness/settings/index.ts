// The user's settings a turn is run under (§10.11, Appendix D.1), and the one list of every setting
// RPH reads (§5.4 "Config": the Settings page edits them as forms), which a host shows from
// `rp-harness/helpers`. Each setting is declared once, as an entry of its group's module: its key as
// a config file writes it, what it takes, its default, what `~` means where it may be set, whether it
// is set per connection, the levels it is read from and where the harness keeps its value, with its
// name and what it is for from the group's words file. This module joins the groups: `SETTINGS` is
// their list, `Settings` the type of what they read, and `readSettings` reads every entry in one pass
// through the entry, so a setting added to its group's module is read, typed and listed with nothing
// else changed.
//
// A scope's config files are read farthest first and merged by `mergedConfig`, the nearer level's
// value over the farther one's, mapping by mapping. Every value is checked by the one check of a
// value (`checkSettingValue`, which `rp-harness/helpers` gives a host). A value passed over is logged
// once with its key, the file that set it and why, and never stops a turn: one a setting does not
// take leaves its default; an item of a list that is not a name (not text, or blank) is dropped and the rest read; and a value
// set in the file of a level the setting is not read from is not read, nor is a key in one of the
// harness's own sections that names no setting, nor a key the harness once read and reads no longer.
//
// What has no chat in view (a connection's test, a sign-in, a request passed through) reads its
// settings at the levels every chat shares, through a read that names only the user (`UserScope`).

import type { Effort, FilesPort, JsonObject, JsonValue, LayerLevel, Log, MergeLevels, Scope, SettingTakes, UserScope } from "../../contract";
import type { AgentDefinition, DefinitionLimits, Guidance } from "../../files/api";
import type { CallTerms } from "../../loop/types";
import { AGENTS } from "./agents";
import { checkSettingValue, valueWords } from "./check";
import { CALLS } from "./calls";
import { COMPACTION } from "./compaction";
import { CONNECTION, DEFINITION, frozen, type Group, isNamed, type ListedSetting, type SettingEntry } from "./entry";
import { HOOKS } from "./hooks";
import { JOBS } from "./jobs";
import { LIMITS } from "./limits";
import { MCP } from "./mcp";
import { MODELS, MODELS_GONE } from "./models";
import { PROMPT } from "./prompt";
import { REPLY } from "./reply";
import { RULES } from "./rules";
import { TOOLS } from "./tools";
import { SESSIONS } from "./sessions";
import { TRACE, TRACE_GONE } from "./trace";
import { USAGE } from "./usage";

/** The groups of settings RPH reads, in the order the list gives them. A new group is one line here. */
export const GROUPS = [LIMITS, AGENTS, USAGE, JOBS, MODELS, CALLS, REPLY, TOOLS, MCP, HOOKS, RULES, TRACE, PROMPT, COMPACTION, SESSIONS] as const;

/** Keys the harness once read and reads no longer, each with what holds in its place. */
const GONE: Readonly<Record<string, string>> = { ...MODELS_GONE, ...TRACE_GONE };

/** The settings of some groups as a host sees them: every entry with its words, and not where the harness keeps its value. */
export function listOf(groups: readonly Group[]): readonly ListedSetting[] {
  return frozen(groups.flatMap((group) => Object.values(group).map(({ at: _at, ms: _ms, noneKept: _kept, advise: _advise, ...listed }) => listed)));
}

/** Every setting RPH reads, as a config file writes it, each with its name and what it is for. */
export const SETTINGS: readonly ListedSetting[] = listOf(GROUPS);

// ---------------------------------------------------------------- what the settings read as

/** What a level may set that a setting takes, by what it takes, as it is read. */
type TakenBy<T extends SettingTakes> = T extends { type: "whole" | "number" } ? number : T extends { type: "oneOf"; values: readonly (infer V)[] } ? V : T extends { type: "yesNo" } ? boolean : T extends { type: "text" } ? string : readonly string[];

/** A value a level may set that the setting takes: `~` too, where it takes that. */
type Taken<D extends SettingEntry> = TakenBy<D["takes"]> | (D extends { readonly orNone: true } ? null : never);

/** A setting's value: one a level sets, or its default, which is one it takes or none (null). */
type ValueOf<D extends SettingEntry> = Taken<D> | (null extends D["default"] ? null : never);

/** Where a value lands at the path `P` of `Settings`: none leaves the field out, so a field that may be none is optional, where it is not kept (`K`, the entry's `noneKept`) as null; connections and definitions are keyed by name, as the files write them. */
type Land<P extends string, V, K extends boolean = false> = P extends `${typeof CONNECTION | typeof DEFINITION}.${infer Rest}`
  ? Readonly<Record<string, Land<Rest, V, K>>>
  : P extends typeof CONNECTION | typeof DEFINITION
    ? Readonly<Record<string, Exclude<V, null>>>
    : P extends `${infer Head}.${infer Rest}`
      ? { readonly [F in Head]: Land<Rest, V, K> }
      : null extends V
        ? K extends true
          ? { readonly [F in P]?: V }
          : { readonly [F in P]?: Exclude<V, null> }
        : { readonly [F in P]: V };

/** Every entry of some groups, as one union. */
type EntryOf<G extends readonly Group[]> = G[number] extends infer R ? (R extends Group ? R[keyof R] : never) : never;

/** A union of object types as one object type holding all their fields. */
type Joined<U> = (U extends unknown ? (part: U) => void : never) extends (part: infer I) => void ? I : never;

/** What the settings of some groups read as: each entry's value where its entry says it lands. */
export type SettingsOf<G extends readonly Group[]> = Joined<EntryOf<G> extends infer E ? (E extends SettingEntry ? Land<E["at"], ValueOf<E>, E extends { readonly noneKept: true } ? true : false> : never) : never>;

/** The user's settings a turn is run under. */
export type Settings = SettingsOf<typeof GROUPS>;

/** The user's limits on sub-agents (§10.11: "sub-agent depth and count ... every one is a setting"). */
export type AgentSettings = Settings["subAgents"];

/** The user's limits on jobs (§13.5, §10.11), `time` in milliseconds; each absent is no limit. */
export type JobSettings = Settings["jobs"];

/** A day's and a moment's count of jobs on one connection; each absent is no limit. */
export type JobCounts = JobSettings["connections"][string];

export type ReplyFormSetting = (typeof REPLY.form.takes.values)[number];

/** Which model calls have what they were sent kept in the turn's folder: each agent's first, every one, or none. */
export type RequestsSetting = (typeof TRACE.requests.takes.values)[number];

/** The model layer's settings (`calls.*`), times in milliseconds; an absent silent wait is no limit; with the characters per token its counts are made at (`tokens.charsPerToken`). */
export type ModelSettings = Settings["calls"] & { charsPerToken: number };

/** Where a scope's levels come from: a chat's guidance, or, with no chat in view, the file port's levels for the user alone. */
type LevelSource = Pick<Guidance, "layers">;

// ---------------------------------------------------------------- the levels

/** One level's config file, as read: its level, its path in the agents' view, and what it holds. */
export interface LevelConfig {
  readonly level: LayerLevel;
  readonly path: string;
  readonly config: JsonObject;
}

function isMapping(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The merge of levels (the contract's `MergeLevels`): the nearer config's values over the farther one's, mapping by mapping. */
export const mergedConfig: MergeLevels = function merged(far, near) {
  const out: JsonObject = { ...far };
  for (const [key, value] of Object.entries(near)) {
    const before = out[key];
    out[key] = isMapping(before) && isMapping(value) ? merged(before, value) : value;
  }
  return out;
};

/** Each level's config file of a scope, farthest first. One that is missing or empty holds nothing; one that does not parse, or is no mapping of keys, is logged and passed over. */
async function levelConfigs(source: LevelSource, files: FilesPort, scope: Scope | UserScope, log: Log): Promise<LevelConfig[]> {
  const levels: LevelConfig[] = [];
  for (const layer of await source.layers()) {
    if (layer.config === undefined) continue;
    const path = `${layer.mount}${layer.config}`;
    const read = await files.read(scope, path);
    if (read.status !== "read" || read.text.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(read.text);
    } catch (error) {
      log.warn("A config file does not parse; the harness's settings in it are passed over.", { path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (parsed === null || parsed === undefined) continue;
    if (!isMapping(parsed)) {
      log.warn("A config file is not a mapping of keys; the harness's settings in it are passed over.", { path });
      continue;
    }
    levels.push({ level: layer.level, path, config: parsed });
  }
  return levels;
}

// ---------------------------------------------------------------- one value, through its entry

/** Whether a level's config decides what is at `path`: it sets it, or sets a value that is no mapping above it, which leaves the farther levels' out. */
function decides(config: JsonObject, path: readonly string[]): boolean {
  let at: JsonValue = config;
  for (const part of path) {
    if (!isMapping(at)) return true;
    const next: JsonValue | undefined = at[part];
    if (next === undefined) return false;
    at = next;
  }
  return true;
}

/** Each value a config sets at a key's path, with the path it is set at: one for each connection or definition it names, where the key has `<connection>` or `<definition>`. */
function valuesAt(config: JsonValue, parts: readonly string[], path: readonly string[] = []): { path: string[]; value: JsonValue }[] {
  if (parts.length === 0) return [{ path: [...path], value: config }];
  if (!isMapping(config)) return [];
  const [part, ...rest] = parts as [string, ...string[]];
  return (isNamed(part) ? Object.keys(config) : [part]).flatMap((name) => {
    const next = config[name];
    return next === undefined ? [] : valuesAt(next, rest, [...path, name]);
  });
}

/**
 * A scope's settings, each read through its entry, from the merged config of the levels it is read
 * from, every value checked by the one check (`checkSettingValue`). Each value passed over is logged
 * once, with its key, the file that set it, and why: a value the setting does not take, an item of a
 * list that is not a name (not text, or blank), and a value set in the file of a level the setting is not read from.
 * Exported for the tests, which read an entry no group declares yet: one read from some levels alone.
 */
export class SettingsRead {
  readonly #levels: readonly LevelConfig[];
  readonly #log: Log | undefined;
  /** The merged config of each set of levels a setting is read from, by the set. */
  readonly #configs = new Map<string, { levels: readonly LevelConfig[]; config: JsonObject }>();
  /** What has been logged, so each value passed over is logged once. */
  readonly #passed = new Set<string>();
  /** The settings read from some levels alone whose other levels' files have been looked at. */
  readonly #looked = new Set<string>();

  constructor(levels: readonly LevelConfig[], log: Log | undefined) {
    this.#levels = levels;
    this.#log = log;
  }

  /** The value a level sets for the setting, where the setting takes it; undefined where no level sets one, or where the one set is passed over. */
  taken<D extends SettingEntry>(def: D, connection?: string): Taken<D> | undefined {
    this.#unread(def);
    const { levels, config } = this.#merged(def);
    // The key as the path of mappings a config file holds it at; a connection's or a definition's name stays whole, dots and all.
    const path = def.key.split(".").map((part) => (isNamed(part) && connection !== undefined ? connection : part));
    let at: JsonValue = config;
    for (const [i, part] of path.entries()) {
      if (!isMapping(at)) {
        this.#notMapping(path.slice(0, i), at, levels);
        return undefined;
      }
      const next: JsonValue | undefined = at[part];
      if (next === undefined) return undefined;
      at = next;
    }
    return this.#take(def, at, path, levels, connection) as Taken<D> | undefined;
  }

  /** The setting's value: the one a level sets, where the setting takes it; else its default. */
  value<D extends SettingEntry>(def: D): ValueOf<D> {
    const taken = this.taken(def);
    // An entry's default is a value it takes, or none (the test holds every entry to that).
    return taken === undefined ? (def.default as ValueOf<D>) : taken;
  }

  /**
   * The names or ids a setting set per connection (or per definition) is set under, as the files
   * write them. Where its key goes on past the name, only those holding a mapping: another value
   * there is passed over.
   */
  named(def: SettingEntry): string[] {
    this.#unread(def);
    const { levels, config } = this.#merged(def);
    const parts = def.key.split(".");
    const before = parts.slice(0, parts.findIndex(isNamed));
    const more = parts.length > before.length + 1;
    let at: JsonValue = config;
    for (const [i, part] of before.entries()) {
      if (!isMapping(at)) {
        this.#notMapping(before.slice(0, i), at, levels);
        return [];
      }
      const next: JsonValue | undefined = at[part];
      if (next === undefined) return [];
      at = next;
    }
    if (!isMapping(at)) {
      this.#notMapping(before, at, levels);
      return [];
    }
    const named = at;
    return Object.keys(named).filter((name) => {
      if (!more || isMapping(named[name])) return true;
      this.#notMapping([...before, name], named[name]!, levels);
      return false;
    });
  }

  #merged(def: SettingEntry): { levels: readonly LevelConfig[]; config: JsonObject } {
    const set = def.levels?.join(",") ?? "";
    let merged = this.#configs.get(set);
    if (merged === undefined) {
      const levels = def.levels === undefined ? this.#levels : this.#levels.filter((l) => def.levels!.includes(l.level));
      merged = { levels, config: levels.reduce<JsonObject>((config, l) => mergedConfig(config, l.config), {}) };
      this.#configs.set(set, merged);
    }
    return merged;
  }

  #take(def: SettingEntry, value: JsonValue, path: readonly string[], levels: readonly LevelConfig[], connection: string | undefined): JsonValue | undefined {
    const check = checkSettingValue(def, value, connection);
    if (check.ok) return check.value;
    const key = path.join(".");
    const fields = { setting: key, value, file: this.#fileOf(levels, path), why: check.why };
    if (check.kept === undefined) {
      this.#pass(key, "A setting has a value it does not take; its default holds.", fields);
      return undefined;
    }
    this.#pass(key, "A setting's list has items that are not names; they are passed over, and the rest is read.", fields);
    return check.kept;
  }

  /** A value that is no mapping where the settings under its key are read: they are all at their defaults. */
  #notMapping(path: readonly string[], value: JsonValue, levels: readonly LevelConfig[]): void {
    const key = path.join(".");
    this.#pass(key, "A setting has a value it does not take; its default holds.", { setting: key, value, file: this.#fileOf(levels, path), why: `${key} holds the settings under it as a mapping of keys, not ${valueWords(value)}.` });
  }

  /** Each value set for a setting read from some levels alone, in the file of a level it is not read from: passed over, as its entry says, and logged. */
  #unread(def: SettingEntry): void {
    const read = def.levels;
    if (read === undefined || this.#looked.has(def.key)) return;
    this.#looked.add(def.key);
    for (const level of this.#levels) {
      if (read.includes(level.level)) continue;
      for (const { path, value } of valuesAt(level.config, def.key.split("."))) {
        const key = path.join(".");
        this.#pass(`${key}\n${level.path}`, "A setting is set in a file it is not read from; the value there is passed over.", { setting: key, value, file: level.path, why: `${key} is read from ${read.length === 1 ? `the ${read[0]} file` : `the ${read.join(" and ")} files`} alone, not from the ${level.level} file.` });
      }
    }
  }

  /**
   * Each key a file sets in a section the entries live in that names none of them (`limits.turn.cals`):
   * passed over, and logged once with its file. A section holds its entries' keys and its
   * subsections; one whose keys are connections' names takes any name. A section no entry lives in
   * (`limits` itself) is another reader's, and nothing in it is the harness's to name.
   */
  unnamed(entries: readonly SettingEntry[]): void {
    const sections = new Map<string, Set<string>>();
    const anyName = new Set<string>();
    for (const entry of entries) {
      const parts = entry.key.split(".");
      const parent = parts.slice(0, -1).join(".");
      if (isNamed(parts.at(-1))) anyName.add(parent);
      else sections.set(parent, (sections.get(parent) ?? new Set<string>()).add(parts.at(-1)!));
    }
    for (const entry of entries) {
      const parts = entry.key.split(".");
      for (let end = 1; end < parts.length - 1; end += 1) sections.get(parts.slice(0, end).join("."))?.add(parts[end]!);
    }
    for (const [section, keys] of sections) {
      if (anyName.has(section)) continue;
      for (const level of this.#levels) {
        for (const { path, value } of valuesAt(level.config, section.split("."))) {
          if (!isMapping(value)) continue;
          for (const [name, held] of Object.entries(value)) {
            if (keys.has(name)) continue;
            const key = [...path, name].join(".");
            this.#pass(`unnamed\n${key}\n${level.path}`, "A key among the harness's settings names none of them; it is passed over.", { setting: key, value: held, file: level.path, why: `${key} is no setting the harness reads: ${path.join(".")} holds ${[...keys].join(", ")}.` });
          }
        }
      }
    }
  }

  /** Each key the harness once read and reads no longer (`effort.connections`), set in a file: passed over, and logged once with its file and what holds in its place. */
  gone(keys: Readonly<Record<string, string>>): void {
    for (const [gone, instead] of Object.entries(keys)) {
      for (const level of this.#levels) {
        for (const { path, value } of valuesAt(level.config, gone.split("."))) {
          const key = path.join(".");
          this.#pass(`gone\n${key}\n${level.path}`, "A key among the harness's settings names none of them; it is passed over.", { setting: key, value, file: level.path, why: `${key} is no setting the harness reads: ${instead}.` });
        }
      }
    }
  }

  /** The file of the nearest of the levels that decides what is at `path`. */
  #fileOf(levels: readonly LevelConfig[], path: readonly string[]): string | null {
    return levels.findLast((l) => decides(l.config, path))?.path ?? null;
  }

  #pass(once: string, message: string, fields: { setting: string; value: JsonValue; file: string | null; why: string }): void {
    if (this.#passed.has(once)) return;
    this.#passed.add(once);
    this.#log?.warn(message, fields);
  }
}

/** A field of the settings being put together, made as an own field whatever its name, a connection's included. */
function own(holder: Record<string, unknown>, field: string, value: unknown): void {
  Object.defineProperty(holder, field, { value, enumerable: true, writable: true, configurable: true });
}

/** The settings some groups read from a scope's config files: each entry's value, read through it, where it lands; each key of `gone` a file still sets is logged. */
function settingsFrom<const G extends readonly Group[]>(groups: G, levels: readonly LevelConfig[], log?: Log, gone: Readonly<Record<string, string>> = {}): SettingsOf<G> {
  const read = new SettingsRead(levels, log);
  const out: Record<string, unknown> = {};
  /** The mapping at `path` of what is put together, made empty where it is not there yet, so a group of fields is there with none of its fields set. */
  const holder = (path: readonly string[]): Record<string, unknown> => {
    let at = out;
    for (const field of path) {
      if (!Object.hasOwn(at, field)) own(at, field, {});
      at = at[field] as Record<string, unknown>;
    }
    return at;
  };
  for (const group of groups) {
    for (const entry of Object.values(group)) {
      const path = entry.at.split(".");
      const land = (to: readonly string[], value: unknown): void => own(holder(to.slice(0, -1)), to.at(-1)!, entry.ms === true && value !== null ? (value as number) * 1000 : value);
      const named = path.findIndex(isNamed);
      if (named === -1) {
        holder(path.slice(0, -1));
        // None leaves the field out.
        const value = read.value(entry);
        if (value !== null) land(path, value);
        continue;
      }
      // The connections' own mapping is there with no connection set; a connection the files name with a mapping is kept, a limit set or not.
      // It holds connections' names alone, with nothing inherited, so a connection named `constructor` or `toString` finds its own value or none.
      const connections = path.slice(0, named);
      const parent = holder(connections.slice(0, -1));
      if (!Object.hasOwn(parent, connections.at(-1)!)) own(parent, connections.at(-1)!, Object.create(null));
      for (const connection of read.named(entry)) {
        const to = [...path.slice(0, named), connection, ...path.slice(named + 1)];
        holder(to.slice(0, -1));
        const value = read.taken(entry, connection);
        // None set at a level is left out, but where it stands over another source (`noneKept`): there it lands as null.
        if (value !== undefined && (value !== null || entry.noneKept === true)) land(to, value);
      }
    }
  }
  read.unnamed(groups.flatMap((group) => Object.values(group)));
  read.gone(gone);
  return out as SettingsOf<G>;
}

/** The defaults, where no level sets a value: the settings of no config file at all, so each default lives in its entry alone. */
export const DEFAULT_SETTINGS: Settings = settingsFrom(GROUPS, []);

/** The settings some groups read for a scope, as its config files set them over the entries' defaults. */
export async function readSettingsOf<const G extends readonly Group[]>(groups: G, source: LevelSource, files: FilesPort, scope: Scope | UserScope, log: Log): Promise<SettingsOf<G>> {
  return settingsFrom(groups, await levelConfigs(source, files, scope, log), log);
}

/** The settings of a scope, as its config files set them over the defaults; a key the harness reads no longer is logged. */
export async function readSettings(guidance: Guidance, files: FilesPort, scope: Scope | UserScope, log: Log): Promise<Settings> {
  return settingsFrom(GROUPS, await levelConfigs(guidance, files, scope, log), log, GONE);
}

/**
 * The model layer's settings at a scope's levels, read as each is used so a change holds from the
 * next call: a chat's levels for an agent's call in a chat, else, with a scope that names only the
 * user, the levels every chat shares.
 */
export async function readModelSettings(files: FilesPort, scope: Scope | UserScope, log: Log): Promise<ModelSettings> {
  const read = await readSettingsOf([MODELS, CALLS] as const, { layers: () => files.layers(scope) }, files, scope, log);
  return { ...read.calls, charsPerToken: read.tokens.charsPerToken };
}

/** The form a connection's reply takes, and whether a two-step connection streams anyway, by the connection's name or id. */
export function formFor(settings: Settings, connection: { id: string | null; name: string | null }): { form: ReplyFormSetting; stream: boolean } {
  const keys = [connection.id, connection.name].filter((key): key is string => key !== null);
  const named = keys.map((key) => (Object.hasOwn(settings.forms, key) ? settings.forms[key] : undefined)).find((form) => form !== undefined);
  return { form: named ?? settings.form, stream: keys.some((key) => settings.streamAnyway.includes(key)) };
}

/** Whether a stream rule that interrupts stops a call on this connection (`stop`) or reminds after it (`remind`), by the connection's id or name (`rules.interrupts`), else `rules.interrupt`. */
export function interruptFor(settings: Settings, connection: { id: string | null; name: string | null }): "stop" | "remind" {
  const keys = [connection.id, connection.name].filter((key): key is string => key !== null);
  return keys.map((key) => (Object.hasOwn(settings.ruleInterrupts, key) ? settings.ruleInterrupts[key] : undefined)).find((mode) => mode !== undefined) ?? settings.ruleInterrupt;
}

/**
 * How each model call of an agent is measured and sampled (§10.2 l.1165; Appendix D.1 l.2419,
 * l.2421): the characters per token every estimate before a provider counts is made at, the least
 * room an answer is given, the weight of a token read again from the cache, the tool calls an answer
 * runs at once where the definition sets none, the loop's count of the same call in a row, and, for
 * an agent of a definition, that definition's own sampling, on each call whose own settings give
 * none. An agent of no definition (a judging call, the writer of a narrator's reply, which takes the
 * preset's) has no sampling of its own.
 */
export function callTerms(settings: Settings, definition?: string): CallTerms {
  const own = definition !== undefined && Object.hasOwn(settings.sampling, definition) ? settings.sampling[definition] : undefined;
  return {
    charsPerToken: settings.tokens.charsPerToken,
    answerFloor: settings.answerFloor,
    cachedWeight: settings.cachedWeight,
    toolsAtOnce: settings.toolsAtOnce,
    ...(settings.repeats !== undefined ? { repeats: settings.repeats } : {}),
    ...(own !== undefined && Object.keys(own).length > 0 ? { sampling: { ...own } } : {}),
  };
}

/**
 * The limits an agent of a definition is held to (§2.1 point 5): each its header's `limits:` sets,
 * with each one a level sets for it (`agents.<definition>.limits.<limit>`) standing over the
 * header's, `~` lifting it. `time` and `callTime` in milliseconds. Undefined where none holds.
 */
export function agentLimits(settings: Pick<Settings, "agents">, definition: Pick<AgentDefinition, "name" | "limits">): DefinitionLimits | undefined {
  const out: Record<string, number> = { ...definition.limits };
  const own = Object.hasOwn(settings.agents, definition.name) ? settings.agents[definition.name]?.limits : undefined;
  for (const [limit, value] of Object.entries(own ?? {})) {
    if (value === null) delete out[limit];
    else if (value !== undefined) out[limit] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The effort an agent of a definition thinks at, as far as the settings and its header say
 * (§2.1 point 5): a level's `agents.<definition>.effort` stands over the header's `effort:`, and `~`
 * there leaves it to its connection. Undefined: its connection's own.
 */
export function agentEffort(settings: Pick<Settings, "agents">, definition: Pick<AgentDefinition, "effort"> & { name?: string }): Effort | undefined {
  const own = definition.name !== undefined && Object.hasOwn(settings.agents, definition.name) ? settings.agents[definition.name] : undefined;
  if (own !== undefined && Object.hasOwn(own, "effort")) return own.effort ?? undefined;
  return definition.effort;
}

/** The user's counts for the jobs on one connection, under the setting's key that names it (its name or its id). */
export interface ConnectionCounts {
  key: string;
  counts: JobCounts;
}

/** The user's counts for the jobs on a connection, each by the setting's key that names it. */
export function jobCountsFor(settings: Settings, connection: { id: string | null; name: string | null }): ConnectionCounts[] {
  return [...new Set([connection.id, connection.name].filter((key): key is string => key !== null))].flatMap((key) => {
    const counts = Object.hasOwn(settings.jobs.connections, key) ? settings.jobs.connections[key] : undefined;
    return counts === undefined ? [] : [{ key, counts }];
  });
}
