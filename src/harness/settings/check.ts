// The one check of a value against what a setting takes. RPH's reader passes every value a level
// sets through it, and a host's settings page can check a value with it before writing it, so the
// two take and refuse the same values, for the same reason.

import type { JsonValue, SettingDef } from "../../contract";
import { isNamed } from "./entry";

/** What a check of a value finds: the value as the setting reads it; or why the setting takes no such value, with what of it is read all the same. */
export type SettingCheck = { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly why: string; readonly kept?: JsonValue };

/** A value as a reason names it: as a config file writes it, and a number JSON cannot write (NaN, ±Infinity) as itself. */
export function valueWords(value: JsonValue): string {
  return typeof value === "number" && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
}

/** What a setting takes, in words: "a whole number, at least 1, or ~ for no limit". */
function takesWords(def: SettingDef): string {
  const t = def.takes;
  const what =
    t.type === "whole"
      ? t.most === undefined
        ? `a whole number, at least ${t.least}`
        : `a whole number from ${t.least} to ${t.most}`
      : t.type === "number"
        ? t.least === undefined
          ? t.most === undefined
            ? "a number"
            : `a number, at most ${t.most}`
          : t.most === undefined
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

/**
 * Whether a setting takes a value, and the value as the setting reads it: a line of text trimmed,
 * `~` (null) where the setting takes that. A list with an item that is not a name (not text, or blank) is refused with its
 * names kept, as the contract's `texts` says: a reader reads the names and passes the other items
 * over; a page refuses the list. `connection` is the name the key is set under, where the key has
 * `<connection>` or `<definition>`.
 */
export function checkSettingValue(def: SettingDef, value: JsonValue, connection?: string): SettingCheck {
  const key = connection === undefined ? def.key : def.key.split(".").map((part) => (isNamed(part) ? connection : part)).join(".");
  const refused: SettingCheck = { ok: false, why: `${key} takes ${takesWords(def)}, not ${valueWords(value)}.` };
  if (value === null) return def.orNone === true ? { ok: true, value: null } : refused;
  const t = def.takes;
  switch (t.type) {
    case "whole":
      return typeof value === "number" && Number.isInteger(value) && value >= t.least && (t.most === undefined || value <= t.most) ? { ok: true, value } : refused;
    case "number":
      return typeof value === "number" && Number.isFinite(value) && (t.least === undefined || value >= t.least) && (t.most === undefined || value <= t.most) ? { ok: true, value } : refused;
    case "oneOf":
      return typeof value === "string" && t.values.includes(value) ? { ok: true, value } : refused;
    case "yesNo":
      return typeof value === "boolean" ? { ok: true, value } : refused;
    case "text":
      return typeof value === "string" && value.trim() !== "" ? { ok: true, value: value.trim() } : refused;
    case "texts": {
      if (!Array.isArray(value)) return refused;
      const names = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      if (names.length === value.length) return { ok: true, value: names };
      const others = value.filter((item) => typeof item !== "string" || item.trim() === "").map((item) => valueWords(item));
      return { ok: false, why: `${key} takes a list of names, and ${others.join(", ")} ${others.length === 1 ? "is not one" : "are not names"}.`, kept: names };
    }
  }
}
