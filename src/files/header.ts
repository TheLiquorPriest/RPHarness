// A file's header: the YAML between two `---` lines at its top, read by Bun's own YAML parser, and
// the body after it. Bun's error does not say which line it failed on, so a header that does not
// parse is reported at the line after the longest leading run of its lines that does.

import type { LayerLevel } from "../contract/index";
import type { Problem } from "./api";

/** The file a problem is about. */
export interface At {
  path: string;
  level?: LayerLevel;
}

export interface Split {
  /** Whether the file starts with a header at all. */
  has: boolean;
  /** Its fields; undefined when there is none, or it does not parse (see `problems`). */
  header?: Record<string, unknown>;
  /** The header's lines as written, to find the line a field is on. */
  lines: string[];
  body: string;
  /** The file's line the body starts on. */
  bodyLine: number;
  problems: Problem[];
}

const FENCE = /^---[ \t]*$/;

/** The text with a leading byte-order mark dropped and every line ending made "\n". */
export function normalized(text: string): string {
  return (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

export function problemAt(at: At, line: number | undefined, message: string): Problem {
  return { path: at.path, ...(at.level !== undefined ? { level: at.level } : {}), ...(line !== undefined ? { line } : {}), message };
}

/** The YAML in `lines`, of which the first is the file's line `firstLine`; or the problem, at the line it fails on. */
export function parseYaml(lines: readonly string[], firstLine: number, at: At, what: string): { value: unknown } | { problem: Problem } {
  try {
    return { value: Bun.YAML.parse(lines.join("\n")) };
  } catch (error) {
    let good = 0;
    for (let k = lines.length - 1; k >= 1; k--) {
      try {
        Bun.YAML.parse(lines.slice(0, k).join("\n"));
        good = k;
        break;
      } catch {
        // A shorter run is tried next.
      }
    }
    const reason = (error instanceof Error ? error.message : String(error)).replace(/^YAML Parse error:\s*/, "");
    return {
      problem: problemAt(at, firstLine + good, `Line ${firstLine + good} of ${what} cannot be read (${reason}). Each line is \`name: value\`; put a value that holds \`: \` or starts with [ { ' " * & or # in quotes, and indent with spaces, not tabs.`),
    };
  }
}

/** Whether a value is a plain object: what a YAML mapping parses to. */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Splits a file into its header and its body. A file that does not start with a `---` line has no header, and its whole text is the body. */
export function splitHeader(text: string, at: At): Split {
  const lines = normalized(text).split("\n");
  if (!FENCE.test(lines[0] ?? "")) return { has: false, lines: [], body: lines.join("\n"), bodyLine: 1, problems: [] };
  const end = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
  if (end === -1) {
    return { has: true, lines: [], body: "", bodyLine: lines.length + 1, problems: [problemAt(at, 1, "The header that starts on line 1 has no closing line. End it with a line that holds only `---`.")] };
  }
  const own = lines.slice(1, end);
  const split: Split = { has: true, lines: own, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2, problems: [] };
  const parsed = parseYaml(own, 2, at, "the header");
  if ("problem" in parsed) {
    split.problems.push(parsed.problem);
    return split;
  }
  if (parsed.value === null || parsed.value === undefined) split.header = {};
  else if (isMapping(parsed.value)) split.header = parsed.value;
  else split.problems.push(problemAt(at, 2, "The header must be `name: value` lines, one field to a line."));
  return split;
}

/** A text as a pattern that matches it alone. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The file's line a top-level field is on: the first of `lines` (the file's line `firstLine` onwards) that starts with `name:`. A header's lines start on line 2. */
export function fieldLine(lines: readonly string[], name: string, firstLine = 2): number | undefined {
  const starts = new RegExp(`^${literal(name)}[ \\t]*:`);
  const i = lines.findIndex((line) => starts.test(line));
  return i === -1 ? undefined : i + firstLine;
}

/**
 * The lines of a top-level field's block (the indented lines under `stack:`), set back to the margin
 * by the indent of its first key, with the file line the first of them is on and the field's own
 * line, so `fieldLine` and `WrittenItems` find the keys under it as they find a top-level one. A field
 * whose value is written on its own line (`stack: { off: [WORLD] }`) has no lines under it. Undefined
 * where no line starts with the field.
 */
export function blockOf(lines: readonly string[], name: string, firstLine = 2): { lines: string[]; firstLine: number; field: number } | undefined {
  const starts = new RegExp(`^${literal(name)}[ \\t]*:`);
  const row = lines.findIndex((line) => starts.test(line));
  if (row === -1) return undefined;
  let end = row + 1;
  while (end < lines.length && !/^(?:[^\s#-]|-\S)/.test(lines[end] ?? "")) end++;
  const inner = lines.slice(row + 1, end);
  const indent = /^[ \t]*/.exec(inner.find((line) => line.trim() !== "" && !/^\s*#/.test(line)) ?? "")?.[0] ?? "";
  return { lines: inner.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)), firstLine: row + 1 + firstLine, field: row + firstLine };
}

/**
 * Where the items of a top-level field's value are written, found by their text in the order YAML
 * reads them: each search goes on from where the last one found its text, so a name written twice is
 * found at each place in turn, in a block (`- STYLE` lines, `gm:` lines below the field) or a flow
 * (`[STYLE, house/canon.md]`) alike. The value runs from the field's line to the next line that
 * starts at the margin with anything but a list's `- ` or a comment (another field, a header's `---`).
 */
export class WrittenItems {
  readonly #lines: readonly string[];
  readonly #first: number;
  /** The field's own line; undefined where no line starts with it. */
  readonly field: number | undefined;
  readonly #end: number;
  #row: number;
  #col: number;

  constructor(lines: readonly string[], name: string, firstLine = 2) {
    this.#lines = lines;
    this.#first = firstLine;
    const starts = new RegExp(`^${literal(name)}[ \\t]*:`);
    const row = lines.findIndex((line) => starts.test(line));
    this.field = row === -1 ? undefined : row + firstLine;
    this.#row = Math.max(row, 0);
    this.#col = row === -1 ? 0 : (lines[row] ?? "").indexOf(":") + 1;
    let end = row + 1;
    while (row !== -1 && end < lines.length && !/^(?:[^\s#-]|-\S)/.test(lines[end] ?? "")) end++;
    this.#end = row === -1 ? 0 : end;
  }

  /** The line `text` is next written on, as a value, or as a key (`text:`) where `key` is set; the search goes on after it. Undefined where it is not written from there on: the search stays where it was. */
  find(text: string, key = false): number | undefined {
    const pattern = new RegExp(key ? `(?<![\\w.-])["']?${literal(text)}["']?[ \\t]*:` : literal(text));
    for (let row = this.#row; row < this.#end; row++) {
      const line = this.#lines[row] ?? "";
      if (/^\s*#/.test(line)) continue;
      const from = row === this.#row ? this.#col : 0;
      const match = pattern.exec(line.slice(from));
      if (match === null) continue;
      this.#row = row;
      this.#col = from + match.index + match[0].length;
      return row + this.#first;
    }
    return undefined;
  }
}

/** A header field given as one name or a list of names: the names, or undefined when it is neither. */
export function nameList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.map((v: string) => v.trim()).filter((v) => v !== "");
  return undefined;
}

/** Problems for the header's fields that are not among `known`. */
export function unknownFields(split: Split, known: readonly string[], at: At, what: string): Problem[] {
  if (split.header === undefined) return [];
  return Object.keys(split.header)
    .filter((key) => !known.includes(key))
    .map((key) => problemAt(at, fieldLine(split.lines, key), `\`${key}\` is not a field ${what} has, and is not read. Its fields are: ${known.join(", ")}.`));
}
