// The user's settings a turn is run under (§10.11, Appendix D.1), and the one list of every setting
// RPH reads (§5.4 "Config": the Settings page edits them as forms), which a host shows from
// `rp-harness/helpers`. Each setting is declared once, as an entry of its group's module: its key as
// a config file writes it, what it takes, its default, what `~` means where it may be set, whether it
// is set per connection and the levels it is read from, with its name and what it is for from the
// group's words file. This module joins the groups into `SETTINGS`, and `readSettings` reads every
// value through its entry, so no key is read that is not listed, and a page offers what is read.
//
// A scope's config files are read farthest first and merged by `mergedConfig`, the nearer level's
// value over the farther one's, mapping by mapping. A value a setting does not take is logged with
// its key, the file that set it and why, and passed over: its default holds, and it never stops a turn.

import type { Effort, FilesPort, JsonObject, JsonValue, LayerLevel, Log, MergeLevels, Scope, SettingTakes } from "../../contract";
import type { Guidance } from "../../files/api";
import { COMPACTION } from "./compaction";
import type { ListedSetting, SettingEntry } from "./entry";
import { JOBS } from "./jobs";
import { LIMITS } from "./limits";
import { MODELS } from "./models";
import { REPLY } from "./reply";
import { RULES } from "./rules";
import { TOOLS } from "./tools";
import { TRACE } from "./trace";

/** Every setting RPH reads, as a config file writes it, each with its name and what it is for. A setting is added in its group's module; a new group is one line here. */
export const SETTINGS: readonly ListedSetting[] = Object.freeze([
  ...Object.values(LIMITS),
  ...Object.values(JOBS),
  ...Object.values(MODELS),
  ...Object.values(REPLY),
  ...Object.values(TOOLS),
  ...Object.values(RULES),
  ...Object.values(TRACE),
  ...Object.values(COMPACTION),
]);

export type ReplyFormSetting = "tags" | "two-step";

/** Which model calls have what they were sent kept in the turn's folder: each agent's first, every one, or none. */
export type RequestsSetting = "first" | "all" | "none";

/** The user's limits on sub-agents (§10.11: "sub-agent depth and count ... every one is a setting"). */
export interface AgentSettings {
  /** How deep a sub-agent may stand: the lead's own stand at 1, the ones they start at 2. 0: none is started. */
  depth: number;
  /** Sub-agents one turn may start in all; absent is no limit. */
  agents?: number;
}

export interface Settings {
  /** Limits shared by every agent of one turn; each absent is no limit. `time` in milliseconds. */
  turn: { calls?: number; tokensIn?: number; tokensOut?: number; time?: number };
  subAgents: AgentSettings;
  /** The form every connection's reply takes, unless `forms` names the connection. */
  form: ReplyFormSetting;
  forms: Readonly<Record<string, ReplyFormSetting>>;
  /** Two-step connections whose replies stream anyway, by name or id. */
  streamAnyway: readonly string[];
  heldSentences: number;
  tailSentences: number;
  leadSampling: "own" | "preset";
  /** How long, in milliseconds, a tool or the reply waits at most for the host to take the intent record. */
  intentWaitMs: number;
  progress: "all" | "least";
  silenceMs: number;
  /** Characters of a tool's answer, its text and its reports together, that the model reads. */
  clipChars: number;
  /** Tools one `tool_search` gives when the agent names no limit. */
  searchHits: number;
  /** Hits `gap_check` takes from each place when the agent names no limit. */
  gapHits: number;
  /** The most one tool call takes: messages, entries, or hits from each place searched; a stretch of the chat an agent is given too. */
  perCall: number;
  /** Characters of a tool's schema that the answer to a call that does not fit it shows whole. */
  schemaShown: number;
  /** Characters a rule's pattern looks at at a time. */
  ruleWindow: number;
  /** The connection a `question:` rule is judged on, by its name or id, where the rule names none (§5.4); absent: the asking agent's own. */
  judge?: string;
  /** The effort agents on a connection think at, by the connection's name or id, over their definitions'. */
  efforts: Readonly<Record<string, Effort>>;
  /** Which calls' requests are kept in the turn's folder. */
  requests: RequestsSetting;
  /** Turns of a chat whose prompts are kept, so the next turn's is compared with the turn it follows (§4.8). */
  promptKept: number;
  /**
   * When a session's earlier turns are summarized (§11): the tokens kept free for the answer, how
   * many of the newest turns are kept as they were, the tokens of carried records past which the
   * records mode folds them into the summary, and the model calls the lead makes in its call at the
   * moment before a compaction.
   */
  compaction: { reserve: number; keepTurns: number; records: number; saveCalls: number };
  jobs: JobSettings;
}

