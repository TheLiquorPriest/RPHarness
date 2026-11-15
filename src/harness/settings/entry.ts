// What an entry of RPH's list of settings is: a setting as the code that reads it declares it (the
// contract's `SettingDef`), with where the harness keeps its value (`Landing`) and with its name and
// its line on what it is for. A group's module declares each of its settings once, as an entry, by
// the name it is known by in the group; the words come from the group's words file, one line per
// setting, joined here by the setting's key. The words are for the owner on the Settings page and are
// never sent to a model.

import type { SettingDef } from "../../contract";

/** A setting's words on the Settings page: what it is called, and one line on what it is for. */
export interface SettingWords {
  readonly name: string;
  readonly about: string;
}

/** A setting as RPH lists it for a host: every one has its words. */
export type ListedSetting = SettingDef & SettingWords;

/**
 * Where the harness keeps a setting's value in its own settings (`Settings`), so the reader places
 * every value by its entry and the type of what it reads follows from the entries.
 */
export interface Landing {
  /** The path of field names, dotted; `<connection>` or `<definition>` where a setting set per connection or per agent definition names it. A value that is none is left out. */
  readonly at: string;
  /** A number of seconds, kept as milliseconds. */
  readonly ms?: true;
}

/** Where the key of a setting set per connection names its connection. */
export const CONNECTION = "<connection>";

/** Where the key of a setting set per agent definition names the definition. */
export const DEFINITION = "<definition>";

/** Whether a part of a key stands for a name a file chooses: a connection's or a definition's. */
export function isNamed(part: string | undefined): boolean {
  return part === CONNECTION || part === DEFINITION;
}

/**
 * A setting as its group's module declares it: everything but its words, which only its words file
 * gives. None of RPH's is written short (`SettingDef.short`, which a host's own list may use), so its
 * reader reads no short form.
 */
export type SettingEntry = Omit<SettingDef, "name" | "about" | "short"> & { readonly short?: never } & Landing;

/** A group of settings as its module gives it: each entry, with its words, by the name it is known by in the group. */
export type Group = Readonly<Record<string, SettingEntry & SettingWords>>;

/** A value made unchangeable to its depth: a host reads RPH's list, and nothing it does to it changes what RPH reads. */
export function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

/** A group's entries, by the name each is known by, each with its words from the group's words file, found by its key. */
export function worded<const G extends Record<string, SettingEntry>>(entries: G, words: { readonly [N in keyof G as G[N]["key"]]: SettingWords }): { readonly [N in keyof G]: G[N] & SettingWords } {
  const byKey: Readonly<Record<string, SettingWords>> = words;
  const out: Record<string, SettingEntry & SettingWords> = {};
  for (const [name, entry] of Object.entries(entries)) out[name] = frozen({ ...entry, name: byKey[entry.key]!.name, about: byKey[entry.key]!.about });
  return frozen(out) as { readonly [N in keyof G]: G[N] & SettingWords };
}
