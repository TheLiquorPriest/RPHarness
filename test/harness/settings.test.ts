// The one list of every setting RPH reads (§5.4 "Config": the Settings page edits them as forms; §14;
// Appendix D.1). Each setting is declared once, in its group's module, with its line in the group's
// words file, and is read, typed, listed and checked from there: read through its entry from a chat's
// config file over the global one, a value it does not take leaving its default, logged once with its
// key and its file. The rules below are held over the entries as they are, so a setting added to a
// group needs no line in this file; the fixture group proves it. The config files are a host's, held
// in memory here; every name is invented.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkSettingValue, mergedConfig, SETTINGS } from "rp-harness/helpers";
import type { FilesPort, GapQuery, JsonObject, JsonValue, Layer, Log, Scope, Searcher, SettingDef } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import { callTerms, DEFAULT_SETTINGS, formFor, GROUPS, jobCountsFor, listOf, readSettings, readSettingsOf, type Settings, SettingsRead } from "../../src/harness/settings";
import { type Group, type SettingEntry, type SettingWords, worded } from "../../src/harness/settings/entry";
import { MODELS } from "../../src/harness/settings/models";
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

/** A line the reader logged of a value passed over, whole. */
interface Said {
  message: string;
  setting: JsonValue;
  file: JsonValue;
  why: JsonValue;
}

/** A log that keeps, of each line about a value passed over, the key and the file it names, and each line whole. */
function recorder(): { log: Log; logged: { setting: JsonValue; file: JsonValue }[]; said: Said[] } {
  const logged: { setting: JsonValue; file: JsonValue }[] = [];
  const said: Said[] = [];
  const quiet = (): void => {};
  const warn = (message: string, fields?: Record<string, JsonValue>): void => {
    logged.push({ setting: fields?.setting ?? null, file: fields?.file ?? null });
    said.push({ message, setting: fields?.setting ?? null, file: fields?.file ?? null, why: fields?.why ?? null });
  };
  return { logged, said, log: { debug: quiet, info: quiet, error: quiet, warn } };
}

/** The global and the chat config files, as JSON, which is YAML. */
function filesOf(configs: { global?: JsonObject; chat?: JsonObject }): FilesPort {
  return configFiles({ ...(configs.global !== undefined ? { [GLOBAL_FILE]: JSON.stringify(configs.global) } : {}), ...(configs.chat !== undefined ? { [CHAT_FILE]: JSON.stringify(configs.chat) } : {}) });
}

/** What some groups read from a global and a chat config, and what was logged of values passed over. */
async function readOf(groups: readonly Group[], configs: { global?: JsonObject; chat?: JsonObject }): Promise<{ settings: object; logged: { setting: JsonValue; file: JsonValue }[]; said: Said[] }> {
  const { log, logged, said } = recorder();
  const files = filesOf(configs);
  return { settings: await readSettingsOf(groups, loadGuidance(files, SCOPE), files, SCOPE, log), logged, said };
}

