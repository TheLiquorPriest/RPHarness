// Agent definitions (§5.4): a header that says what the agent runs on, holds, reads and is given,
// and who writes the reply when it hands the prose on, and a body that is its instructions. A field
// the code cannot read is reported and left out; a definition is broken (not used) only when its
// header or its body cannot be read at all. A body that names a field no run fills (`BODY_FIELDS`)
// is reported, and the field is put in empty.
//
// The header's lists of names are written one name to a line or as one bracketed list. A bracketed
// list is cut only at the commas outside brackets, parentheses and braces, so every name stays whole
// (R-134): the plan's own `given: [chat:history[scene], world:scene(full, map)]` holds two names,
// where YAML alone refuses the first and cuts the second in two.

import type { Effort, FileText, ToolsAs } from "../contract/index";
import type { AgentDefinition, DefinitionLimits, Problem, Replaced } from "./api";
import { BODY_FIELDS, DEFINITION_FIELDS } from "./api";
import type { At, Split } from "./header";
import { fieldLine, isMapping, nameList, problemAt, splitHeader, unknownFields } from "./header";
import { parseTemplate } from "./template";

const EFFORTS: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TOOLS_AS: readonly ToolsAs[] = ["auto", "native", "text"];

/** The limits a definition can set; `time` is in seconds there. */
const LIMITS = ["calls", "tokensIn", "tokensOut", "time"] as const;

/** The header's fields that hold lists of names. */
const LISTS = ["tools", "out_of_reach", "reads", "given"] as const;

/** A list field's line when its value is a bracketed list, up to and with its `[`. */
const LIST_START = new RegExp(`^(?:${LISTS.join("|")})[ \\t]*:[ \\t]+\\[`);

/** Inside an item of a list, the mark that closes each opening one. */
const CLOSES: Readonly<Record<string, string | undefined>> = { "[": "]", "(": ")", "{": "}" };

/** Where an item of a bracketed list stands: its line among the header's, and its first and past-last columns. */
interface Span {
  line: number;
  from: number;
  to: number;
}

/**
 * The bracketed list whose `[` is at column `at` of `lines[first]`, cut into items at the commas
 * outside brackets, parentheses and braces: where each item stands that YAML would refuse or cut
 * (one that holds a bracket, a brace or a comma, unless it is quoted or is a list or a mapping
 * itself), and the line the list ends on. Undefined when the list does not close, a later line of
 * it is not indented, something other than a comment follows it, or such an item runs onto a second
 * line: YAML reads those as it always has, and reports them at their line.
 */
