// What `file_find` tells an agent when a search stopped before it looked everywhere: at its limit,
// at a file too large to read, at a line cut short; and that a search that did not stop says
// nothing of it (§5.1, §3.4: a tool reports what it did). Everything here is invented.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JsonObject, ToolCtx } from "../../src/contract";
import type { Fields } from "../../src/files/api";
import { GREP_LINE_MAX, GREP_MAX_BYTES } from "../../src/hosts/folder/files";
import { fileFind } from "../../src/tools";
import type { OwnTool, Words } from "../../src/tools/kit";
import { type Bench, bench, LEAD, SCOPE, textOf } from "./base/support";

let b: Bench;
let find: OwnTool;
let words: Words;
let notes: string;

const MARK = "kit-stopped-mark";
const LONG = `${MARK} ${"z".repeat(GREP_LINE_MAX + 500)}`;

/** A line of the tool answers' file, filled in; it must be there, or the answer would not say it. */
function worded(name: string, fields: Fields): string {
  const text = words(name, fields);
  if (text === undefined || text === "") throw new Error(`The tool answers' file has no line ${name}.`);
  return text;
}

beforeAll(async () => {
  b = await bench();
  notes = (await b.host.files.places(SCOPE)).notes;
  const lines = await b.guidance.part("tool-notices");
  words = (name, fields) => (lines?.format === "lines" ? lines.line(name, fields) : undefined);
  find = fileFind({ files: b.host.files, words, texts: new Map() });
  const put = async (name: string, text: string) => expect(await b.host.files.write(SCOPE, `${notes}${name}`, { op: "write", text }, LEAD)).toMatchObject({ status: "written" });
  for (const name of ["a.md", "b.md", "c.md"]) await put(name, `${MARK}\n`);
  await put("big.log", `${MARK} first\n${"filler line of the big note\n".repeat(Math.ceil(GREP_MAX_BYTES / 28) + 10)}`);
  await put("long.log", `${LONG}\n`);
});
afterAll(() => b.close());

function ask(args: JsonObject) {
  const ctx: ToolCtx = { scope: SCOPE, agent: LEAD, run: "kit-run", callId: "call-1", signal: new AbortController().signal, onUpdate: () => {} };
  return find.run(args, ctx).then(textOf);
}

describe("file_find", () => {
  test("a grep that reached its limit says it stopped and how to narrow; one that skipped a large file names it", async () => {
    const stopped = await ask({ by: "grep", pattern: MARK, literal: true, path: notes, glob: "*.md", limit: 2 });
    expect(stopped).toBe([`${notes}a.md:1: ${MARK}`, `${notes}b.md:1: ${MARK}`, worded("stopped_limit", { grep: true, max: 2 })].join("\n"));
    // It names the number it stopped at and how to narrow a grep: a path, a glob, a closer pattern.
    const said = worded("stopped_limit", { grep: true, max: 2 });
    expect(said).toContain("2");
    for (const way of ["path", "glob", "pattern"]) expect(said).toContain(way);

    const skipped = await ask({ by: "grep", pattern: MARK, literal: true, path: notes, glob: "big.log" });
    expect(skipped).toBe([worded("none_found", {}), worded("stopped_large", { grep: true, files: 1, bytes: GREP_MAX_BYTES })].join("\n"));
    expect(skipped).toContain(String(GREP_MAX_BYTES));
  });

  test("a search that looked everywhere says nothing about stopping, though it reached its limit exactly", async () => {
    const exact = await ask({ by: "grep", pattern: MARK, literal: true, path: notes, glob: "*.md", limit: 3 });
    expect(exact).toBe([`${notes}a.md:1: ${MARK}`, `${notes}b.md:1: ${MARK}`, `${notes}c.md:1: ${MARK}`].join("\n"));
    expect(await ask({ by: "glob", pattern: "*.md", path: notes })).toBe([`${notes}a.md`, `${notes}b.md`, `${notes}c.md`].join("\n"));
  });

  test("a line cut short is counted, with the length it was cut to", async () => {
    const cut = await ask({ by: "grep", pattern: MARK, literal: true, path: notes, glob: "long.log" });
    expect(cut).toBe([`${notes}long.log:1: ${LONG.slice(0, GREP_LINE_MAX)}`, worded("stopped_cut", { grep: true, lines: 1, chars: GREP_LINE_MAX })].join("\n"));
  });

  test("a listing and a glob that stopped at their limit are narrowed the way a listing and a glob are", async () => {
    const listed = await ask({ by: "list", path: notes, limit: 2 });
    expect(listed).toBe([`${notes}a.md`, `${notes}b.md`, worded("stopped_limit", { list: true, max: 2 })].join("\n"));
    const globbed = await ask({ by: "glob", pattern: "*.md", path: notes, limit: 1 });
    expect(globbed).toBe([`${notes}a.md`, worded("stopped_limit", { glob: true, max: 1 })].join("\n"));
    // Each kind is told its own way to narrow: a listing has no pattern.
    expect(worded("stopped_limit", { list: true, max: 2 })).not.toContain("pattern");
  });

  test("a host that ran out of time says how long it had, and the hits it found stay", async () => {
    const hit = { path: `${notes}a.md`, type: "file", level: "chat", kind: "notes", line: 1, text: MARK } as const;
    const timed = fileFind({ files: { ...b.host.files, find: async () => ({ status: "found", hits: [hit], stopped: { time: { ms: 50 } } }) }, words, texts: new Map() });
    const ctx: ToolCtx = { scope: SCOPE, agent: LEAD, run: "kit-run", callId: "call-1", signal: new AbortController().signal, onUpdate: () => {} };
    expect(textOf(await timed.run({ by: "grep", pattern: MARK }, ctx))).toBe([`${notes}a.md:1: ${MARK}`, worded("stopped_time", { grep: true, ms: 50 })].join("\n"));
  });
});
