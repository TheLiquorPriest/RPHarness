// The one list of every setting RPH reads (§5.4 "Config": the Settings page edits them as forms; §14;
// Appendix D.1). Each listed setting is read through its entry from a chat's config file over the
// global one, and a value it does not take leaves its default, logged once with its key and its file;
// each has its name and its line from its group's words file. The config files are a host's, held in
// memory here; every name is invented.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { mergedConfig, SETTINGS } from "rp-harness/helpers";
import type { FilesPort, JsonObject, JsonValue, Layer, Log, Scope, SettingDef } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import { DEFAULT_SETTINGS, readSettings, type Settings, SettingsRead } from "../../src/harness/settings";
import type { SettingEntry } from "../../src/harness/settings/entry";

/** The folder of the list's groups, where each group's words file sits beside its module. */
const GROUPS = join(import.meta.dir, "../../src/harness/settings");

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

/** The settings a global and a chat config give, and what was logged of values passed over. */
async function settingsOf(configs: { global?: JsonObject; chat?: JsonObject }): Promise<{ settings: Settings; logged: { setting: JsonValue; file: JsonValue }[] }> {
  const { log, logged } = recorder();
  // JSON is YAML: each config file holds the config as JSON.
  const files = configFiles({ ...(configs.global !== undefined ? { [GLOBAL_FILE]: JSON.stringify(configs.global) } : {}), ...(configs.chat !== undefined ? { [CHAT_FILE]: JSON.stringify(configs.chat) } : {}) });
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

/**
 * Where each setting's value shows in what `readSettings` returns, as a config file writes it: null
 * for none. A setting listed with no line here fails the test below, so each new one is read.
 */
const SHOWN: Readonly<Record<string, (settings: Settings) => JsonValue>> = {
  "limits.turn.calls": (s) => s.turn.calls ?? null,
  "limits.turn.tokensIn": (s) => s.turn.tokensIn ?? null,
  "limits.turn.tokensOut": (s) => s.turn.tokensOut ?? null,
  "limits.turn.time": (s) => (s.turn.time === undefined ? null : s.turn.time / 1000),
  "limits.turn.depth": (s) => s.subAgents.depth,
  "limits.turn.agents": (s) => s.subAgents.agents ?? null,
  "jobs.atOnce": (s) => s.jobs.atOnce,
  "jobs.perDay": (s) => s.jobs.perDay ?? null,
  "jobs.perRun": (s) => s.jobs.perRun ?? null,
  "jobs.tokensPerDay": (s) => s.jobs.tokensPerDay ?? null,
  "jobs.cachedWeight": (s) => s.jobs.cachedWeight,
  "jobs.connections.<connection>.atOnce": (s) => s.jobs.connections[CONNECTION]?.atOnce ?? null,
  "jobs.connections.<connection>.perDay": (s) => s.jobs.connections[CONNECTION]?.perDay ?? null,
  "jobs.run.calls": (s) => s.jobs.run.calls ?? null,
  "jobs.run.tokensIn": (s) => s.jobs.run.tokensIn ?? null,
  "jobs.run.tokensOut": (s) => s.jobs.run.tokensOut ?? null,
  "jobs.run.time": (s) => (s.jobs.run.time === undefined ? null : s.jobs.run.time / 1000),
  "effort.connections.<connection>": (s) => s.efforts[CONNECTION] ?? null,
  "reply.form": (s) => s.form,
  "reply.forms.<connection>": (s) => s.forms[CONNECTION] ?? null,
  "reply.streamAnyway": (s) => [...s.streamAnyway],
  "reply.heldSentences": (s) => s.heldSentences,
  "reply.tailSentences": (s) => s.tailSentences,
  "reply.leadSampling": (s) => s.leadSampling,
  "reply.intentWait": (s) => s.intentWaitMs / 1000,
  "progress.show": (s) => s.progress,
  "progress.silence": (s) => s.silenceMs / 1000,
  "results.clip": (s) => s.clipChars,
  "tools.search": (s) => s.searchHits,
  "tools.gapCheck": (s) => s.gapHits,
  "tools.perCall": (s) => s.perCall,
  "tools.schemaShown": (s) => s.schemaShown,
  "rules.window": (s) => s.ruleWindow,
  "rules.judge": (s) => s.judge ?? null,
  "trace.requests": (s) => s.requests,
  "prompt.kept": (s) => s.promptKept,
  "live.backlog": (s) => s.liveBacklog,
  "compaction.reserve": (s) => s.compaction.reserve,
  "compaction.keepTurns": (s) => s.compaction.keepTurns,
  "compaction.records": (s) => s.compaction.records,
  "compaction.saveCalls": (s) => s.compaction.saveCalls,
};

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
  expect(Object.keys(SHOWN).sort()).toEqual(SETTINGS.map((def) => def.key).sort());
  for (const def of SETTINGS) {
    expect({ key: def.key, perConnection: def.key.includes("<connection>") }).toEqual({ key: def.key, perConnection: def.perConnection });
    const key = def.key.replace("<connection>", CONNECTION);
    const shown = SHOWN[def.key]!;
    const [chat, global] = takenValues(def);
    // A setting read from some levels alone takes nothing from a file at another.
    const readsGlobal = def.levels === undefined || def.levels.includes("global");
    const readsChat = def.levels === undefined || def.levels.includes("chat");

    const fromGlobal = await settingsOf({ global: configWith(def, global) });
    expect({ key, value: shown(fromGlobal.settings) }).toEqual({ key, value: readsGlobal ? global : def.default });
    const over = await settingsOf({ global: configWith(def, global), chat: configWith(def, chat) });
    expect({ key, value: shown(over.settings), logged: over.logged }).toEqual({ key, value: readsChat ? chat : shown(fromGlobal.settings), logged: [] });
    if (def.orNone === true) {
      // `~` in the chat's file lifts what the global one sets.
      const lifted = await settingsOf({ global: configWith(def, global), chat: configWith(def, null) });
      expect({ key, value: shown(lifted.settings), logged: lifted.logged }).toEqual({ key, value: readsChat ? null : shown(fromGlobal.settings), logged: [] });
    }
    for (const value of untakenValues(def)) {
      const passed = await settingsOf({ chat: configWith(def, value) });
      expect({ key, set: value, value: shown(passed.settings), logged: passed.logged }).toEqual({ key, set: value, value: def.default, logged: readsChat ? [{ setting: key, file: CHAT_FILE }] : [] });
    }
  }
});

