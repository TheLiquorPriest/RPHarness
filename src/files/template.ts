// The one template syntax of the guidance files (the head of `api.ts` says it whole): fields, blocks
// shown when a field is present, blocks shown when it is absent, and `{{.}}` for a block's item.
// Nothing else, so a template holds no logic. Blocks follow Mustache's rule for a line that holds
// only a block's tag: the line leaves nothing behind, which is how the drafted parts are written.

import type { Fields, ParseTemplate, Problem, Rendered, Template } from "./api";
import type { At } from "./header";
import { problemAt } from "./header";

type Node =
  | { type: "text"; text: string }
  | { type: "field"; path: string }
  | { type: "block"; path: string; inverted: boolean; line: number; children: Node[] };

type Token = { kind: "text"; text: string } | { kind: "field"; path: string } | { kind: "open" | "inverted" | "close"; path: string };

/** A field's path: `.`, or names of letters, digits, `_` and `-` joined by dots. */
const PATH = /^(?:\.|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/;
/** A tag: `{{`, anything but a line break, `}}`. */
const TAG = /\{\{(.*?)\}\}/g;
/** What a list put in with `{{name}}` is joined by. */
const LIST_JOIN = ", ";

/** A value a template reads: JSON from the caller, so anything else is passed over. */
type Value = unknown;

function isObject(v: Value): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a block on this value is left out: absent, null, false, 0, "", an empty list, or an object with no fields (or an empty own value, under "."). */
export function isEmpty(v: Value): boolean {
  if (v === undefined || v === null || v === false || v === "" || v === 0 || Number.isNaN(v)) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObject(v)) return Object.hasOwn(v, ".") ? isEmpty(v["."]) : Object.keys(v).length === 0;
  return false;
}

/** The text a value puts in: an object's is its own value, under ".". */
export function textOf(v: Value): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(textOf).filter((s) => s !== "").join(LIST_JOIN);
  if (isObject(v)) return Object.hasOwn(v, ".") ? textOf(v["."]) : "";
  return "";
}

/** Finds a path among the contexts, innermost last: its first name in the innermost context that has it, the rest strictly from there. */
function lookup(path: string, contexts: readonly Value[]): Value {
  if (path === ".") return contexts[contexts.length - 1];
  const [head = "", ...rest] = path.split(".");
  for (let i = contexts.length - 1; i >= 0; i--) {
    const c = contexts[i];
    if (!isObject(c) || !Object.hasOwn(c, head) || c[head] === undefined) continue;
    let v: Value = c[head];
    for (const name of rest) {
      if (!isObject(v) || !Object.hasOwn(v, name)) return undefined;
      v = v[name];
    }
    return v;
  }
  return undefined;
}

function renderNodes(nodes: readonly Node[], contexts: readonly Value[], out: string[], missing: Set<string>): void {
  for (const node of nodes) {
    if (node.type === "text") out.push(node.text);
    else if (node.type === "field") {
      const v = lookup(node.path, contexts);
      if (v === undefined) missing.add(node.path);
      else out.push(textOf(v));
    } else {
      const v = lookup(node.path, contexts);
      const empty = isEmpty(v);
      if (node.inverted) {
        if (empty) renderNodes(node.children, contexts, out, missing);
      } else if (!empty) {
        if (Array.isArray(v)) for (const item of v) renderNodes(node.children, [...contexts, item], out, missing);
        else renderNodes(node.children, [...contexts, v], out, missing);
      }
    }
  }
}

/** Fills a parsed template from its contexts, outermost first. */
export function renderWith(template: Template, contexts: readonly Value[]): Rendered {
  const nodes = NODES.get(template);
  if (nodes === undefined) throw new Error("This template was not made by parseTemplate.");
  const out: string[] = [];
  const missing = new Set<string>();
  renderNodes(nodes, contexts, out, missing);
  return { text: out.join(""), missing: [...missing] };
}

/** The parsed nodes of each template made here. */
const NODES = new WeakMap<Template, readonly Node[]>();

