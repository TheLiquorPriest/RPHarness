// Agent definitions (§5.4): a header that says what the agent runs on, holds, reads and is given,
// and a body that is its instructions. A field the code cannot read is reported and left out; a
// definition is broken (not used) only when its header or its body cannot be read at all.

import type { Effort, FileText } from "../contract/index";
import type { AgentDefinition, DefinitionLimits, Problem, Replaced } from "./api";
import { DEFINITION_FIELDS } from "./api";
import { fieldLine, isMapping, nameList, problemAt, splitHeader, unknownFields } from "./header";
import { parseTemplate } from "./template";

const EFFORTS: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The limits a definition can set; `time` is in seconds there. */
const LIMITS = ["calls", "tokensIn", "tokensOut", "time"] as const;

export function parseDefinition(file: FileText, name: string, replaces: Replaced[]): { definition?: AgentDefinition; problems: Problem[] } {
  const at = { path: file.path, level: file.level };
  const split = splitHeader(file.text, at);
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

  const list = (key: "tools" | "out_of_reach" | "reads" | "given", what: string): string[] => {
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

  const body = parseTemplate(split.body, { ...at, firstLine: split.bodyLine });
  problems.push(...body.problems);
  if (body.template === undefined) return { problems };
  return {
    definition: {
      name,
      description,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      tools,
      outOfReach,
      reads,
      given,
      limits,
      instructions: body.template,
      source: { path: file.path, level: file.level, hash: file.hash },
      replaces,
    },
    problems,
  };
}