test("an entry is read from the levels it names alone: a chat's file sets nothing for one read from the shipped and global levels", () => {
  const { log, logged } = recorder();
  const wick: SettingEntry = { key: "lantern.wick", takes: { type: "whole", least: 1 }, default: 2, levels: ["shipped", "global"], perConnection: false };
  const flame: SettingEntry = { key: "lantern.flame", takes: { type: "oneOf", values: ["low", "high"] }, default: "low", perConnection: false };
  const all = new SettingsRead(
    [
      { level: "shipped", path: "@shipped/config.yml", config: { lantern: { wick: 3 } } },
      { level: "global", path: GLOBAL_FILE, config: { lantern: { wick: 4, flame: "high" } } },
      { level: "chat", path: CHAT_FILE, config: { lantern: { wick: 0, flame: "low" } } },
    ],
    log,
  );
  // The chat's wick, one it would not take either, is not read at all: the global level's stands, and nothing is logged of it.
  expect(all.value(wick)).toBe(4);
  // Read from every level, the chat's value stands over the global one.
  expect(all.value(flame)).toBe("low");
  expect(logged).toEqual([]);
  // A value it does not take, at a level it is read from, is passed over, and the line names that level's file.
  const global = new SettingsRead(
    [
      { level: "global", path: GLOBAL_FILE, config: { lantern: { wick: 0 } } },
      { level: "chat", path: CHAT_FILE, config: { lantern: { wick: 9 } } },
    ],
    log,
  );
  expect(global.value(wick)).toBe(2);
  expect(logged).toEqual([{ setting: "lantern.wick", file: GLOBAL_FILE }]);
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
  const files = [...new Bun.Glob("*-words.ts").scanSync(GROUPS)].sort();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const module: Record<string, unknown> = await import(join(GROUPS, file));
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
