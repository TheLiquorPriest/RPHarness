// The one list of every setting RPH reads (§5.4 "Config": the Settings page edits them as forms; §14;
// Appendix D.1). Each setting is declared once, in its group's module, and is read, typed and listed
// from there: read through its entry from a chat's config file over the global one, a value it does
// not take leaving its default, logged once with its key and its file; each has its name and its line
// from its group's words file. The config files are a host's, held in memory here; every name is invented.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkSettingValue, mergedConfig, SETTINGS } from "rp-harness/helpers";
import type { Effort, FilesPort, GapQuery, JsonObject, JsonValue, Layer, Log, Scope, Searcher, SettingDef } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import { DEFAULT_SETTINGS, GROUPS, listOf, readSettings, readSettingsOf, type Settings, SettingsRead } from "../../src/harness/settings";
import { type SettingEntry, type SettingWords, worded } from "../../src/harness/settings/entry";
import type { BaseToolsDeps } from "../../src/tools/base";
import { toolSearch, type ToolSearchDeps } from "../../src/tools/search";
import { bench as baseBench } from "../tools/base/support";
import { ctxOf, fixtureTools, bench as searchBench, standIn } from "../tools/search/support";

/** The folder of the list's groups, where each group's words file sits beside its module. */
const GROUP_FOLDER = join(import.meta.dir, "../../src/harness/settings");

const SCOPE: Scope = { user: "user-wren", chat: "chat-harbour", session: "s1" };
/** The connection a setting set per connection is set for here. */
const CONNECTION = "Harbour model";
const GLOBAL_FILE = "@global/config.yml";
const CHAT_FILE = "config.yml";
/** The levels as a host gives them, farthest first: the global level and the chat's have a config file. */
const LAYERS: Layer[] = [
  { level: "shipped", mount: "@shipped/", folders: {} },
  { level: "global", mount: "@global/", folders: {}, config: "config.yml" },
  { level: "character", mount: "@character/", folders: {} },
  { level: "chat", mount: "", folders: {}, config: "config.yml" },
];

/** A host's file port over the two config files, as text, and nothing else. */
function configFiles(texts: Readonly<Record<string, string>>): FilesPort {
  const elsewhere = (): never => {
    throw new Error("Reading settings asks the file port for its layers and its config files alone.");
  };
  return {
    layers: async () => LAYERS,
    read: async (_scope, path) => {
      const text = texts[path];
      if (text === undefined) return { status: "missing", path };
      const bytes = new TextEncoder().encode(text).byteLength;
      const lines = text.split("\n").length;
      return { status: "read", path, level: path === CHAT_FILE ? "chat" : "global", kind: "yours", text, start: 1, end: lines, lines, bytes, hash: new Bun.CryptoHasher("sha256").update(text).digest("hex"), modified: 0 };
    },
    places: elsewhere,
    find: elsewhere,
    write: elsewhere,
  };
}

/** A log that keeps, of each line about a value passed over, the key and the file it names. */
function recorder(): { log: Log; logged: { setting: JsonValue; file: JsonValue }[] } {
  const logged: { setting: JsonValue; file: JsonValue }[] = [];
  const quiet = (): void => {};
  return { logged, log: { debug: quiet, info: quiet, error: quiet, warn: (_message, fields) => logged.push({ setting: fields?.setting ?? null, file: fields?.file ?? null }) } };
}

/** The global and the chat config files, as JSON, which is YAML. */
function filesOf(configs: { global?: JsonObject; chat?: JsonObject }): FilesPort {
  return configFiles({ ...(configs.global !== undefined ? { [GLOBAL_FILE]: JSON.stringify(configs.global) } : {}), ...(configs.chat !== undefined ? { [CHAT_FILE]: JSON.stringify(configs.chat) } : {}) });
}

/** The settings a global and a chat config give, and what was logged of values passed over. */
async function settingsOf(configs: { global?: JsonObject; chat?: JsonObject }): Promise<{ settings: Settings; logged: { setting: JsonValue; file: JsonValue }[] }> {
  const { log, logged } = recorder();
  const files = filesOf(configs);
  return { settings: await readSettings(loadGuidance(files, SCOPE), files, SCOPE, log), logged };
}

