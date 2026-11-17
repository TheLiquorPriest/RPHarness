// What an entry of RPH's list of settings is: a setting as the code that reads it declares it (the
// contract's `SettingDef`), with where the harness keeps its value (`Landing`) and with its name and
// its line on what it is for. A group's module declares each of its settings once, as an entry, by
// the name it is known by in the group; the words come from the group's words file, one line per
// setting, joined here by the setting's key. The words are for the owner on the Settings page and are
// never sent to a model. A point past which a value still has a meaning, but one to know of, is the
// entry's (`advise`); its line is the words file's (`below`, `above`), and the two make the
// setting's `advice` (§2.1 point 5: no hard cap).

import type { SettingAdvice, SettingDef } from "../../contract";

/** A setting's words on the Settings page: what it is called, and one line on what it is for. */
export interface SettingWords {
  readonly name: string;
  readonly about: string;
}

/** A setting's words as its group's words file gives them: with the line for each point its entry advises at. */
export interface WrittenWords extends SettingWords {
  readonly below?: string;
  readonly above?: string;
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
  /** A value a level sets to none (`~`) lands as null rather than being left out: it stands over what another source gives (an agent's header), where no value at all leaves that source's. */
  readonly noneKept?: true;
  /** The points past which the page advises (`SettingDef.advice`), each with its line in the words file. */
  readonly advise?: { readonly below?: number; readonly above?: number };
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
export type SettingEntry = Omit<SettingDef, "name" | "about" | "short" | "advice"> & { readonly short?: never } & Landing;

/** A setting with its words and its advice, as its group gives it. */
type Worded = SettingWords & { readonly advice?: readonly SettingAdvice[] };

/** A group of settings as its module gives it: each entry, with its words, by the name it is known by in the group. */
export type Group = Readonly<Record<string, SettingEntry & Worded>>;

/** A value made unchangeable to its depth: a host reads RPH's list, and nothing it does to it changes what RPH reads. */
export function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

/** The advice an entry's points and its words make; a point with no line in the words file is a fault of the module, found when it loads. */
function adviceOf(entry: SettingEntry, words: WrittenWords): SettingAdvice[] {
  const out: SettingAdvice[] = [];
  for (const side of ["below", "above"] as const) {
    const at = entry.advise?.[side];
    if (at === undefined) continue;
    const says = words[side];
    if (says === undefined) throw new Error(`The setting ${entry.key} advises ${side} ${at} and its words file has no ${side} line.`);
    out.push(side === "below" ? { below: at, says } : { above: at, says });
  }
  return out;
}

/** A group's entries, by the name each is known by, each with its words from the group's words file, found by its key, and its advice. */
export function worded<const G extends Record<string, SettingEntry>>(entries: G, words: { readonly [N in keyof G as G[N]["key"]]: WrittenWords }): { readonly [N in keyof G]: G[N] & Worded } {
  const byKey: Readonly<Record<string, WrittenWords>> = words;
  const out: Record<string, SettingEntry & Worded> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const own = byKey[entry.key]!;
    const advice = adviceOf(entry, own);
    out[name] = frozen({ ...entry, name: own.name, about: own.about, ...(advice.length > 0 ? { advice } : {}) });
  }
  return frozen(out) as { readonly [N in keyof G]: G[N] & Worded };
}