/** The settings RPH reads from a global and a chat config, and what was logged of values passed over. */
async function settingsOf(configs: { global?: JsonObject; chat?: JsonObject }): Promise<{ settings: Settings; logged: { setting: JsonValue; file: JsonValue }[]; said: Said[] }> {
  const { log, logged, said } = recorder();
  const files = filesOf(configs);
  return { settings: await readSettings(loadGuidance(files, SCOPE), { files, log }, SCOPE), logged, said };
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

/** Every entry some groups declare, with where its value lands. */
function entriesOf(groups: readonly Group[]): (SettingEntry & SettingWords)[] {
  return groups.flatMap((group) => Object.values(group));
}

/** Every entry RPH reads, as its group declares it, with where its value lands. */
const ENTRIES = entriesOf(GROUPS);

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

/** Whether a setting is read from a level's file. */
const readsAt = (def: SettingDef, level: "global" | "chat"): boolean => def.levels === undefined || def.levels.includes(level);

/** Two values the setting takes, the first not its default: one for the chat's file, the other for the global one. */
function takenValues(def: SettingDef): [JsonValue, JsonValue] {
  const t = def.takes;
  const values: JsonValue[] =
    t.type === "whole"
      ? [t.least, t.least + 1, t.least + 2]
      : t.type === "number"
        ? [t.least ?? 0, t.most ?? (t.least ?? 0) + 1, ((t.least ?? 0) + (t.most ?? (t.least ?? 0) + 1)) / 2]
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
        ? [...(t.least !== undefined ? [t.least - 1] : []), ...(t.most !== undefined ? [t.most + 1] : []), Number.NaN]
        : t.type === "oneOf"
          ? ["none-such"]
          : t.type === "yesNo"
            ? ["yes"]
            : t.type === "text"
              ? ["   "]
              : ["Harbour model"];
  return def.orNone === true ? wrong : [...wrong, null];
}

/**
 * Where each setting's value lands in `Settings`, the field its readers read (`turn.ts`, `jobs/`,
 * `team.ts`, `judge.ts`, `means.ts`), with its unit where seconds are kept as milliseconds: frozen as
 * PlanHarnessCore-7 landed it. Only a deliberate change rewrites a line, a field moved; a setting
 * added needs none, and one taken away in its group's files fails nothing here. A field renamed by
 * accident, or two swapped, fails against it under `bun test`, as the readers' own code fails the typecheck.
 */
const LANDED: Readonly<Record<string, string>> = {
  "limits.turn.calls": "turn.calls",
  "limits.turn.tokensIn": "turn.tokensIn",
  "limits.turn.tokensOut": "turn.tokensOut",
  "limits.turn.seconds": "turn.time ms",
  "limits.turn.depth": "subAgents.depth",
  "limits.turn.agents": "subAgents.agents",
  "jobs.atOnce": "jobs.atOnce",
  "jobs.perDay": "jobs.perDay",
  "jobs.perRun": "jobs.perRun",
  "jobs.tokensPerDay": "jobs.tokensPerDay",
  "connections.<connection>.jobs.atOnce": "jobs.byConnection.<connection>.atOnce",
  "connections.<connection>.jobs.perDay": "jobs.byConnection.<connection>.perDay",
  "jobs.run.calls": "jobs.run.calls",
  "jobs.run.tokensIn": "jobs.run.tokensIn",
  "jobs.run.tokensOut": "jobs.run.tokensOut",
  "jobs.run.seconds": "jobs.run.timeMs ms",
  "calls.silentAfterSeconds": "model.silentAfter ms",
  "calls.providerWaitSeconds": "model.providerWait ms",
  "calls.signInOpenSeconds": "model.signInOpen ms",
  "calls.testRoomTokens": "model.testRoom",
  "calls.maxModelListMiB": "model.listMost",
  "calls.quotedChars": "model.quoted",
  "calls.signInWordsKeptSeconds": "model.signInWordsKept ms",
  "calls.maxFailureChars": "model.wordsMost",
  "calls.retryWaitSeconds": "model.retryWait ms",
  "calls.retries": "model.retries",
  "calls.cacheRetention": "model.cacheRetention",
  "calls.toolRefusalMinutes": "model.toolRefusalMinutes",
  "reply.form": "form",
  "connections.<connection>.reply.form": "forms.<connection>",
  "reply.streamAnyway": "streamAnyway",
  "reply.heldSentences": "heldSentences",
  "reply.tailSentences": "tailSentences",
  "reply.leadSampling": "leadSampling",
  "progress.show": "progress",
  "progress.silenceSeconds": "silenceMs ms",
  "results.clipChars": "clipChars",
  "tools.search": "searchHits",
  "tools.gap.hits": "gapHits",
  "tools.perCall": "perCall",
  "tools.schemaShownChars": "schemaShown",
  "rules.windowChars": "ruleWindow",
  "rules.judge": "judge",
  "trace.requests": "requests",
  "prompt.kept": "promptKept",
  "live.backlog": "liveBacklog",
  "compaction.reserveTokens": "compaction.reserveTokens",
  "compaction.keepTurns": "compaction.keepTurns",
  "compaction.recordsTokens": "compaction.recordsTokens",
  "compaction.saveCalls": "compaction.saveCalls",
};

// ---------------------------------------------------------------- the rules, held over whatever the groups declare

/** Every entry, set to a value it takes in a chat's file over the global one, is what is read; a value it does not take, or one set where it is not read, leaves it with one line naming the key and the file. */
async function holdsEveryEntry(groups: readonly Group[]): Promise<void> {
  for (const def of entriesOf(groups)) {
    expect({ key: def.key, perConnection: def.key.includes("<connection>") }).toEqual({ key: def.key, perConnection: def.perConnection });
    const key = def.key.replace("<connection>", CONNECTION);
    const [chat, global] = takenValues(def);
    // A value in the chat's file of a setting not read there is passed over, with a line naming that file.
    const unread = readsAt(def, "chat") ? [] : [{ setting: key, file: CHAT_FILE }];

    const fromGlobal = await readOf(groups, { global: configWith(def, global) });
    expect({ key, value: shown(fromGlobal.settings, def) }).toEqual({ key, value: readsAt(def, "global") ? global : def.default });
    const over = await readOf(groups, { global: configWith(def, global), chat: configWith(def, chat) });
    expect({ key, value: shown(over.settings, def), logged: over.logged }).toEqual({ key, value: readsAt(def, "chat") ? chat : shown(fromGlobal.settings, def), logged: unread });
    if (def.orNone === true) {
      // `~` in the chat's file lifts what the global one sets.
      const lifted = await readOf(groups, { global: configWith(def, global), chat: configWith(def, null) });
      expect({ key, value: shown(lifted.settings, def), logged: lifted.logged }).toEqual({ key, value: readsAt(def, "chat") ? null : shown(fromGlobal.settings, def), logged: unread });
    }
    for (const value of untakenValues(def)) {
      const passed = await readOf(groups, { chat: configWith(def, value) });
      expect({ key, set: value, value: shown(passed.settings, def), logged: passed.logged }).toEqual({ key, set: value, value: def.default, logged: [{ setting: key, file: CHAT_FILE }] });
    }
  }
}

/** Every entry's default is a value it takes; one that is none is `~`, which it takes, and says what none means. */
function holdsDefaults(groups: readonly Group[]): void {
  for (const def of listOf(groups)) {
    expect({ key: def.key, check: checkSettingValue(def, def.default) }).toEqual({ key: def.key, check: { ok: true, value: def.default } });
    if (def.default === null) expect({ key: def.key, none: typeof def.none === "string" && def.none.trim() !== "" }).toEqual({ key: def.key, none: true });
  }
}

/** For every entry whose default is none: a chat's `~` lifts the global value for that chat alone, where the chat's file is read, and the global value holds for other chats. */
async function holdsNoneLifted(groups: readonly Group[]): Promise<void> {
  for (const def of entriesOf(groups).filter((entry) => entry.default === null)) {
    const key = def.key.replace("<connection>", CONNECTION);
    const [, global] = takenValues(def);
    const held = readsAt(def, "global") ? global : null;
    const chat = await readOf(groups, { global: configWith(def, global), chat: configWith(def, null) });
    const others = await readOf(groups, { global: configWith(def, global) });
    expect({ key, chat: shown(chat.settings, def), logged: chat.logged, others: shown(others.settings, def) }).toEqual({
      key,
      chat: readsAt(def, "chat") ? null : held,
      logged: readsAt(def, "chat") ? [] : [{ setting: key, file: CHAT_FILE }],
      others: held,
    });
  }
}

/** The exported check and the reader take and refuse the same values, on a sample of good and bad values, with the check's own reason. */
async function holdsAgreement(groups: readonly Group[]): Promise<void> {
  const SAMPLE: JsonValue[] = [-1, 0, 1, 2, 0.5, 540, 541, 1e9, "tags", "two-step", "own", "high", "first", "all", "Lantern judge", " padded ", "", "  ", true, false, null, [], ["Harbour model"], ["Harbour model", 5], [" "], [null, "Lantern model"], {}, { atOnce: 1 }];
  for (const def of entriesOf(groups)) {
    const key = def.key.replace("<connection>", CONNECTION);
    // Set in a file the setting is read from.
    const level = readsAt(def, "chat") ? "chat" : "global";
    for (const value of [...takenValues(def), ...untakenValues(def), ...SAMPLE]) {
      const check = checkSettingValue(def, value, def.perConnection ? CONNECTION : undefined);
      const read = await readOf(groups, { [level]: configWith(def, value) });
      // Taken, the value as the check gives it is read; refused, the reader passes it over with the check's own reason, keeping what the check keeps.
      const expected = check.ok ? check.value : (check.kept ?? def.default);
      const lines = read.said.map(({ setting, file, why }) => ({ setting, file, why }));
      expect({ key, value, read: shown(read.settings, def), lines }).toEqual({ key, value, read: expected, lines: check.ok ? [] : [{ setting: key, file: level === "chat" ? CHAT_FILE : GLOBAL_FILE, why: check.why }] });
    }
  }
}

/** Every setting the record names that a group still lists lands in the field the record names, in its unit. */
function holdsLandings(groups: readonly Group[]): void {
  const lands = new Map(entriesOf(groups).map((entry) => [entry.key, `${entry.at}${entry.ms === true ? " ms" : ""}`]));
  for (const [key, landed] of Object.entries(LANDED)) if (lands.has(key)) expect({ key, lands: lands.get(key) }).toEqual({ key, lands: landed });
}

// ---------------------------------------------------------------- the list

test("every listed setting, set to a value it takes in a chat's file over the global one, is what readSettings returns; a value it does not take leaves its default with one log line naming the key and the file", async () => {
  expect(ENTRIES.map((entry) => entry.key)).toEqual(SETTINGS.map((def) => def.key));
  await holdsEveryEntry(GROUPS);
});

test("every setting a reader reads still lands in the field it reads, in its unit, as the record of landings says; a setting added needs no line there", () => {
  holdsLandings(GROUPS);
});

test("a setting added only to a group module (a fixture group) is read by readSettings, typed in Settings and shown, with no other file changed", async () => {
  // A group as a module declares one, here and nowhere else: its entries with where each lands, and its words file's lines.
  const LANTERN = worded(
    {
      wick: { key: "lantern.wick", takes: { type: "whole", least: 1 }, default: 2, perConnection: false, at: "lantern.wick" },
      burn: { key: "lantern.burn", takes: { type: "whole", least: 1 }, default: null, orNone: true, none: "until it is put out", perConnection: false, at: "lantern.burnMs", ms: true },
      glow: { key: "lantern.glow.<connection>", takes: { type: "oneOf", values: ["dim", "bright"] }, default: null, orNone: true, none: "as the lantern burns", perConnection: true, at: "lantern.glow.<connection>" },
      keeper: { key: "lantern.keeper", takes: { type: "text" }, default: null, orNone: true, none: "whoever is on watch", perConnection: false, levels: ["shipped", "global"], at: "lanternKeeper" },
    },
    {
      "lantern.wick": { name: "Lantern wick", about: "How far the lantern's wick is turned up." },
      "lantern.burn": { name: "Lantern burn", about: "Seconds the lantern burns before it is put out." },
      "lantern.glow.<connection>": { name: "Lantern glow", about: "How brightly the lantern glows for one connection." },
      "lantern.keeper": { name: "Lantern keeper", about: "Who keeps the lantern, set in the global file alone." },
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
    { key: "lantern.glow.<connection>", takes: { type: "oneOf", values: ["dim", "bright"] }, default: null, orNone: true, none: "as the lantern burns", perConnection: true, name: "Lantern glow", about: "How brightly the lantern glows for one connection." },
    { key: "lantern.keeper", takes: { type: "text" }, default: null, orNone: true, none: "whoever is on watch", perConnection: false, levels: ["shipped", "global"], name: "Lantern keeper", about: "Who keeps the lantern, set in the global file alone." },
  ]);
  expect(SETTINGS.some((def) => def.key.startsWith("lantern."))).toBe(false);

  // And every rule this file holds the list to holds for the group added, with no line of this file changed for it.
  await holdsEveryEntry(groups);
  holdsDefaults(groups);
  await holdsNoneLifted(groups);
  await holdsAgreement(groups);
  holdsLandings(groups);
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
  // The chat's wick, one it would not take either, is not read at all: the global level's stands, and the line names the chat's file and the levels it is read from.
  expect(all.value(wick)).toBe(4);
  // Read from every level, the chat's value stands over the global one.
  expect(all.value(flame)).toBe("low");
  expect(read.said.map(({ setting, file, why }) => ({ setting, file, why }))).toEqual([{ setting: "lantern.wick", file: CHAT_FILE, why: "lantern.wick is read from the shipped and global files alone, not from the chat file." }]);
  // A value it does not take, at a level it is read from, is passed over, and the line names that level's file.
  const passed = recorder();
  const global = new SettingsRead([{ level: "global", path: GLOBAL_FILE, config: { lantern: { wick: 0 } } }], passed.log);
  expect(global.value(wick)).toBe(2);
  expect(passed.logged).toEqual([{ setting: "lantern.wick", file: GLOBAL_FILE }]);
  // Read from one level, the line says so; set per connection, it names the connection's key, as the line's setting does.
  const glow: SettingEntry = { key: "lantern.glow.<connection>", takes: { type: "oneOf", values: ["dim", "bright"] }, default: null, orNone: true, none: "as the lantern burns", levels: ["global"], perConnection: true, at: "lantern.glow.<connection>" };
  const one = recorder();
  const perConnection = new SettingsRead([{ level: "chat", path: CHAT_FILE, config: { lantern: { glow: { [CONNECTION]: "dim" } } } }], one.log);
  expect(perConnection.named(glow)).toEqual([]);
  expect(one.said.map(({ setting, why }) => ({ setting, why }))).toEqual([{ setting: "lantern.glow.Harbour model", why: "lantern.glow.Harbour model is read from the global file alone, not from the chat file." }]);
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

test("a list of names with a blank item: the reader logs it once, naming the key and the file, and reads the other names; the check refuses the list as written", async () => {
  // A blank name names nothing, as an empty one does.
  const list = ["Harbour model", " ", "", "Lantern model"];
  const read = await settingsOf({ global: { reply: { streamAnyway: ["Tide model"] } }, chat: { reply: { streamAnyway: list } } });
  expect({ streamAnyway: read.settings.streamAnyway, logged: read.logged }).toEqual({ streamAnyway: ["Harbour model", "Lantern model"], logged: [{ setting: "reply.streamAnyway", file: CHAT_FILE }] });
  // A page checks the list with the same function before writing it, and refuses it, saying what is wrong with it and nothing of what a reader does.
  const check = checkSettingValue(SETTINGS.find((def) => def.key === "reply.streamAnyway")!, list);
  expect(check).toEqual({ ok: false, why: 'reply.streamAnyway takes a list of names, and " ", "" are not names.', kept: ["Harbour model", "Lantern model"] });
  // The reader's own line is what says the rest of the list is read.
  expect(read.said.map(({ message, why }) => ({ message, why }))).toEqual([{ message: "A setting's list has items that are not names; they are passed over, and the rest is read.", why: check.ok ? null : check.why }]);
});

test("a number JSON cannot write is named as itself in a reason: NaN for a setting, Infinity for a mapping of settings", async () => {
  const silence = SETTINGS.find((def) => def.key === "progress.silenceSeconds")!;
  expect(checkSettingValue(silence, Number.NaN)).toEqual({ ok: false, why: "progress.silenceSeconds takes a whole number from 1 to 540, not NaN." });
  // As a config file writes them, in YAML's own words.
  const { log, said } = recorder();
  const files = configFiles({ [CHAT_FILE]: "progress:\n  silenceSeconds: .nan\nlimits: .inf\n" });
  const settings = await readSettings(loadGuidance(files, SCOPE), { files, log }, SCOPE);
  expect({ silenceMs: settings.silenceMs, turn: settings.turn }).toEqual({ silenceMs: DEFAULT_SETTINGS.silenceMs, turn: DEFAULT_SETTINGS.turn });
  expect(said.map(({ setting, why }) => ({ setting, why }))).toEqual([
    { setting: "limits", why: "limits holds the settings under it as a mapping of keys, not Infinity." },
    { setting: "progress.silenceSeconds", why: "progress.silenceSeconds takes a whole number from 1 to 540, not NaN." },
  ]);
});

test("a connection named like an object's own fields gets no form or counts but what the files give it: each connection map holds connections' names alone", async () => {
  const { settings } = await settingsOf({ global: { connections: { [CONNECTION]: { reply: { form: "two-step" } } } } });
  expect(formFor(settings, { id: null, name: "constructor" })).toEqual({ form: "tags", stream: false });
  expect(jobCountsFor(settings, { id: "toString", name: "hasOwnProperty" })).toEqual([]);
  // Every connection map, read by a name it was not given, has nothing under it, inherited or not.
  for (const entry of ENTRIES.filter((listed) => listed.perConnection)) {
    const map: unknown = shown(settings, { ...entry, at: entry.at.slice(0, entry.at.indexOf("<connection>") - 1) });
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) expect({ key: entry.key, name, under: (map as Record<string, unknown>)[name] }).toEqual({ key: entry.key, name, under: undefined });
  }
  // Named so in the files, it is read as its own.
  const named = await settingsOf({ global: { connections: { constructor: { reply: { form: "two-step" } }, toString: { jobs: { atOnce: 1 } } } } });
  expect(formFor(named.settings, { id: null, name: "constructor" })).toEqual({ form: "two-step", stream: false });
  expect(jobCountsFor(named.settings, { id: null, name: "toString" })).toEqual([{ key: "toString", counts: { atOnce: 1 } }]);
});

test("a key in a section only the harness's settings use that names none of them is logged once with its file, and every setting is read as before", async () => {
  // `limits.turn.cals` for `calls`, and a connection's `atOnc`; a section no entry lives in is another reader's.
  const global: JsonObject = { limits: { turn: { cals: 12, calls: 30 } }, lantern: { wick: 3 } };
  const chat: JsonObject = { connections: { [CONNECTION]: { jobs: { atOnc: 1, perDay: 2 } } }, limits: { turn: { cals: 12 } } };
  const read = await settingsOf({ global, chat });
  expect({ turn: read.settings.turn, counts: read.settings.jobs.byConnection[CONNECTION] }).toEqual({ turn: { calls: 30 }, counts: { perDay: 2 } });
  expect(read.said.map(({ message, setting, file, why }) => ({ message, setting, file, why }))).toEqual([
    { message: "A key among the harness's settings names none of them; it is passed over.", setting: "limits.turn.cals", file: GLOBAL_FILE, why: "limits.turn.cals is no setting the harness reads: limits.turn holds calls, tokensIn, tokensOut, seconds, toolRounds, depth, agents, agentsAtOnce." },
    { message: "A key among the harness's settings names none of them; it is passed over.", setting: "limits.turn.cals", file: CHAT_FILE, why: "limits.turn.cals is no setting the harness reads: limits.turn holds calls, tokensIn, tokensOut, seconds, toolRounds, depth, agents, agentsAtOnce." },
    { message: "A key among the harness's settings names none of them; it is passed over.", setting: `connections.${CONNECTION}.jobs.atOnc`, file: CHAT_FILE, why: `connections.${CONNECTION}.jobs.atOnc is no setting the harness reads: connections.${CONNECTION}.jobs holds atOnce, perDay.` },
  ]);
});

test("every listed setting has a name and a line on what it is for", () => {
  for (const def of SETTINGS) {
    for (const words of [def.name, def.about]) expect({ key: def.key, words, oneLine: typeof words === "string" && words.trim() !== "" && !words.includes("\n") }).toMatchObject({ key: def.key, oneLine: true });
  }
  // Two settings called alike would be one row twice to the owner.
  expect(new Set(SETTINGS.map((def) => def.name)).size).toBe(SETTINGS.length);
});

test("every line of each words file, but the two that open and close its list, is the line of a listed setting", async () => {
  // Each file's own text, so a line no import shows (a comment) is held to it too; the files are found by name, so one added later is as well.
  const lineOf = (def: SettingDef) => `  ${JSON.stringify(def.key)}: { name: ${JSON.stringify(def.name)}, about: ${JSON.stringify(def.about)} },`;
  const listed = new Map(SETTINGS.map((def) => [def.key, lineOf(def)]));
  const keys: string[] = [];
  const files = [...new Bun.Glob("*-words.ts").scanSync(GROUP_FOLDER)].sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const lines = (await Bun.file(join(GROUP_FOLDER, file)).text()).split("\n");
    // The list opens on the first line and closes on the last, and the file ends there.
    expect({ file, opens: /^export const [A-Z]+_WORDS = \{$/.test(lines[0]!), closes: lines.slice(-2) }).toEqual({ file, opens: true, closes: ["};", ""] });
    for (const line of lines.slice(1, -2)) {
      const key = /^ {2}"([^"]+)": /.exec(line)?.[1] ?? "";
      keys.push(key);
      expect({ file, line }).toEqual({ file, line: listed.get(key) ?? "the line of a listed setting" });
    }
  }
  // One line for each listed setting, in all the files.
  expect(keys.sort()).toEqual([...listed.keys()].sort());
});