/** A day's and a moment's count of jobs, for every job or for those on one connection; each absent is no limit. */
export interface JobCounts {
  atOnce?: number;
  perDay?: number;
}

/**
 * The user's limits on jobs (§13.5, §10.11): how many run at once (one past it waits for a place)
 * and how many may be started in the user's day; the same for the jobs on one connection, by its
 * name or id; how many the agents of one run may start; the tokens all of the user's jobs may spend
 * in the user's day; and what one job's run may spend across its agents (`time` in milliseconds).
 * Each absent is no limit.
 */
export interface JobSettings extends JobCounts {
  atOnce: number;
  connections: Readonly<Record<string, JobCounts>>;
  /** Jobs the agents of one run (a turn's, or a job's) may start; 0 starts none. */
  perRun?: number;
  /** Tokens, sent and written, that all of the user's jobs may spend in the user's day. */
  tokensPerDay?: number;
  /** What a token read again from a provider's cache counts as in the day's job tokens, from 0 to 1. */
  cachedWeight: number;
  run: { calls?: number; tokensIn?: number; tokensOut?: number; time?: number };
}

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
async function levelConfigs(guidance: Guidance, files: FilesPort, scope: Scope, log: Log): Promise<LevelConfig[]> {
  const levels: LevelConfig[] = [];
  for (const layer of await guidance.layers()) {
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

/** Where a per-connection setting's key names the connection. */
const CONNECTION = "<connection>";

/** What a level may set that a setting takes, by what it takes, as it is read. */
type TakenBy<T extends SettingTakes> = T extends { type: "whole" | "number" } ? number : T extends { type: "oneOf"; values: readonly (infer V)[] } ? V : T extends { type: "yesNo" } ? boolean : T extends { type: "text" } ? string : string[];

/** A value a level may set that the setting takes: `~` too, where it takes that. */
type Taken<D extends SettingEntry> = TakenBy<D["takes"]> | (D extends { readonly orNone: true } ? null : never);

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

/** What a setting takes, in words, for the log: "a whole number, at least 1, or ~ for no limit". */
function takesWords(def: SettingEntry): string {
  const t = def.takes;
  const what =
    t.type === "whole"
      ? t.most === undefined
        ? `a whole number, at least ${t.least}`
        : `a whole number from ${t.least} to ${t.most}`
      : t.type === "number"
        ? t.most === undefined
          ? `a number, at least ${t.least}`
          : `a number from ${t.least} to ${t.most}`
        : t.type === "oneOf"
          ? `one of ${t.values.join(", ")}`
          : t.type === "yesNo"
            ? "true or false"
            : t.type === "text"
              ? "a line of text"
              : "a list of names";
  return def.orNone === true ? `${what}, or ~ for ${def.none ?? "none"}` : what;
}

/** A value as the setting reads it, where it is one the setting takes; undefined where it is not. */
function takenValue(def: SettingEntry, value: JsonValue): JsonValue | undefined {
  if (value === null) return def.orNone === true ? null : undefined;
  const t = def.takes;
  switch (t.type) {
    case "whole":
      return typeof value === "number" && Number.isInteger(value) && value >= t.least && (t.most === undefined || value <= t.most) ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= t.least && (t.most === undefined || value <= t.most) ? value : undefined;
    case "oneOf":
      return typeof value === "string" && t.values.includes(value) ? value : undefined;
    case "yesNo":
      return typeof value === "boolean" ? value : undefined;
    case "text":
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
    case "texts":
      // An item that is no name is passed over; the rest of the list stands.
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  }
}

/**
 * A scope's settings, each read through its entry, from the merged config of the levels it is read
 * from. Each value passed over is logged once, with its key, the file that set it, and why. Exported
 * for the tests, which read an entry no group declares yet: one read from some levels alone.
 */
export class SettingsRead {
  readonly #levels: readonly LevelConfig[];
  readonly #log: Log | undefined;
  /** The merged config of each set of levels a setting is read from, by the set. */
  readonly #configs = new Map<string, { levels: readonly LevelConfig[]; config: JsonObject }>();
  readonly #passed = new Set<string>();

  constructor(levels: readonly LevelConfig[], log: Log | undefined) {
    this.#levels = levels;
    this.#log = log;
  }

  /** The value a level sets for the setting, where the setting takes it; undefined where no level sets one, or where the one set is passed over. */
  taken<D extends SettingEntry>(def: D, connection?: string): Taken<D> | undefined {
    const { levels, config } = this.#merged(def);
    // The key as the path of mappings a config file holds it at; a connection's name stays whole, dots and all.
    const path = def.key.split(".").map((part) => (part === CONNECTION && connection !== undefined ? connection : part));
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
    return this.#take(def, at, path, levels) as Taken<D> | undefined;
  }

  /** The setting's value: the one a level sets, where the setting takes it; else its default. */
  value<D extends SettingEntry>(def: D): Taken<D> | D["default"] {
    const taken = this.taken(def);
    return taken === undefined ? def.default : taken;
  }

  /**
   * The names or ids a setting set per connection is set under, as the files write them. Where its
   * key goes on past `<connection>`, only those holding a mapping: another value there is passed over.
   */
  named(def: SettingEntry): string[] {
    const { levels, config } = this.#merged(def);
    const parts = def.key.split(".");
    const before = parts.slice(0, parts.indexOf(CONNECTION));
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

  #take(def: SettingEntry, value: JsonValue, path: readonly string[], levels: readonly LevelConfig[]): JsonValue | undefined {
    const taken = takenValue(def, value);
    const key = path.join(".");
    if (taken === undefined) this.#pass(key, value, path, levels, `${key} takes ${takesWords(def)}, not ${JSON.stringify(value)}.`);
    return taken;
  }

  /** A value that is no mapping where the settings under its key are read: they are all at their defaults. */
  #notMapping(path: readonly string[], value: JsonValue, levels: readonly LevelConfig[]): void {
    const key = path.join(".");
    this.#pass(key, value, path, levels, `${key} holds the settings under it as a mapping of keys, not ${JSON.stringify(value)}.`);
  }

  #pass(key: string, value: JsonValue, path: readonly string[], levels: readonly LevelConfig[], why: string): void {
    if (this.#passed.has(key)) return;
    this.#passed.add(key);
    const file = levels.findLast((l) => decides(l.config, path))?.path ?? null;
    this.#log?.warn("A setting has a value it does not take; its default holds.", { setting: key, value, file, why });
  }
}

/** The settings a scope's config files give, each value read through its entry, over the defaults. */
function settingsFrom(levels: readonly LevelConfig[], log?: Log): Settings {
  const read = new SettingsRead(levels, log);
  /** A setting set per connection, as each connection it is set for takes it. */
  const byConnection = <D extends SettingEntry>(def: D): Record<string, Taken<D>> =>
    Object.fromEntries(
      read.named(def).flatMap((connection) => {
        const taken = read.taken(def, connection);
        return taken === undefined ? [] : [[connection, taken]];
      }),
    );

  // `~` lifts a limit that takes it: no value, no limit.
  const calls = read.value(LIMITS.calls);
  const tokensIn = read.value(LIMITS.tokensIn);
  const tokensOut = read.value(LIMITS.tokensOut);
  const seconds = read.value(LIMITS.time);
  const agents = read.value(LIMITS.agents);
  const judge = read.value(RULES.judge);
  const jobsPerDay = read.value(JOBS.perDay);
  const jobsPerRun = read.value(JOBS.perRun);
  const jobTokensPerDay = read.value(JOBS.tokensPerDay);
  const runCalls = read.value(JOBS.runCalls);
  const runIn = read.value(JOBS.runTokensIn);
  const runOut = read.value(JOBS.runTokensOut);
  const runSeconds = read.value(JOBS.runTime);
  // Every connection `jobs.connections` names with a mapping counts its jobs, a limit set or not.
  const jobConnections: Record<string, JobCounts> = {};
  for (const connection of read.named(JOBS.connectionAtOnce)) {
    const atOnce = read.taken(JOBS.connectionAtOnce, connection);
    const perDay = read.taken(JOBS.connectionPerDay, connection);
    jobConnections[connection] = { ...(atOnce !== undefined ? { atOnce } : {}), ...(perDay !== undefined && perDay !== null ? { perDay } : {}) };
  }

  return {
    turn: {
      ...(calls !== null ? { calls } : {}),
      ...(tokensIn !== null ? { tokensIn } : {}),
      ...(tokensOut !== null ? { tokensOut } : {}),
      ...(seconds !== null ? { time: seconds * 1000 } : {}),
    },
    subAgents: { depth: read.value(LIMITS.depth), ...(agents !== null ? { agents } : {}) },
    form: read.value(REPLY.form),
    forms: byConnection(REPLY.forms),
    streamAnyway: read.value(REPLY.streamAnyway),
    heldSentences: read.value(REPLY.heldSentences),
    tailSentences: read.value(REPLY.tailSentences),
    leadSampling: read.value(REPLY.leadSampling),
    intentWaitMs: read.value(REPLY.intentWait) * 1000,
    progress: read.value(REPLY.show),
    silenceMs: read.value(REPLY.silence) * 1000,
    clipChars: read.value(TOOLS.clip),
    searchHits: read.value(TOOLS.search),
    gapHits: read.value(TOOLS.gapCheck),
    perCall: read.value(TOOLS.perCall),
    schemaShown: read.value(TOOLS.schemaShown),
    ruleWindow: read.value(RULES.window),
    ...(judge !== null ? { judge } : {}),
    efforts: byConnection(MODELS.effort),
    requests: read.value(TRACE.requests),
    promptKept: read.value(TRACE.promptKept),
    compaction: {
      reserve: read.value(COMPACTION.reserve),
      keepTurns: read.value(COMPACTION.keepTurns),
      records: read.value(COMPACTION.records),
      saveCalls: read.value(COMPACTION.saveCalls),
    },
    jobs: {
      atOnce: read.value(JOBS.atOnce),
      ...(jobsPerDay !== null ? { perDay: jobsPerDay } : {}),
      ...(jobsPerRun !== null ? { perRun: jobsPerRun } : {}),
      ...(jobTokensPerDay !== null ? { tokensPerDay: jobTokensPerDay } : {}),
      cachedWeight: read.value(JOBS.cachedWeight),
      connections: jobConnections,
      run: {
        ...(runCalls !== null ? { calls: runCalls } : {}),
        ...(runIn !== null ? { tokensIn: runIn } : {}),
        ...(runOut !== null ? { tokensOut: runOut } : {}),
        ...(runSeconds !== null ? { time: runSeconds * 1000 } : {}),
      },
    },
  };
}

/** The defaults, where no level sets a value: the settings of no config file at all, so each default lives in its entry alone. */
export const DEFAULT_SETTINGS: Settings = settingsFrom([]);

/** The settings of a scope, as its config files set them over the defaults. */
export async function readSettings(guidance: Guidance, files: FilesPort, scope: Scope, log: Log): Promise<Settings> {
  return settingsFrom(await levelConfigs(guidance, files, scope, log), log);
}

/** The form a connection's reply takes, and whether a two-step connection streams anyway, by the connection's name or id. */
export function formFor(settings: Settings, connection: { id: string | null; name: string | null }): { form: ReplyFormSetting; stream: boolean } {
  const keys = [connection.id, connection.name].filter((key): key is string => key !== null);
  const named = keys.map((key) => settings.forms[key]).find((form) => form !== undefined);
  return { form: named ?? settings.form, stream: keys.some((key) => settings.streamAnyway.includes(key)) };
}

/** The effort the setting gives agents on a connection, by the connection's id or name; undefined where it names neither. */
export function effortFor(settings: Settings, connection: { id: string | null; name: string | null }): Effort | undefined {
  const key = [connection.id, connection.name].find((key) => key !== null && Object.hasOwn(settings.efforts, key));
  return key === undefined || key === null ? undefined : settings.efforts[key];
}

/** The user's counts for the jobs on one connection, under the setting's key that names it (its name or its id). */
export interface ConnectionCounts {
  key: string;
  counts: JobCounts;
}

/** The user's counts for the jobs on a connection, each by the setting's key that names it. */
export function jobCountsFor(settings: Settings, connection: { id: string | null; name: string | null }): ConnectionCounts[] {
  return [...new Set([connection.id, connection.name].filter((key): key is string => key !== null))].flatMap((key) => {
    const counts = settings.jobs.connections[key];
    return counts === undefined ? [] : [{ key, counts }];
  });
}
