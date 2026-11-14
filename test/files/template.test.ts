// The template syntax (`api.ts`): fields put in, blocks shown when a field is present and not
// empty (once per item of a list), blocks shown when it is absent, `{{.}}`, and nothing else; a line
// that holds only a block's tag leaves nothing behind; a template that cannot be read is reported by
// line; and a part of one `name: text` per line, where a deleted line is a line not shown.

import { afterEach, describe, expect, test } from "bun:test";
import type { Template } from "../../src/files/index";
import { loadGuidance, parseTemplate } from "../../src/files/index";
import type { Bench } from "./support";
import { bench, scope } from "./support";

const at = { path: "@global/.prompts/test.md", firstLine: 4 };

function template(text: string): Template {
  const { template: t, problems } = parseTemplate(text, at);
  if (t === undefined) throw new Error(`Not a template: ${JSON.stringify(problems)}`);
  return t;
}

describe("a template", () => {
  test("puts fields in by path, joins a list with commas, and says which fields had no value", () => {
    const t = template("{{who.name}} met {{others}} at {{place}}; {{who.name}} left.");
    expect(t.fields).toEqual(["who.name", "others", "place"]);
    expect(t.render({ who: { name: "Wren" }, others: ["Tam", "Ivy"] })).toEqual({ text: "Wren met Tam, Ivy at ; Wren left.", missing: ["place"] });
  });

  test("shows a block for a present value, once per item of a list with `{{.}}`, and an inverted block only for an absent or empty one", () => {
    const t = template("{{#items}}- {{.}}\n{{/items}}{{^items}}Nothing.\n{{/items}}{{#count}}{{count}} more{{/count}}");
    expect(t.render({ items: ["a", "b"], count: 2 }).text).toBe("- a\n- b\n2 more");
    for (const items of [undefined, [], "", null, false]) expect(t.render({ items, count: 0 }).text).toBe("Nothing.\n");
  });

  test("looks a name up in the block's item first, then outwards", () => {
    const t = template("{{#turns}}Turn {{n}}{{#story_time}} at {{story_time}}{{/story_time}} by {{who}}.\n{{/turns}}");
    expect(t.render({ who: "the Author", turns: [{ n: 1, story_time: "dusk" }, { n: 2 }] }).text).toBe("Turn 1 at dusk by the Author.\nTurn 2 by the Author.\n");
  });

  test("an object's own value under '.' is what it puts in and what a block tests, beside its fields", () => {
    const t = template("{{#fact}}{{fact}} of them: {{fact.names}}{{/fact}}{{^fact}}none{{/fact}}");
    expect(t.render({ fact: { ".": 2, names: ["Wren", "Tam"] } }).text).toBe("2 of them: Wren, Tam");
    expect(t.render({ fact: { ".": 0, names: [] } }).text).toBe("none");
  });

  test("a line holding only a block's tag leaves nothing behind; a tag among words keeps its line", () => {
    const t = template("Head\n\n{{#a}}\n  A is {{a}}.\n{{/a}}\n{{^b}}\nNo B.\n{{/b}}\nTail {{#a}}(a){{/a}}\n");
    expect(t.render({ a: "on" }).text).toBe("Head\n\n  A is on.\nNo B.\nTail (a)\n");
    expect(t.render({ b: true }).text).toBe("Head\n\nTail \n");
  });

  test("a block left open or closed out of turn is reported by its line, and the template is not used", () => {
    expect(parseTemplate("One\n{{#a}}\nTwo\n", at)).toEqual({ problems: [{ path: at.path, line: 5, message: "The block `a` opened on line 5 is never closed. Add `{{/a}}` where it ends." }] });
    const crossed = parseTemplate("{{#a}}{{#b}}\n{{/a}}{{/b}}\n", at);
    expect(crossed.template).toBeUndefined();
    expect(crossed.problems[0]).toMatchObject({ line: 5, message: expect.stringContaining("`{{/a}}` comes while the block `b` from line 4 is still open") });
    expect(parseTemplate("{{/a}}", at).problems[0]).toMatchObject({ line: 4, message: expect.stringContaining("closes a block that was never opened") });
  });

  test("a tag this syntax does not have is shown as written and reported, and the rest still works", () => {
    const { template: t, problems } = parseTemplate("{{> partial}} {{name}} {{ spaced }} {{open", at);
    expect(problems.map((p) => p.line)).toEqual([4, 4]);
    expect(t?.render({ name: "Wren", spaced: "ok" }).text).toBe("{{> partial}} Wren ok {{open");
  });
});

describe("a part of lines", () => {
  let b: Bench | undefined;
  afterEach(async () => {
    await b?.close();
    b = undefined;
  });

  test("shows each line by name, filled in; a deleted line is not shown, and a line that is not `name: text` is reported", async () => {
    b = await bench({ global: { ".prompts/progress.md": "---\ndescription: Progress.\nformat: lines\n---\nstarted: Reading the turn.\n\ntool: Using {{tool}}.\nthis line has no name\ntool: A second tool line.\n" } });
    const g = loadGuidance(b.host.files, scope);
    const part = await g.part("progress");
    if (part?.format !== "lines") throw new Error("Not read as lines.");
    expect(part.names).toEqual(["started", "tool"]);
    expect(part.line("tool", { tool: "roll" })).toBe("Using roll.");
    expect(part.line("writing")).toBeUndefined();
    expect((await g.problems()).map((p) => [p.line, p.message.slice(0, 30)])).toEqual([
      [8, "This line is not `name: text`,"],
      [9, "`tool` is named on an earlier "],
    ]);
  });
});