test("every setting name the model layer's words use is the name of a listed setting", async () => {
  const folder = join(import.meta.dir, "../../src/model");
  const named: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(folder)) {
    const text = await Bun.file(join(folder, file)).text();
    // No setting is named in words written out in the layer: each is named through its entry.
    expect({ file, written: text.match(/setting "[^"$]+"/g) ?? [] }).toEqual({ file, written: [] });
    for (const found of text.matchAll(/settingWords\(MODELS\.(\w+)\)/g)) named.push(found[1]!);
  }
  expect([...new Set(named)].sort()).toEqual(["embeddingBatch", "embeddingConnection", "embeddingModel", "listMost", "providerWait", "secretFloor", "signInOpen", "silentAfter", "tokensPerMinute", "unansweredAfter"]);
  const entries: Readonly<Record<string, SettingEntry & SettingWords>> = MODELS;
  for (const name of named) {
    const entry = entries[name];
    expect({ name, listed: SETTINGS.find((def) => def.key === entry?.key)?.name }).toEqual({ name, listed: entry?.name });
  }
});

test("the exported merge is the one readSettings reads by: a chat's value over a global one, mappings merged key by key, a value that is not a mapping replacing one that is", async () => {
  const global: JsonObject = { limits: { turn: { calls: 12, depth: 1 } }, connections: { "Harbour model": { reply: { form: "two-step" }, jobs: { atOnce: 1 } } }, jobs: { run: { calls: 30, seconds: 600 } } };
  const chat: JsonObject = { limits: { turn: { calls: 8 } }, connections: { "Lantern model": { reply: { form: "tags" }, jobs: { perDay: 4 } } }, jobs: { run: 5 } };
  const merged = mergedConfig(global, chat);
  expect(merged).toEqual({
    limits: { turn: { calls: 8, depth: 1 } },
    connections: { "Harbour model": { reply: { form: "two-step" }, jobs: { atOnce: 1 } }, "Lantern model": { reply: { form: "tags" }, jobs: { perDay: 4 } } },
    jobs: { run: 5 },
  });
  // A mapping over a value that is not one replaces it whole as well; and the merge changes neither config it is given.
  expect(mergedConfig({ jobs: { run: 5 } }, { jobs: { run: { calls: 9 } } })).toEqual({ jobs: { run: { calls: 9 } } });
  expect(global.jobs).toEqual({ run: { calls: 30, seconds: 600 } });

  // The two files read as levels give, setting by setting, what the one file the merge makes gives.
  const levels = await settingsOf({ global, chat });
  expect(levels.settings).toEqual((await settingsOf({ chat: merged })).settings);
  expect(levels.settings.turn.calls).toBe(8);
  expect(levels.settings.subAgents.depth).toBe(1);
  expect(levels.settings.forms).toEqual({ "Harbour model": "two-step", "Lantern model": "tags" });
  expect(levels.settings.jobs.byConnection).toEqual({ "Harbour model": { atOnce: 1 }, "Lantern model": { perDay: 4 } });
  // The chat's `run: 5` stands in place of the global mapping and is passed over: the run's limits are at their defaults.
  expect(levels.settings.jobs.run).toEqual(DEFAULT_SETTINGS.jobs.run);
  expect(levels.logged).toEqual([{ setting: "jobs.run", file: CHAT_FILE }]);
});

test("progress.silenceSeconds takes no value past nine minutes: 600 in a chat's file leaves the default with one log line naming the key and the file", async () => {
  // §10.7: a generation that sends no text for ten minutes is ended, so a progress line must come inside them.
  const past = await settingsOf({ global: { progress: { silenceSeconds: 120 } }, chat: { progress: { silenceSeconds: 600 } } });
  expect(past.settings.silenceMs).toBe(DEFAULT_SETTINGS.silenceMs);
  expect(past.logged).toEqual([{ setting: "progress.silenceSeconds", file: CHAT_FILE }]);
  // Nine minutes is the most it takes.
  const most = await settingsOf({ global: { progress: { silenceSeconds: 120 } }, chat: { progress: { silenceSeconds: 540 } } });
  expect({ silenceMs: most.settings.silenceMs, logged: most.logged }).toEqual({ silenceMs: 540_000, logged: [] });
  expect(SETTINGS.find((def) => def.key === "progress.silenceSeconds")?.takes).toEqual({ type: "whole", least: 1, most: 540 });
});

test("changing an entry's default changes what the tool uses; no source but the entry holds the old values", async () => {
  // The groups as they would read with these five defaults changed in their modules, and nothing else.
  const CHANGED: Readonly<Record<string, number>> = { "tools.search": 3, "tools.gap.hits": 2, "reply.heldSentences": 2, "reply.tailSentences": 5, "progress.silenceSeconds": 30 };
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
  // ...nor a number written where a count the tools and the reply are given would be missing, as `deps.hits ?? 8` was...
  for (const folder of ["tools", "reply"]) {
    for (const file of new Bun.Glob("**/*.ts").scanSync(join(src, folder))) {
      const text = await Bun.file(join(src, folder, file)).text();
      expect({ file: `${folder}/${file}`, fallbacks: text.match(/(?:\bdeps|\boptions|#o)\.\w+\s*\?\?\s*\d/g) ?? [] }).toEqual({ file: `${folder}/${file}`, fallbacks: [] });
    }
  }
  // ...and neither tool has a count to fall back on: one made without the user's does not build.
  // @ts-expect-error: tool search is given the user's `tools.search`, and has no count of its own.
  ({}) as Omit<ToolSearchDeps, "hits"> satisfies ToolSearchDeps;
  // @ts-expect-error: gap_check is given the user's `tools.gap.hits`, and has no count of its own.
  ({}) as Omit<BaseToolsDeps, "gapHits"> satisfies BaseToolsDeps;
});

test("for every entry of SETTINGS, its default is a value it takes", () => {
  holdsDefaults(GROUPS);
});

test("a chat's `limits.turn.tokensIn: ~` over a global 50,000 leaves that chat's turns with no tokens-in limit, and the global value holds for other chats", async () => {
  const lifted = await settingsOf({ global: { limits: { turn: { tokensIn: 50_000 } } }, chat: { limits: { turn: { tokensIn: null } } } });
  expect({ turn: lifted.settings.turn, logged: lifted.logged }).toEqual({ turn: { calls: 40 }, logged: [] });
  // Another chat, whose file lifts nothing, is held to the global limit.
  const other = await settingsOf({ global: { limits: { turn: { tokensIn: 50_000 } } }, chat: { limits: { turn: { calls: 30 } } } });
  expect(other.settings.turn).toEqual({ calls: 30, tokensIn: 50_000 });
  // So for every setting whose default is none, as the entries say which those are.
  await holdsNoneLifted(GROUPS);
});

test("the exported check and readSettings take and refuse the same values for every entry, on a sample of good and bad values", async () => {
  await holdsAgreement(GROUPS);
});

test("how a failed call is made again is read from the files into its terms: how many times, the wait, its growth, the longest, the provider's asked wait, each kind's switch", async () => {
  const read = await settingsOf({ global: { calls: { retries: 4, retryWaitSeconds: 2, retryWaitGrowth: 3, maxRetryWaitSeconds: 10, retryWaitAsAsked: false, retryOn: { connection: false, other: false } } } });
  expect(read.logged).toEqual([]);
  expect(callTerms(read.settings).retry).toEqual({ retries: 4, wait: 2_000, growth: 3, most: 10_000, asked: false, kinds: ["timeout", "overloaded", "server"] });
  expect(callTerms(DEFAULT_SETTINGS).retry).toEqual({ retries: 2, wait: 1_000, growth: 2, most: 60_000, asked: true, kinds: ["connection", "timeout", "overloaded", "server", "other"] });
});
