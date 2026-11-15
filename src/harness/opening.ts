// An agent's opening block (§5.2, §10.2), made in one place for every agent (the lead, a sub-agent, a
// job's agent, the writer) and for the Files page, which lists exactly what the agent gets: its stack's
// opening parts in §5.2's order, its definition's body filled in; for a lead, the reply contract
// rendered for its connection's form; the guide of each family of tools it holds (`.tools/<family>.md`,
// R-66); each held tool's description, which its declaration carries in the cached front; the skills'
// index, for an agent that can call `skill_load`; what its definition's `opening:` names, as the host
// answered when the session opened; and then what the briefing is handed, with the situations that add
// it. A pinned file is no part of it: a run's start hands it, read whole then (R-174).
import { createHash } from "node:crypto";
import type { Wanted } from "../agents/attachments";
import { type Given, joined } from "../agents/attachments";
import type { Log, StackPart } from "../contract";
import type { AgentDefinition, Fields, Guidance, Stack, StackEntry, TemplatePart } from "../files/api";
import { SKILL_LOAD, SKILLS_PART, skillsIndex } from "../tools/base/other";
import type { HeldTool } from "../tools/registry";
import { TOOL_USE } from "../tools/search";
import { template } from "./means";
import type { ReplyFormSetting } from "./settings";

/** The family `skill_load` belongs to, which a definition's `out_of_reach:` may keep from a search. */
const SKILLS_FAMILY = "skills";

/** How `given:` and a pin name a file (`file:scratch/scene.md`, §5.4). */
const FILE = "file:";

/**
 * Whether an agent can call `skill_load`, and so is given the skills' index (§5.4): it holds it, or
 * it holds `tool_use` and the skills' family is not out of its reach (§6.8). The fixed list is not
 * touched (R-65).
 */
export function canLoadSkills(tools: readonly { name: string }[], outOfReach: readonly string[]): boolean {
  const holds = (name: string): boolean => tools.some((tool) => tool.name === name);
  return holds(SKILL_LOAD) || (holds(TOOL_USE) && !outOfReach.includes(SKILLS_FAMILY));
}

export interface OpeningOf {
  guidance: Guidance;
  /** The agent, by its definition's name. */
  agent: string;
  /** Its definition in force; none when it is missing, off or broken, which its stack says. */
  definition: AgentDefinition | undefined;
  /** The tools it holds, as the registry holds them for its definition's list. */
  tools: readonly HeldTool[];
  /** Whether a name is a tool's: a family of that name has no guide of its own. */
  isTool(name: string): boolean;
  /** A sub-agent's body fields (`fieldsOf`); none for a lead, whose block holds for the session. */
  fields?: Fields;
  /** For a lead: the reply contract, rendered for the form its connection's replies take. */
  contract?: { part: TemplatePart; form: ReplyFormSetting };
  /** The turn's situations, for the briefing's parts; none: every situation that could add one, each with its part. */
  situations?: readonly string[];
  /**
   * What its definition's `opening:` names, as found when the session opened, and the part that lays
   * out what an agent is given. None outside a session: those parts are listed without their text.
   */
  items?: { given: Given; layout: TemplatePart | undefined };
  /** Where a run's start says what of its stack cannot be used; a page's list says nothing. */
  log?: Log;
}

export interface OpeningBlock {
  /** Its text: every part in the opening, in order, but the tools' descriptions, which their declarations carry. */
  text: string;
  /** Every part, given or left out: the opening's, then the briefing's (`definitions.stack`). */
  parts: StackPart[];
  /** The stack as it was read, for the session's snapshot. */
  stack: Stack;
  /** The skills' index it holds; empty when it holds none. */
  skills: string;
  /** The reply contract as it holds it (a lead's). */
  contract?: string;
}

/** A stack's entry as a part of the block: its own fields, without what only the stack keeps. */
function partOf(entry: StackEntry, text: string | undefined): StackPart {
  return {
    kind: entry.kind,
    part: entry.part,
    path: entry.path,
    level: entry.level,
    ...(entry.hash !== undefined ? { hash: entry.hash } : {}),
    where: entry.where,
    ...(entry.left !== undefined ? { left: entry.left } : {}),
    ...(text !== undefined ? { text: text.trimEnd() } : {}),
    ...(entry.situations !== undefined ? { situations: [...entry.situations] } : {}),
  };
}