/** A config that sets one setting, for `CONNECTION` where it is set per connection. */
function configWith(def: SettingDef, value: JsonValue): JsonObject {
  const path = def.key.split(".").map((part) => (part === "<connection>" ? CONNECTION : part));
  const config: JsonObject = {};
  let at = config;
  for (const part of path.slice(0, -1)) {
    const inner: JsonObject = {};
    at[part] = inner;
    at = inner;
  }
  at[path.at(-1)!] = value;
  return config;
}

/** Every entry RPH reads, as its group declares it, with where its value lands. */
const ENTRIES: readonly (SettingEntry & SettingWords)[] = GROUPS.flatMap((group) => Object.values(group));

/** A setting's value where its entry says it lands in what the reader returns, as a config file writes it: null for none. */
function shown(settings: object, entry: SettingEntry): JsonValue {
  let at: unknown = settings;
  for (const part of entry.at.split(".")) {
    const field = part === "<connection>" ? CONNECTION : part;
    at = typeof at === "object" && at !== null && Object.hasOwn(at, field) ? (at as Record<string, unknown>)[field] : undefined;
  }
  if (at === undefined) return null;
  return entry.ms === true ? (at as number) / 1000 : (at as JsonValue);
}

/** Two values the setting takes, the first not its default: one for the chat's file, the other for the global one. */
function takenValues(def: SettingDef): [JsonValue, JsonValue] {
  const t = def.takes;
  const values: JsonValue[] =
    t.type === "whole"
      ? [t.least, t.least + 1, t.least + 2]
      : t.type === "number"
        ? [t.least, t.most ?? t.least + 1, (t.least + (t.most ?? t.least + 1)) / 2]
        : t.type === "oneOf"
          ? [...t.values]
          : t.type === "yesNo"
            ? [true, false]
            : t.type === "text"
              ? ["Harbour judge", "Lantern judge"]
              : [["Harbour model"], ["Lantern model"]];
  const chat = values.find((value) => !Bun.deepEquals(value, def.default))!;
  return [chat, values.find((value) => !Bun.deepEquals(value, chat))!];
}

/** Values the setting does not take: `~` among them where it takes no `~`. */
function untakenValues(def: SettingDef): JsonValue[] {
  const t = def.takes;
  const wrong: JsonValue[] =
    t.type === "whole"
      ? [t.least - 1, t.least + 0.5, ...(t.most !== undefined ? [t.most + 1] : [])]
      : t.type === "number"
        ? [t.least - 1, ...(t.most !== undefined ? [t.most + 1] : [])]
        : t.type === "oneOf"
          ? ["none-such"]
          : t.type === "yesNo"
            ? ["yes"]
            : t.type === "text"
              ? ["   "]
              : ["Harbour model"];
  return def.orNone === true ? wrong : [...wrong, null];
}

test("every listed setting, set to a value it takes in a chat's file over the global one, is what readSettings returns; a value it does not take leaves its default with one log line naming the key and the file", async () => {
  expect(ENTRIES.map((entry) => entry.key)).toEqual(SETTINGS.map((def) => def.key));
  for (const def of ENTRIES) {
    expect({ key: def.key, perConnection: def.key.includes("<connection>") }).toEqual({ key: def.key, perConnection: def.perConnection });
    const key = def.key.replace("<connection>", CONNECTION);
    const [chat, global] = takenValues(def);
    // A setting read from some levels alone takes nothing from a file at another.
    const readsGlobal = def.levels === undefined || def.levels.includes("global");
    const readsChat = def.levels === undefined || def.levels.includes("chat");

    const fromGlobal = await settingsOf({ global: configWith(def, global) });
    expect({ key, value: shown(fromGlobal.settings, def) }).toEqual({ key, value: readsGlobal ? global : def.default });
    const over = await settingsOf({ global: configWith(def, global), chat: configWith(def, chat) });
    expect({ key, value: shown(over.settings, def), logged: over.logged }).toEqual({ key, value: readsChat ? chat : shown(fromGlobal.settings, def), logged: [] });
    if (def.orNone === true) {
      // `~` in the chat's file lifts what the global one sets.
      const lifted = await settingsOf({ global: configWith(def, global), chat: configWith(def, null) });
      expect({ key, value: shown(lifted.settings, def), logged: lifted.logged }).toEqual({ key, value: readsChat ? null : shown(fromGlobal.settings, def), logged: [] });
    }
    for (const value of untakenValues(def)) {
      const passed = await settingsOf({ chat: configWith(def, value) });
      expect({ key, set: value, value: shown(passed.settings, def), logged: passed.logged }).toEqual({ key, set: value, value: def.default, logged: readsChat ? [{ setting: key, file: CHAT_FILE }] : [] });
    }
  }
});

