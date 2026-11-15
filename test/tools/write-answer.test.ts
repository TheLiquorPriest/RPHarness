// What `file_write` answers once a change went through (§6.8: "every write answer says what changed,
// what it now looks like"): the text as it now stands after a write or an append, the lines it
// changed, each with its number, after an edit; so no `file_read` is needed after it, and a long
// file's answer is clipped as every result is. Everything here is invented.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JsonObject, ToolCtx } from "../../src/contract";
import type { Fields } from "../../src/files/api";
import { fileWrite } from "../../src/tools";
import type { OwnTool, Words } from "../../src/tools/kit";
import { type Bench, bench, LEAD, SCOPE, textOf, turnGate } from "./base/support";

let b: Bench;
let write: OwnTool;
let words: Words;
let notes: string;

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
  write = fileWrite({ files: b.host.files, words, texts: new Map() });
});
afterAll(() => b.close());

async function call(args: JsonObject) {
  const ctx: ToolCtx = { scope: SCOPE, agent: LEAD, run: "kit-run", callId: "call-1", signal: new AbortController().signal, onUpdate: () => {} };
  return write.run(args, ctx);
}

const LEDGER = "Lamp oil: two barrels.\nRope: one coil.\nSalt: a sack.\nFlint: six.\n";

describe("file_write", () => {
  test("a write and an append answer with the text as it now stands", async () => {
    const path = `${notes}ledger.md`;
    const first = textOf(await call({ path, op: "write", text: LEDGER }));
    expect(first).toBe([worded("wrote", { path, bytes: LEDGER.length }), worded("now_text", { path, lines: 4, bytes: LEDGER.length }), LEDGER.slice(0, -1)].join("\n"));

    const now = `${LEDGER}Nets: mended.\n`;
    const second = textOf(await call({ path, op: "append", text: "Nets: mended.\n" }));
    expect(second).toBe([worded("appended", { path, bytes: now.length }), worded("now_text", { path, lines: 5, bytes: now.length }), now.slice(0, -1)].join("\n"));
  });

  test("an edit's answer shows the new text at its lines, and no file_read is needed to see it", async () => {
    const path = `${notes}ledger-edit.md`;
    await call({ path, op: "write", text: LEDGER });

    const one = LEDGER.replace("two", "three");
    expect(textOf(await call({ path, op: "edit", old: "two", new: "three" }))).toBe(
      [worded("edited", { path, bytes: one.length }), worded("now_stretch", { path, lines: 4, bytes: one.length, from: 1, to: 1 }), worded("now_line", { line: 1, text: "Lamp oil: three barrels." })].join("\n"),
    );

    // Several lines in place of two: every one is shown, numbered where it now is.
    const several = one.replace("Rope: one coil.\nSalt: a sack.\n", "Rope: one coil, wet.\nTar: a tin.\nSalt: two sacks.\n");
    expect(textOf(await call({ path, op: "edit", old: "Rope: one coil.\nSalt: a sack.\n", new: "Rope: one coil, wet.\nTar: a tin.\nSalt: two sacks.\n" }))).toBe(
      [
        worded("edited", { path, bytes: several.length }),
        worded("now_stretch", { path, lines: 5, bytes: several.length, from: 2, to: 4 }),
        ...["Rope: one coil, wet.", "Tar: a tin.", "Salt: two sacks."].map((text, at) => worded("now_line", { line: 2 + at, text })),
      ].join("\n"),
    );

    // An edit made everywhere the text is shows the stretch from the first change to the last.
    const twice = "A barrel of oil.\nA coil of rope.\nA sack of salt.\nAnother barrel, empty.\n";
    const spread = `${notes}ledger-all.md`;
    await call({ path: spread, op: "write", text: twice });
    const casks = twice.split("barrel").join("cask");
    expect(textOf(await call({ path: spread, op: "edit", old: "barrel", new: "cask", all: true }))).toBe(
      [
        worded("edited", { path: spread, bytes: casks.length }),
        worded("now_stretch", { path: spread, lines: 4, bytes: casks.length, from: 1, to: 4 }),
        ...casks.slice(0, -1).split("\n").map((text, at) => worded("now_line", { line: 1 + at, text })),
      ].join("\n"),
    );

    // Lines taken out and none put in: it says where the cut is, and how many lines are left.
    const left = several.replace("Tar: a tin.\n", "");
    expect(textOf(await call({ path, op: "edit", old: "Tar: a tin.\n", new: "" }))).toBe([worded("edited", { path, bytes: left.length }), worded("now_removed", { path, lines: 4, bytes: left.length, at: 3 })].join("\n"));
    const read = await b.host.files.read(SCOPE, path);
    expect(read.status === "read" ? read.text : "").toBe(left);
  });

  test("a delete, and a change that did not go through, answer as they did", async () => {
    const path = `${notes}ledger-gone.md`;
    await call({ path, op: "write", text: "Gone soon.\n" });
    expect(textOf(await call({ path, op: "delete" }))).toBe(worded("deleted", { path }));
    expect(textOf(await call({ path, op: "edit", old: "x", new: "y" }))).toBe(worded("no_file", { path }));
  });

  test("a long file's answer is clipped as a result is, and its size is still said", async () => {
    const path = `${notes}long-note.md`;
    const body = `${Array.from({ length: 400 }, (_, i) => `Entry ${i + 1}: the tide table for the ${i + 1}th day.`).join("\n")}\n`;
    const result = await call({ path, op: "write", text: body });
    const gate = await turnGate(b, { clipChars: 300 });
    const read = textOf((await gate.after({ agent: LEAD, callId: "call-long", tool: "file_write", args: { path, op: "write", text: body } }, result)).result);

    const head = worded("wrote", { path, bytes: body.length });
    expect(read.startsWith(head)).toBe(true);
    expect(read).not.toContain("Entry 400");
    expect(read).toContain(`300 of ${textOf(result).length} characters`);
  });
});