function tokens(line: string, lineNo: number, at: At, problems: Problem[]): Token[] {
  const out: Token[] = [];
  // Text between tags; a `{{` in it was not closed on its line.
  const text = (s: string) => {
    if (s === "") return;
    if (s.includes("{{")) problems.push(problemAt(at, lineNo, "A `{{` on this line is not closed by `}}` on the same line, and is shown as written."));
    out.push({ kind: "text", text: s });
  };
  let last = 0;
  for (const m of line.matchAll(TAG)) {
    const index = m.index ?? 0;
    text(line.slice(last, index));
    last = index + m[0].length;
    const inner = (m[1] ?? "").trim();
    const sigil = inner[0];
    const kind = sigil === "#" ? "open" : sigil === "^" ? "inverted" : sigil === "/" ? "close" : undefined;
    const path = kind === undefined ? inner : inner.slice(1).trim();
    if (PATH.test(path)) {
      out.push(kind === undefined ? { kind: "field", path } : { kind, path });
      continue;
    }
    // Not a tag this syntax has: shown as written, and said, so a typo is found.
    problems.push(problemAt(at, lineNo, `\`${m[0]}\` is not a field or a block, and is shown as written. A field is \`{{name}}\` or \`{{name.part}}\`; a block is \`{{#name}}…{{/name}}\` or \`{{^name}}…{{/name}}\`.`));
    out.push({ kind: "text", text: m[0] });
  }
  text(line.slice(last));
  return out;
}

export const parseTemplate: ParseTemplate = (text, at) => {
  const problems: Problem[] = [];
  let broken = false;
  const root: Node[] = [];
  const open: { path: string; line: number; children: Node[] }[] = [];
  const fields: string[] = [];
  const named = (path: string) => {
    if (path !== "." && !fields.includes(path)) fields.push(path);
  };
  const into = (): Node[] => open[open.length - 1]?.children ?? root;
  const addText = (s: string) => {
    if (s === "") return;
    const list = into();
    const last = list[list.length - 1];
    if (last?.type === "text") last.text += s;
    else list.push({ type: "text", text: s });
  };

  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const lineNo = at.firstLine + i;
    const toks = tokens(line, lineNo, at, problems);
    const tags = toks.filter((t) => t.kind !== "text");
    const alone = tags.length === 1 && tags[0]?.kind !== "field" && toks.every((t) => t.kind !== "text" || /^[ \t]*$/.test(t.text));
    for (const t of toks) {
      if (t.kind === "text") {
        if (!alone) addText(t.text);
      } else if (t.kind === "field") {
        named(t.path);
        into().push({ type: "field", path: t.path });
      } else if (t.kind === "open" || t.kind === "inverted") {
        named(t.path);
        const block: Node = { type: "block", path: t.path, inverted: t.kind === "inverted", line: lineNo, children: [] };
        into().push(block);
        open.push({ path: t.path, line: lineNo, children: block.children });
      } else {
        const top = open[open.length - 1];
        if (top === undefined) {
          broken = true;
          problems.push(problemAt(at, lineNo, `\`{{/${t.path}}}\` closes a block that was never opened. Open it with \`{{#${t.path}}}\` or \`{{^${t.path}}}\`, or take the line out.`));
        } else if (top.path !== t.path) {
          broken = true;
          problems.push(problemAt(at, lineNo, `\`{{/${t.path}}}\` comes while the block \`${top.path}\` from line ${top.line} is still open. Close that one first with \`{{/${top.path}}}\`.`));
        } else open.pop();
      }
    }
    // A line that held only a block's tag leaves nothing behind, its line break included.
    if (!alone && i < lines.length - 1) addText("\n");
  });
  for (const block of open) {
    broken = true;
    problems.push(problemAt(at, block.line, `The block \`${block.path}\` opened on line ${block.line} is never closed. Add \`{{/${block.path}}}\` where it ends.`));
  }
  if (broken) return { problems };

  const template: Template = {
    text,
    fields,
    render(values) {
      return renderWith(template, [values ?? {}]);
    },
  };
  NODES.set(template, root);
  return { template, problems };
};

/**
 * A text rendered with `fields` exactly as every shipped part is (§5.4 l.560, R-44): the one renderer
 * of both repositories, which a host renders its own texts through (`rp-harness/helpers`). Its text
 * and the fields it put in that had no value; or, where the text does not parse, no text and why.
 */
export function renderTemplate(text: string, fields: Fields = {}, at: At = { path: "" }): { text?: string; missing: string[]; problems: Problem[] } {
  const parsed = parseTemplate(text, { ...at, firstLine: 1 });
  if (parsed.template === undefined) return { missing: [], problems: parsed.problems };
  return { ...parsed.template.render(fields), problems: parsed.problems };
}