test("a setting added only to a group module (a fixture group) is read by readSettings, typed in Settings and shown, with no other file changed", async () => {
  // A group as a module declares one, here and nowhere else: its entries with where each lands, and its words file's lines.
  const LANTERN = worded(
    {
      wick: { key: "lantern.wick", takes: { type: "whole", least: 1 }, default: 2, perConnection: false, at: "lantern.wick" },
      burn: { key: "lantern.burn", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: "until it is put out", perConnection: false, at: "lantern.burnMs", ms: true },
      glow: { key: "lantern.glow.<connection>", takes: { type: "oneOf", values: ["dim", "bright"] }, default: null, none: "as the lantern burns", perConnection: true, at: "lantern.glow.<connection>" },
    },
    {
      "lantern.wick": { name: "Lantern wick", about: "How far the lantern's wick is turned up." },
      "lantern.burn": { name: "Lantern burn", about: "Seconds the lantern burns before it is put out." },
      "lantern.glow.<connection>": { name: "Lantern glow", about: "How brightly the lantern glows for one connection." },
    },
  );
  const groups = [...GROUPS, LANTERN] as const;
  const { log, logged } = recorder();
  const files = filesOf({ global: { lantern: { burn: 30 } }, chat: { lantern: { wick: 5, glow: { [CONNECTION]: "bright", "Lantern model": "smoky" } } } });
  const read = await readSettingsOf(groups, loadGuidance(files, SCOPE), files, SCOPE, log);

  // Typed: the compiler gives each new field the type its entry takes, so a reader that takes it wrongly does not build.
  const wick: number = read.lantern.wick;
  const burnMs: number | undefined = read.lantern.burnMs;
  const glow: "dim" | "bright" | undefined = read.lantern.glow[CONNECTION];
  expect({ wick, burnMs, glow, glows: read.lantern.glow }).toEqual({ wick: 5, burnMs: 30_000, glow: "bright", glows: { [CONNECTION]: "bright" } });
  // Checked: a value it does not take is passed over, with one line naming its key and its file.
  expect(logged).toEqual([{ setting: "lantern.glow.Lantern model", file: CHAT_FILE }]);
  // Every other setting reads as it did.
  const { lantern: _lantern, ...rest } = read;
  expect(rest).toEqual(DEFAULT_SETTINGS);
  // Shown: in the list a host reads, with its words, and without where the harness keeps it.
  expect(listOf(groups).filter((def) => def.key.startsWith("lantern."))).toEqual([
    { key: "lantern.wick", takes: { type: "whole", least: 1 }, default: 2, perConnection: false, name: "Lantern wick", about: "How far the lantern's wick is turned up." },
    { key: "lantern.burn", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: "until it is put out", perConnection: false, name: "Lantern burn", about: "Seconds the lantern burns before it is put out." },
    { key: "lantern.glow.<connection>", takes: { type: "oneOf", values: ["dim", "bright"] }, default: null, none: "as the lantern burns", perConnection: true, name: "Lantern glow", about: "How brightly the lantern glows for one connection." },
  ]);
  expect(SETTINGS.some((def) => def.key.startsWith("lantern."))).toBe(false);
});

/** `Settings` as its readers took it before the entries gave its shape: `turn.ts`, `jobs/`, `team.ts`, `judge.ts` and `means.ts` read it so. */
interface SettingsBefore {
  turn: { calls?: number; tokensIn?: number; tokensOut?: number; time?: number };
  subAgents: { depth: number; agents?: number };
  form: "tags" | "two-step";
  forms: Readonly<Record<string, "tags" | "two-step">>;
  streamAnyway: readonly string[];
  heldSentences: number;
  tailSentences: number;
  leadSampling: "own" | "preset";
  intentWaitMs: number;
  progress: "all" | "least";
  silenceMs: number;
  clipChars: number;
  searchHits: number;
  gapHits: number;
  perCall: number;
  schemaShown: number;
  ruleWindow: number;
  judge?: string;
  efforts: Readonly<Record<string, Effort>>;
  requests: "first" | "all" | "none";
  promptKept: number;
  liveBacklog: number;
  compaction: { reserve: number; keepTurns: number; records: number; saveCalls: number };
  jobs: {
    atOnce: number;
    perDay?: number;
    connections: Readonly<Record<string, { atOnce?: number; perDay?: number }>>;
    perRun?: number;
    tokensPerDay?: number;
    cachedWeight: number;
    run: { calls?: number; tokensIn?: number; tokensOut?: number; time?: number };
  };
}