function cutList(lines: readonly string[], first: number, at: number): { cut: Span[]; last: number } | undefined {
  const cut: Span[] = [];
  /** The marks that close what is open inside the item being read, innermost last. */
  const closers: string[] = [];
  /** The item being read: where its first and last marks stand, its first mark, and whether YAML would cut it. */
  let item: { line: number; from: number; lastLine: number; to: number; first: string; cuts: boolean } | undefined;
  let quote: string | undefined;
  for (let n = first; n < lines.length; n++) {
    const line = lines[n] ?? "";
    // YAML reads the later lines of a list only when they are indented.
    if (n > first && /^[^ \t#]/.test(line)) return undefined;
    for (let i = n === first ? at + 1 : 0; i < line.length; i++) {
      const c = line.charAt(i);
      if (quote !== undefined) {
        // `\"` inside double quotes, and `''` inside single ones, do not close them.
        if (quote === '"' && c === "\\") i++;
        else if (c === quote && quote === "'" && line.charAt(i + 1) === "'") i++;
        else if (c === quote) quote = undefined;
        continue;
      }
      if (c === "#" && (i === 0 || line.charAt(i - 1) === " " || line.charAt(i - 1) === "\t")) break;
      if (c === " " || c === "\t") continue;
      if (closers.length === 0 && (c === "," || c === "]")) {
        if (item?.cuts === true && !"\"'[{".includes(item.first)) {
          if (item.lastLine !== item.line) return undefined;
          cut.push({ line: item.line, from: item.from, to: item.to });
        }
        item = undefined;
        if (c === ",") continue;
        return /^(?:[ \t]*|[ \t]+#.*)$/.test(line.slice(i + 1)) ? { cut, last: n } : undefined;
      }
      if (item === undefined) {
        item = { line: n, from: i, lastLine: n, to: i + 1, first: c, cuts: false };
        // As in YAML, a quote opens a quoted item only at its start.
        if (c === "'" || c === '"') {
          quote = c;
          continue;
        }
      }
      const closer = CLOSES[c];
      if (closer !== undefined) closers.push(closer);
      else if ((c === "]" || c === ")" || c === "}") && closers.pop() !== c) return undefined;
      if ("[]{},".includes(c)) item.cuts = true;
      item.lastLine = n;
      item.to = i + 1;
    }
  }
  return undefined;
}

/**
 * The header's lines with each item of a bracketed list that YAML would refuse or cut put in quotes
 * where it stands, so YAML reads it whole. Every line keeps its number, so whatever is found later
 * is reported at its line in the file.
 */
function quoteLists(lines: readonly string[]): readonly string[] {
  let out: string[] | undefined;
  for (let n = 0; n < lines.length; n++) {
    const start = LIST_START.exec(lines[n] ?? "");
    const list = start === null ? undefined : cutList(lines, n, start[0].length - 1);
    if (list === undefined) continue;
    // From the last, so the columns of the items before it on its line still stand.
    for (const { line, from, to } of list.cut.reverse()) {
      out ??= [...lines];
      const text = out[line] ?? "";
      out[line] = `${text.slice(0, from)}${JSON.stringify(text.slice(from, to))}${text.slice(to)}`;
    }
    n = list.last;
  }
  return out ?? lines;
}

/** The file split as `splitHeader` splits it, and split again with its lists' items quoted when one of them needs it. */
function splitDefinition(text: string, at: At): Split {
  const split = splitHeader(text, at);
  const lines = quoteLists(split.lines);
  return lines === split.lines ? split : splitHeader(["---", ...lines, "---", split.body].join("\n"), at);
}

/**
 * One agent definition's file, read as RPH reads it (§5.4): the definition, absent when its header
 * or its body cannot be read at all, and every problem with the file, at its line. `name` is the
 * file's name without `.md`, which the agent goes by; `replaces`, the farther files of that name it
 * replaces; `definitions`, the name of every definition in the same scope, one of which a `writer:`
 * must name.
 */
export function parseDefinition(file: FileText, name: string, replaces: Replaced[], definitions: Pick<ReadonlySet<string>, "has">): { definition?: AgentDefinition; problems: Problem[] } {
  const at = { path: file.path, level: file.level };
  const split = splitDefinition(file.text, at);
  const problems: Problem[] = [...split.problems];
  if (!split.has) {
    problems.push(problemAt(at, 1, `An agent definition starts with a header between two \`---\` lines: ${DEFINITION_FIELDS.join(", ")}. Its instructions follow the header.`));
    return { problems };
  }
  const h = split.header;
  if (h === undefined) return { problems };
  problems.push(...unknownFields(split, DEFINITION_FIELDS, at, "an agent definition"));
  const line = (key: string) => fieldLine(split.lines, key);

  if (h.name !== undefined && h.name !== name) {
    problems.push(problemAt(at, line("name"), `The header names the agent ${JSON.stringify(h.name)} and the file is ${name}.md: an agent goes by its file's name, so this one is ${name}.`));
  }
  let description = "";
  if (typeof h.description === "string" && h.description.trim() !== "") description = h.description.trim();
  else problems.push(problemAt(at, line("description") ?? 2, "It needs a description: one line on what the agent is for, which is what a lead reads when it chooses whom to hand a task."));

  let model: string | undefined;
  if (typeof h.model === "string" && h.model.trim() !== "") model = h.model.trim();
  else if (h.model !== undefined && h.model !== null) problems.push(problemAt(at, line("model"), "`model:` names a connection profile, as one word or in quotes."));

  let effort: Effort | undefined;
  if (h.effort !== undefined && h.effort !== null) {
    effort = EFFORTS.find((e) => e === h.effort);
    if (effort === undefined) problems.push(problemAt(at, line("effort"), `\`effort:\` is one of ${EFFORTS.join(", ")}; ${JSON.stringify(h.effort)} is not, so the model's own is used.`));
  }

  let toolsAs: ToolsAs | undefined;
  if (h.tools_as !== undefined && h.tools_as !== null) {
    toolsAs = TOOLS_AS.find((t) => t === h.tools_as);
    if (toolsAs === undefined) problems.push(problemAt(at, line("tools_as"), `\`tools_as:\` is one of ${TOOLS_AS.join(", ")}; ${JSON.stringify(h.tools_as)} is not, so its tools go natively until its model's connection refuses them.`));
  }

  const list = (key: (typeof LISTS)[number], what: string): string[] => {
    const names = nameList(h[key]);
    if (names !== undefined) return names;
    problems.push(problemAt(at, line(key), `\`${key}:\` is a list of ${what}, \`[a, b]\` or one \`- a\` line each; as written it is left out.`));
    return [];
  };
  const tools = list("tools", "tools by name");
  const outOfReach = list("out_of_reach", "families of tools a search does not reach");
  const reads = list("reads", "instruction files by name, with `rules` for the always-on rules");
  const given = list("given", "what the agent is handed by name");

  const limits: DefinitionLimits = {};
  if (h.limits !== undefined && h.limits !== null) {
    if (!isMapping(h.limits)) problems.push(problemAt(at, line("limits"), `\`limits:\` is \`{ calls: 12 }\`, with any of ${LIMITS.join(", ")} (time in seconds).`));
    else {
      for (const [key, value] of Object.entries(h.limits)) {
        const limit = LIMITS.find((l) => l === key);
        if (limit === undefined) {
          problems.push(problemAt(at, line("limits"), `\`${key}\` is not a limit a definition can set; those are ${LIMITS.join(", ")} (time in seconds).`));
          continue;
        }
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
          problems.push(problemAt(at, line("limits"), `The limit \`${key}\` must be a whole number above 0; ${JSON.stringify(value)} is left out.`));
          continue;
        }
        limits[limit] = limit === "time" ? value * 1000 : value;
      }
    }
  }

  // Who writes is in the definitions (§10.6): code names no writer of its own, so an agent whose header names none has none.
  let writer: string | undefined;
  if (typeof h.writer === "string" && h.writer.trim() !== "") {
    writer = h.writer.trim();
    if (!definitions.has(writer)) problems.push(problemAt(at, line("writer"), `\`writer:\` names ${JSON.stringify(writer)}, and no agent definition has that name. It names the agent \`write_reply\` hands the prose to, by its file's name (\`narrator\` for \`narrator.md\`).`));
  } else if (h.writer !== undefined && h.writer !== null) {
    problems.push(problemAt(at, line("writer"), "`writer:` names the agent `write_reply` hands the prose to, by its file's name, as one word; as written it is left out."));
  }

  const body = parseTemplate(split.body, { ...at, firstLine: split.bodyLine });
  problems.push(...body.problems);
  if (body.template === undefined) return { problems };
  const bodyLines = split.body.split("\n");
  for (const field of body.template.fields) {
    const head = field.split(".")[0] ?? "";
    if ((BODY_FIELDS as readonly string[]).includes(head)) continue;
    const named = bodyLines.findIndex((text) => [...text.matchAll(/\{\{\s*[#^/]?\s*([^}]*?)\s*\}\}/g)].some((tag) => tag[1] === field));
    problems.push(problemAt(at, split.bodyLine + Math.max(named, 0), `The body names {{${field}}}, which nothing fills: a body may name ${BODY_FIELDS.map((name) => `{{${name}}}`).join(", ")}. It is put in empty.`));
  }
  return {
    definition: {
      name,
      description,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(toolsAs !== undefined ? { toolsAs } : {}),
      tools,
      outOfReach,
      reads,
      given,
      limits,
      ...(writer !== undefined ? { writer } : {}),
      instructions: body.template,
      source: { path: file.path, level: file.level, hash: file.hash },
      replaces,
    },
    problems,
  };
}
