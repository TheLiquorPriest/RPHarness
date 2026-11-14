// Prompt parts (`.prompts/`) and tool descriptions (`.tools/`): an optional header and a body that
// is a template. A part whose header says `format: lines` holds one `name: text` template per line;
// a line the user deleted is a line that is not shown.

import type { FileText, JsonObject } from "../contract/index";
import type { Fields, PartKind, Problem, PromptPart, Replaced, Template } from "./api";
import { fieldLine, problemAt, splitHeader } from "./header";
import { parseTemplate, renderWith } from "./template";

/** A line of a `format: lines` part: a name of letters, digits, `_` and `-`, a colon, and its text. */
const LINE = /^([A-Za-z0-9_-]+):[ \t]?(.*)$/;

export function parsePart(file: FileText, name: string, kind: PartKind, replaces: Replaced[]): { part?: PromptPart; problems: Problem[] } {
  const at = { path: file.path, level: file.level };
  const split = splitHeader(file.text, at);
  const problems: Problem[] = [...split.problems];
  if (split.has && split.header === undefined) return { problems };
  const header = (split.header ?? {}) as JsonObject;
  const base = {
    name,
    kind,
    ...(typeof header.description === "string" ? { description: header.description } : {}),
    header,
    source: { path: file.path, level: file.level, hash: file.hash },
    replaces,
  };

  if (header.format === "lines") {
    const lines = new Map<string, Template>();
    const names: string[] = [];
    split.body.split("\n").forEach((text, i) => {
      const lineNo = split.bodyLine + i;
      if (text.trim() === "") return;
      const m = LINE.exec(text);
      if (m === null) {
        problems.push(problemAt(at, lineNo, "This line is not `name: text`, so it is not used. Each line of this file is one name, a colon, and its text."));
        return;
      }
      const lineName = m[1] ?? "";
      if (lines.has(lineName)) {
        problems.push(problemAt(at, lineNo, `\`${lineName}\` is named on an earlier line too; the earlier line is the one used.`));
        return;
      }
      const parsed = parseTemplate((m[2] ?? "").trimEnd(), { ...at, firstLine: lineNo });
      problems.push(...parsed.problems);
      if (parsed.template === undefined) return;
      lines.set(lineName, parsed.template);
      names.push(lineName);
    });
    return {
      part: {
        ...base,
        format: "lines",
        names,
        lines,
        line(lineName: string, fields?: Fields) {
          const template = lines.get(lineName);
          return template === undefined ? undefined : renderWith(template, [header, fields ?? {}]).text;
        },
      },
      problems,
    };
  }

  if (header.format !== undefined && header.format !== "template") {
    problems.push(problemAt(at, fieldLine(split.lines, "format"), `\`format:\` is \`lines\` for one \`name: text\` per line; ${JSON.stringify(header.format)} is not a format, so the file is not used.`));
    return { problems };
  }
  const parsed = parseTemplate(split.body, { ...at, firstLine: split.bodyLine });
  problems.push(...parsed.problems);
  const template = parsed.template;
  if (template === undefined) return { problems };
  return { part: { ...base, format: "template", template, render: (fields?: Fields) => renderWith(template, [header, fields ?? {}]) }, problems };
}