/** Whether two types take each other's values. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Which fields of a type may be left out. */
type Optional<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? true : false };
/** Whether two types have the same fields, each as optional and of the same shape, all the way down. */
type SameShape<A, B> = [A] extends [readonly unknown[] | string | number | boolean | null | undefined]
  ? Same<A, B>
  : Same<keyof A, keyof B> extends true
    ? Same<Optional<A>, Optional<B>> extends true
      ? { [K in keyof A & keyof B]-?: SameShape<Exclude<A[K], undefined>, Exclude<B[K], undefined>> }[keyof A & keyof B] extends true
        ? true
        : false
      : false
    : false;

test("Settings, now made from the entries, keeps the shape its readers take, field for field", () => {
  // A field misnamed, moved, made optional or given another type by an entry fails the typecheck here.
  const same: SameShape<Settings, SettingsBefore> = true;
  expect(same).toBe(true);
  // And every field is there in what is read, the optional ones where a default gives them a value.
  expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(["clipChars", "compaction", "efforts", "form", "forms", "gapHits", "heldSentences", "intentWaitMs", "jobs", "leadSampling", "liveBacklog", "perCall", "progress", "promptKept", "requests", "ruleWindow", "schemaShown", "searchHits", "silenceMs", "streamAnyway", "subAgents", "tailSentences", "turn"]);
});

test("an entry is read from the levels it names alone: a chat's file sets nothing for one read from the shipped and global levels", () => {
  const wick: SettingEntry = { key: "lantern.wick", takes: { type: "whole", least: 1 }, default: 2, levels: ["shipped", "global"], perConnection: false, at: "lantern.wick" };
  const flame: SettingEntry = { key: "lantern.flame", takes: { type: "oneOf", values: ["low", "high"] }, default: "low", perConnection: false, at: "lantern.flame" };
  const read = recorder();
  const all = new SettingsRead(
    [
      { level: "shipped", path: "@shipped/config.yml", config: { lantern: { wick: 3 } } },
      { level: "global", path: GLOBAL_FILE, config: { lantern: { wick: 4, flame: "high" } } },
      { level: "chat", path: CHAT_FILE, config: { lantern: { wick: 0, flame: "low" } } },
    ],
    read.log,
  );
  // The chat's wick, one it would not take either, is not read at all: the global level's stands, and the line names the chat's file.
  expect(all.value(wick)).toBe(4);
  // Read from every level, the chat's value stands over the global one.
  expect(all.value(flame)).toBe("low");
  expect(read.logged).toEqual([{ setting: "lantern.wick", file: CHAT_FILE }]);
  // A value it does not take, at a level it is read from, is passed over, and the line names that level's file.
  const passed = recorder();
  const global = new SettingsRead([{ level: "global", path: GLOBAL_FILE, config: { lantern: { wick: 0 } } }], passed.log);
  expect(global.value(wick)).toBe(2);
  expect(passed.logged).toEqual([{ setting: "lantern.wick", file: GLOBAL_FILE }]);
});