/** A file's part of the block, from a part or a tool description in force; its text as laid out, without the line ends after it. */
function filePart(kind: StackPart["kind"], part: string, source: { path: string; level: StackPart["level"]; hash: string }, text: string): StackPart {
  return { kind, part, path: source.path, level: source.level, hash: source.hash, where: "opening", text: text.trimEnd() };
}

/** The one builder of an agent's opening block and of its list of parts. */
export async function openingOf(o: OpeningOf): Promise<OpeningBlock> {
  const { guidance, definition, log } = o;
  const stack = await guidance.stack(o.agent, o.situations !== undefined ? { situations: o.situations } : {});
  for (const problem of stack.problems) log?.warn("A file of an agent's stack cannot be used.", { agent: o.agent, path: problem.path, problem: problem.message });
  const parts: StackPart[] = [];
  for (const entry of stack.entries) {
    if (entry.where !== "opening") continue;
    if (entry.kind !== "definition" || entry.left !== undefined || definition === undefined) {
      parts.push(partOf(entry, entry.text));
      continue;
    }
    const rendered = definition.instructions.render(o.fields);
    if (rendered.missing.length > 0) log?.warn("An agent's definition names fields nothing fills.", { agent: definition.name, fields: rendered.missing });
    parts.push(partOf(entry, rendered.text));
  }
  let contract: string | undefined;
  if (o.contract !== undefined) {
    const { part, form } = o.contract;
    contract = joined([part.render({ form: form === "tags" ? { tags: true } : { two_step: true } }).text]);
    parts.push(filePart("contract", `prompts/${part.name}`, part.source, contract));
  }
  // The guide of each family of the tools it holds, where its file is: how to call them (R-66).
  for (const family of new Set(o.tools.map((tool) => tool.family))) {
    if (o.isTool(family)) continue;
    const guide = template(await guidance.tool(family));
    if (guide !== undefined) parts.push(filePart("guide", `tools/${family}`, guide.source, guide.render().text));
  }
  // Each held tool of RPH's own, described by its file: the description as its declaration carries it.
  for (const tool of o.tools) {
    if (tool.from !== "rph") continue;
    const file = await guidance.tool(tool.name);
    if (file !== undefined) parts.push(filePart("description", `tools/${tool.name}`, file.source, tool.description));
  }
  const skills = await skillsIndex(guidance, canLoadSkills(o.tools, definition?.outOfReach ?? []));
  const skillsPart = skills === "" ? undefined : await guidance.part(SKILLS_PART);
  if (skillsPart !== undefined) parts.push(filePart("skills", `prompts/${SKILLS_PART}`, skillsPart.source, skills));
  // What its definition's `opening:` names: given once, as the session opens (§8.2, R-163).
  for (const ref of definition?.opening ?? []) {
    const at = { kind: "given" as const, part: ref, path: definition?.source.path ?? "", level: definition?.source.level ?? "chat", where: "opening" as const };
    if (o.items === undefined) {
      parts.push(at);
      continue;
    }
    const found = o.items.given.blocks.find((block) => block.name === ref);
    if (found === undefined) {
      parts.push({ ...at, left: "missing" });
      continue;
    }
    const text = o.items.layout === undefined ? found.text : joined([o.items.layout.render({ attachments: [{ name: found.name, text: found.text }] }).text]);
    parts.push({ ...at, hash: createHash("sha256").update(text).digest("hex"), text });
  }
  for (const entry of stack.entries) if (entry.where === "briefing") parts.push(partOf(entry, entry.text));
  const text = joined(parts.flatMap((part) => (part.where === "opening" && part.kind !== "description" && part.left === undefined && part.text !== undefined ? [part.text] : [])));
  return { text, parts, stack, skills, ...(contract !== undefined ? { contract } : {}) };
}

/**
 * The files pinned for an agent, as a run's start hands them, read whole then (R-174): each told to
 * the host as a pin. Each that cannot be handed is logged by the run, in its own words, naming the
 * file and the agent it is pinned for.
 */
export async function pinsOf(guidance: Guidance, agent: string, log: Log): Promise<Wanted[]> {
  const pins = await guidance.pins(agent);
  for (const pin of pins) if (pin.problem !== undefined) log.warn("A file pinned for an agent cannot be handed.", { agent, file: pin.file, problem: pin.problem.message });
  return pins.map((pin) => ({ ref: `${FILE}${pin.file}`, from: "pin" as const }));
}
