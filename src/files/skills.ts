// Skills (§5.4): the Agent Skills shape, a folder with `SKILL.md` holding a name, a description and
// a body. Only the name and description go in the prompt's index; the body is given when asked for.

import type { FileText } from "../contract/index";
import type { Problem, Replaced, Skill } from "./api";
import { SKILL_FIELDS } from "./api";
import { fieldLine, problemAt, splitHeader, unknownFields } from "./header";

export function parseSkill(file: FileText, name: string, replaces: Replaced[]): { skill?: Skill; problems: Problem[] } {
  const at = { path: file.path, level: file.level };
  const split = splitHeader(file.text, at);
  const problems: Problem[] = [...split.problems];
  if (!split.has) {
    problems.push(problemAt(at, 1, "A skill starts with a header between two `---` lines, with its name and a description: the one line the skills' index shows."));
    return { problems };
  }
  const h = split.header;
  if (h === undefined) return { problems };
  problems.push(...unknownFields(split, SKILL_FIELDS, at, "a skill"));
  if (h.name !== undefined && h.name !== name) {
    problems.push(problemAt(at, fieldLine(split.lines, "name"), `The header names the skill ${JSON.stringify(h.name)} and its folder is ${name}: a skill goes by its folder's name, so this one is ${name}.`));
  }
  if (typeof h.description !== "string" || h.description.trim() === "") {
    problems.push(problemAt(at, fieldLine(split.lines, "description") ?? 2, "It needs a description: the one line the skills' index shows, which is how an agent knows when to load it. Until it has one it is not in the index."));
    return { problems };
  }
  return { skill: { name, description: h.description.trim(), body: split.body, source: { path: file.path, level: file.level, hash: file.hash }, replaces }, problems };
}