test("a number among reply.streamAnyway's items and a chat-level value of a global-only setting each give one log line naming the key and the file, and the rest is read as before", async () => {
  const LANTERN = worded(
    { wick: { key: "lantern.wick", takes: { type: "whole", least: 1 }, default: 2, levels: ["global"], perConnection: false, at: "lantern.wick" } },
    { "lantern.wick": { name: "Lantern wick", about: "How far the lantern's wick is turned up." } },
  );
  const global: JsonObject = { lantern: { wick: 4 }, reply: { streamAnyway: ["Lantern model"] }, limits: { turn: { calls: 12 } } };
  // Two items that are not text go in the one line.
  const chat: JsonObject = { lantern: { wick: 9 }, reply: { streamAnyway: ["Harbour model", 5, null, "Lantern model"] }, limits: { turn: { tokensOut: 900 } } };
  const files = filesOf({ global, chat });
  const { log, logged } = recorder();
  const read = await readSettingsOf([...GROUPS, LANTERN] as const, loadGuidance(files, SCOPE), files, SCOPE, log);
  expect(logged).toEqual([
    { setting: "reply.streamAnyway", file: CHAT_FILE },
    { setting: "lantern.wick", file: CHAT_FILE },
  ]);
  // The rest is read as before: the list's names, the global level's wick, and every other value either file sets.
  expect({ streamAnyway: read.streamAnyway, wick: read.lantern.wick, turn: read.turn }).toEqual({ streamAnyway: ["Harbour model", "Lantern model"], wick: 4, turn: { calls: 12, tokensOut: 900 } });
  const { lantern: _lantern, streamAnyway: _streamAnyway, turn: _turn, ...rest } = read;
  const { streamAnyway: _defaultList, turn: _defaultTurn, ...defaults } = DEFAULT_SETTINGS;
  expect(rest).toEqual(defaults);
});

test("every listed setting has a name and a line on what it is for, and every line of a words file belongs to a listed setting", async () => {
  for (const def of SETTINGS) {
    for (const words of [def.name, def.about]) expect({ key: def.key, words, oneLine: typeof words === "string" && words.trim() !== "" && !words.includes("\n") }).toMatchObject({ key: def.key, oneLine: true });
  }
  // Two settings called alike would be one row twice to the owner.
  expect(new Set(SETTINGS.map((def) => def.name)).size).toBe(SETTINGS.length);

  // Each words file holds lines for listed settings and nothing else; the lines of all of them are the list's words, one each.
  // The files are found by name and imported as found, so a group's words file added later is held to this too.
  const lines: [string, unknown][] = [];
  const files = [...new Bun.Glob("*-words.ts").scanSync(GROUP_FOLDER)].sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const module: Record<string, unknown> = await import(join(GROUP_FOLDER, file));
    for (const [name, exported] of Object.entries(module)) {
      expect({ file, name, lines: typeof exported === "object" && exported !== null && !Array.isArray(exported) }).toEqual({ file, name, lines: true });
      for (const [key, line] of Object.entries(exported as object)) lines.push([key, line]);
    }
  }
  const listed = new Map(SETTINGS.map((def) => [def.key, { name: def.name, about: def.about }]));
  for (const [key, line] of lines) expect({ key, listed: listed.has(key), line }).toEqual({ key, listed: true, line: listed.get(key) });
  expect(lines.map(([key]) => key).sort()).toEqual([...listed.keys()].sort());
});

test("the exported merge is the one readSettings reads by: a chat's value over a global one, mappings merged key by key, a value that is not a mapping replacing one that is", async () => {
  const global: JsonObject = { limits: { turn: { calls: 12, depth: 1 } }, reply: { forms: { "Harbour model": "two-step" } }, jobs: { connections: { "Harbour model": { atOnce: 1 } }, run: { calls: 30, time: 600 } } };
  const chat: JsonObject = { limits: { turn: { calls: 8 } }, reply: { forms: { "Lantern model": "tags" } }, jobs: { connections: { "Lantern model": { perDay: 4 } }, run: 5 } };
  const merged = mergedConfig(global, chat);
  expect(merged).toEqual({
    limits: { turn: { calls: 8, depth: 1 } },
    reply: { forms: { "Harbour model": "two-step", "Lantern model": "tags" } },
    jobs: { connections: { "Harbour model": { atOnce: 1 }, "Lantern model": { perDay: 4 } }, run: 5 },
  });
  // A mapping over a value that is not one replaces it whole as well; and the merge changes neither config it is given.
  expect(mergedConfig({ jobs: { run: 5 } }, { jobs: { run: { calls: 9 } } })).toEqual({ jobs: { run: { calls: 9 } } });
  expect(global.jobs).toEqual({ connections: { "Harbour model": { atOnce: 1 } }, run: { calls: 30, time: 600 } });

  // The two files read as levels give, setting by setting, what the one file the merge makes gives.
  const levels = await settingsOf({ global, chat });
  expect(levels.settings).toEqual((await settingsOf({ chat: merged })).settings);
  expect(levels.settings.turn.calls).toBe(8);
  expect(levels.settings.subAgents.depth).toBe(1);
  expect(levels.settings.forms).toEqual({ "Harbour model": "two-step", "Lantern model": "tags" });
  expect(levels.settings.jobs.connections).toEqual({ "Harbour model": { atOnce: 1 }, "Lantern model": { perDay: 4 } });
  // The chat's `run: 5` stands in place of the global mapping and is passed over: the run's limits are at their defaults.
  expect(levels.settings.jobs.run).toEqual(DEFAULT_SETTINGS.jobs.run);
  expect(levels.logged).toEqual([{ setting: "jobs.run", file: CHAT_FILE }]);
});

