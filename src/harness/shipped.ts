// RPH's own shipped files (§13.1): what any roleplay host would want, laid out like a host's tree
// (`.prompts/`, `.rules/`, `.tools/`, `.agents/`). A host puts this folder under its own files as the
// lowest layer, and a host's file of the same name replaces RPH's.
//
// Two of them are read here, from this folder, rather than through a host's files: the text a
// connection's test call sends and the mark of a system message sent in place. The model layer
// asks for both with no chat in view, and the host's file port reads only within a chat.
import { fileURLToPath } from "node:url";
import { parseTemplate } from "../files";
import type { Template } from "../files/api";

/** The folder of RPH's own shipped files, to put under a host's files as the lowest layer. */
export const SHIPPED_GUIDANCE = fileURLToPath(new URL("../../guidance/", import.meta.url));

/** One of RPH's own prompt parts, read from the shipped folder: a template with no header. */
export async function shippedTemplate(name: string): Promise<Template> {
  const path = `${SHIPPED_GUIDANCE}.prompts/${name}.md`;
  const text = await Bun.file(path).text();
  const parsed = parseTemplate(text.endsWith("\n") ? text.slice(0, -1) : text, { path: `.prompts/${name}.md`, level: "shipped", firstLine: 1 });
  if (parsed.template === undefined) throw new Error(`RPH's own ${name}.md does not parse: ${parsed.problems.map((problem) => problem.message).join(" ")}`);
  return parsed.template;
}
