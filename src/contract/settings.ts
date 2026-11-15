// The settings a host shows and edits (§5.4 "Config": "The Settings page edits them as forms"; §14;
// Appendix D.1), each declared once by the code that reads it, as a config file writes it. RPH's own
// list is `SETTINGS` in `rp-harness/helpers`; a host declares its own the same way, and both read a
// scope's config files merged by one rule (`MergeLevels`), so a page shows what the readers read.

import type { LayerLevel } from "./files";
import type { JsonObject, JsonValue } from "./json";

/** What a level may set a setting to. */
export type SettingTakes =
  /** A whole number, at least `least`, and at most `most` where it has one. */
  | { readonly type: "whole"; readonly least: number; readonly most?: number }
  /** A number, at least `least`, and at most `most` where it has one. */
  | { readonly type: "number"; readonly least: number; readonly most?: number }
  /** One of `values`. */
  | { readonly type: "oneOf"; readonly values: readonly string[] }
  /** True or false. */
  | { readonly type: "yesNo" }
  /** A line of text that is not blank, read without the space at its ends. */
  | { readonly type: "text" }
  /** A list of names; as read, an item that is not a name (not text, or blank) is passed over, and written, refused. */
  | { readonly type: "texts" };

/** A setting as the code that reads it declares it: what a page needs to show it, to check a value before writing it, and to say what it is for. */
export interface SettingDef {
  /** The key as a config file writes it, dotted (`limits.turn.calls`); `<connection>` where a setting set per connection names its connection, `<definition>` where a setting set per agent definition names the definition (`sampling.<definition>.temperature`). */
  readonly key: string;
  readonly takes: SettingTakes;
  /** What holds where no level sets it, as a config file writes it: null for nothing, whose meaning `none` gives. */
  readonly default: JsonValue;
  /** What no value means, in a page's words, where the default is null or `~` may be set: "no limit". */
  readonly none?: string;
  /** A level may set `~` (null), which means what `none` says: a limit lifted. */
  readonly orNone?: true;
  /** Set for one connection at a time, named by its name or its id where the key has `<connection>`. */
  readonly perConnection: boolean;
  /** The key above it may hold this value in place of a mapping (`hold: true` for `hold: { on: true }`), the mapping's other keys then at their defaults. A host's list may mark a setting so; RPH's own writes none short. */
  readonly short?: true;
  /** The levels it is read from; absent, every level that has a config file. */
  readonly levels?: readonly LayerLevel[];
  /** What the Settings page calls it. Words for the owner, never sent to a model; every setting RPH lists has them. */
  readonly name?: string;
  /** One line on what it is for, on the Settings page. Words for the owner, never sent to a model; every setting RPH lists has them. */
  readonly about?: string;
}

/**
 * The merge of levels (§5.2: general first, specific last, nearer wins). A scope's config files are
 * read farthest first and merged two at a time: where both levels hold a mapping at a key, the two are
 * merged key by key; anything else the nearer level holds there (a value, a list, `~`) replaces what
 * the farther one held, whole. RPH reads every setting from the config this makes, and
 * `mergedConfig` in `rp-harness/helpers` is it, so a host reading the same files reads what RPH reads.
 */
export type MergeLevels = (far: JsonObject, near: JsonObject) => JsonObject;