test("progress.silence takes no value past nine minutes: 600 in a chat's file leaves the default with one log line naming the key and the file", async () => {
  // §10.7: a generation that sends no text for ten minutes is ended, so a progress line must come inside them.
  const past = await settingsOf({ global: { progress: { silence: 120 } }, chat: { progress: { silence: 600 } } });
  expect(past.settings.silenceMs).toBe(DEFAULT_SETTINGS.silenceMs);
  expect(past.logged).toEqual([{ setting: "progress.silence", file: CHAT_FILE }]);
  // Nine minutes is the most it takes.
  const most = await settingsOf({ global: { progress: { silence: 120 } }, chat: { progress: { silence: 540 } } });
  expect({ silenceMs: most.settings.silenceMs, logged: most.logged }).toEqual({ silenceMs: 540_000, logged: [] });
  expect(SETTINGS.find((def) => def.key === "progress.silence")?.takes).toEqual({ type: "whole", least: 1, most: 540 });
});

test("changing an entry's default changes what the tool uses; no source but the entry holds the old values", async () => {
  // The groups as they would read with these five defaults changed in their modules, and nothing else.
  const CHANGED: Readonly<Record<string, number>> = { "tools.search": 3, "tools.gapCheck": 2, "reply.heldSentences": 2, "reply.tailSentences": 5, "progress.silence": 30 };
  const changed = GROUPS.map((group) => Object.fromEntries(Object.entries(group).map(([name, entry]) => [name, Object.hasOwn(CHANGED, entry.key) ? { ...entry, default: CHANGED[entry.key]! } : entry])));
  const files = filesOf({});
  // The same entries with other defaults, so what they read has RPH's settings' shape.
  const settings = (await readSettingsOf(changed, loadGuidance(files, SCOPE), files, SCOPE, recorder().log)) as unknown as Settings;
  expect({ searchHits: settings.searchHits, gapHits: settings.gapHits, heldSentences: settings.heldSentences, tailSentences: settings.tailSentences, silenceMs: settings.silenceMs }).toEqual({ searchHits: 3, gapHits: 2, heldSentences: 2, tailSentences: 5, silenceMs: 30_000 });

  // tool_search shows that many of the six tools its words find, and gap_check asks each place for that many, as a turn gives them.
  const search = await searchBench();
  try {
    const result = await toolSearch(search.deps(standIn(fixtureTools([])), { hits: settings.searchHits })).run({ words: "weather money maps" }, ctxOf());
    const details = result.details;
    const found = typeof details === "object" && details !== null && !Array.isArray(details) ? details["found"] : undefined;
    expect(Array.isArray(found) ? found.length : found).toBe(3);
  } finally {
    await search.close();
  }
  const base = await baseBench();
  try {
    const asked: GapQuery[] = [];
    const story: Searcher = { name: "story", search: async (_scope, query) => (asked.push(query), []) };
    await base.call("gap_check", { topic: "drowned bell" }, { extra: { env: { ...base.host, searchers: [story] }, gapHits: settings.gapHits } });
    expect(asked.map((query) => query.limit)).toEqual([2]);
  } finally {
    await base.close();
  }

  // No constant of the reply's or the tools' own holds the old values any longer...
  const src = join(import.meta.dir, "../../src");
  for (const file of new Bun.Glob("**/*.ts").scanSync(src)) {
    const text = await Bun.file(join(src, file)).text();
    expect({ file, names: ["REPLY_DEFAULTS", "SEARCH_HITS", "GAP_HITS"].filter((name) => text.includes(name)) }).toEqual({ file, names: [] });
  }
  // ...and neither tool has a count to fall back on: one made without the user's does not build.
  // @ts-expect-error: tool search is given the user's `tools.search`, and has no count of its own.
  ({}) as Omit<ToolSearchDeps, "hits"> satisfies ToolSearchDeps;
  // @ts-expect-error: gap_check is given the user's `tools.gapCheck`, and has no count of its own.
  ({}) as Omit<BaseToolsDeps, "gapHits"> satisfies BaseToolsDeps;
});

test("for every entry of SETTINGS, its default is a value it takes", () => {
  for (const def of SETTINGS) {
    // A default that is none is `~`, which a level may write too, and says what none means.
    expect({ key: def.key, check: checkSettingValue(def, def.default) }).toEqual({ key: def.key, check: { ok: true, value: def.default } });
    if (def.default === null) expect({ key: def.key, none: typeof def.none === "string" && def.none.trim() !== "" }).toEqual({ key: def.key, none: true });
  }
});

test("a chat's `limits.turn.tokensIn: ~` over a global 50,000 leaves that chat's turns with no tokens-in limit, and the global value holds for other chats", async () => {
  const lifted = await settingsOf({ global: { limits: { turn: { tokensIn: 50_000 } } }, chat: { limits: { turn: { tokensIn: null } } } });
  expect({ turn: lifted.settings.turn, logged: lifted.logged }).toEqual({ turn: { calls: 40 }, logged: [] });
  // Another chat, whose file lifts nothing, is held to the global limit.
  const other = await settingsOf({ global: { limits: { turn: { tokensIn: 50_000 } } }, chat: { limits: { turn: { calls: 30 } } } });
  expect(other.settings.turn).toEqual({ calls: 30, tokensIn: 50_000 });

  // So for every setting whose default is none: the chat's `~` lifts the global value, for that chat alone.
  const globals: Readonly<Record<string, JsonValue>> = {
    "limits.turn.tokensIn": 50_000,
    "limits.turn.tokensOut": 8_000,
    "limits.turn.time": 600,
    "jobs.connections.<connection>.atOnce": 1,
    "effort.connections.<connection>": "high",
    "rules.judge": "Lantern judge",
    "reply.forms.<connection>": "two-step",
  };
  for (const [key, global] of Object.entries(globals)) {
    const entry = ENTRIES.find((listed) => listed.key === key)!;
    const chat = await settingsOf({ global: configWith(entry, global), chat: configWith(entry, null) });
    const others = await settingsOf({ global: configWith(entry, global) });
    expect({ key, chat: shown(chat.settings, entry), logged: chat.logged, others: shown(others.settings, entry) }).toEqual({ key, chat: null, logged: [], others: global });
  }
  // Those are all the settings whose default is none and which took no `~` before.
  expect(SETTINGS.filter((def) => def.default === null && !Object.hasOwn(globals, def.key)).map((def) => def.key)).toEqual(["jobs.perDay", "jobs.connections.<connection>.perDay"]);
});

test("the exported check and readSettings take and refuse the same values for every entry, on a sample of good and bad values", async () => {
  const SAMPLE: JsonValue[] = [-1, 0, 1, 2, 0.5, 540, 541, 1e9, "tags", "two-step", "own", "high", "first", "all", "Lantern judge", " padded ", "", "  ", true, false, null, [], ["Harbour model"], ["Harbour model", 5], [" "], [null, "Lantern model"], {}, { atOnce: 1 }];
  const quiet = (): void => {};
  for (const def of ENTRIES) {
    const key = def.key.replace("<connection>", CONNECTION);
    for (const value of [...takenValues(def), ...untakenValues(def), ...SAMPLE]) {
      const check = checkSettingValue(def, value, def.perConnection ? CONNECTION : undefined);
      const lines: { setting: JsonValue; file: JsonValue; why: JsonValue }[] = [];
      const files = filesOf({ chat: configWith(def, value) });
      const settings = await readSettings(loadGuidance(files, SCOPE), files, SCOPE, { debug: quiet, info: quiet, error: quiet, warn: (_message, fields) => lines.push({ setting: fields?.setting ?? null, file: fields?.file ?? null, why: fields?.why ?? null }) });
      // Taken, the value as the check gives it is read; refused, the reader passes it over with the check's own reason, keeping what the check keeps.
      const read = check.ok ? check.value : (check.kept ?? def.default);
      expect({ key, value, read: shown(settings, def), lines }).toEqual({ key, value, read, lines: check.ok ? [] : [{ setting: key, file: CHAT_FILE, why: check.why }] });
    }
  }
});
