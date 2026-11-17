// An agent's opening block (§5.2, §10.2), made in one place for every agent (the lead, a sub-agent, a
// job's agent, the writer) and for the Files page, which lists exactly what the agent gets: its stack's
// opening parts in §5.2's order, its definition's body filled in; for a lead, the reply contract
// rendered for its connection's form; the guide of each family of tools it holds (`.tools/<family>.md`,
// R-66); each held tool's description, which its
// declaration carries in the cached front; the skills' index, for an agent that can call
// `skill_load`; what its definition's `opening:` names, as the host answered when the session opened;
// and then what the briefing is handed, with the situations that add it. A pinned file is no part of
// it: a run's start hands it, read whole then (R-174).
import { createHash } from "node:crypto";
import type { Wanted } from "../agents/attachments";
import { attach, type Given, joined } from "../agents/attachments";
import type { AgentRef, Environment, Log, Scope, StackPart } from "../contract";
import type { AgentDefinition, Fields, FrontPart, Guidance, PromptPart, Stack, StackEntry, StackSnapshot, TemplatePart } from "../files/api";
import { splitHeader } from "../files/header";
import { changes, changesText, snapshot } from "../files/stack";
import type { ReplyTags } from "../reply/tags";
import { SKILL_LOAD, SKILLS_PART, skillsIndex } from "../tools/base/other";
import type { HeldTool, Registry } from "../tools/registry";
import { TOOL_USE } from "../tools/search";
import { lines, template, toolTextOf } from "./means";
import type { Opening } from "./sessions";
import { formFor, type ReplyFormSetting, type Settings } from "./settings";

/** How what an agent is given by name beyond its own blocks is laid out (`.prompts/given.md`): the lead's and the writer's after their blocks, and what a lead's definition gives as its session opens. */
export const GIVEN_PART = "given";
/** How a chat message and a lore entry are laid out in what an agent is given (`.prompts/delegation.md`). */
export const DELEGATION_PART = "delegation";

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
  /** The stack as it was read: its briefing's parts for the turn's situations. */
  stack: Stack;
  /** The parts that are compared across a session, each with its text or why it is left out. */
  front: FrontPart[];
  /** What it holds, to keep with the session and compare a later block with. */
  snapshot: StackSnapshot;
  /** The skills' index it holds; empty when it holds none. */
  skills: string;
  /** The reply contract as it holds it (a lead's). */
  contract?: string;
}

/**
 * What an agent is sent of an instruction file: its body. Its header block (`depths:`, `modes:`, what
 * the host's controls read) stays out of what the agent gets, and in the file for the host. A header
 * with no closing line is no header: the whole text goes.
 */
function sentOf(entry: StackEntry, text: string): string {
  if (entry.kind !== "instruction") return text;
  const split = splitHeader(text, { path: entry.path, level: entry.level });
  // An unclosed header reads as no lines and no body: then the whole text goes.
  const closed = split.has && (split.lines.length > 0 || split.body !== "");
  return closed ? split.body.replace(/^\n+/, "") : text;
}

/** A stack's entry as a part of the block: its own fields, without what only the stack keeps; an instruction file's text without its header block. */
function partOf(entry: StackEntry, text: string | undefined): StackPart {
  return {
    kind: entry.kind,
    part: entry.part,
    path: entry.path,
    level: entry.level,
    ...(entry.hash !== undefined ? { hash: entry.hash } : {}),
    where: entry.where,
    ...(entry.left !== undefined ? { left: entry.left } : {}),
    ...(text !== undefined ? { text: sentOf(entry, text).trimEnd() } : {}),
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
  const front: FrontPart[] = [];
  /** A part of the opening, which a later block is compared with. */
  const fronted = (part: StackPart, layered?: true): void => {
    parts.push(part);
    front.push({ part: part.part, path: part.path, level: part.level, ...(layered !== undefined ? { layered } : {}), ...(part.text !== undefined ? { text: part.text } : {}), ...(part.left !== undefined ? { left: part.left } : {}) });
  };
  for (const entry of stack.entries) {
    if (entry.where !== "opening") continue;
    if (entry.kind !== "definition" || entry.left !== undefined || definition === undefined) {
      fronted(partOf(entry, entry.text), entry.layered);
      continue;
    }
    const rendered = definition.instructions.render(o.fields);
    if (rendered.missing.length > 0) log?.warn("An agent's definition names fields nothing fills.", { agent: definition.name, fields: rendered.missing });
    fronted(partOf(entry, rendered.text), entry.layered);
  }
  let contract: string | undefined;
  if (o.contract !== undefined) {
    const { part, form } = o.contract;
    contract = joined([part.render({ form: form === "tags" ? { tags: true } : { two_step: true } }).text]);
    fronted(filePart("contract", `prompts/${part.name}`, part.source, contract));
  }
  // The guide of each family of the tools it holds, where its file is: how to call them (R-66).
  for (const family of new Set(o.tools.map((tool) => tool.family))) {
    if (o.isTool(family)) continue;
    const guide = template(await guidance.tool(family));
    if (guide !== undefined) fronted(filePart("guide", `tools/${family}`, guide.source, guide.render().text));
  }
  // Each held tool of RPH's own, described by its file: the description its declaration carries, as the file has it now.
  for (const tool of o.tools) {
    if (tool.from !== "rph") continue;
    const file = await guidance.tool(tool.name);
    if (file !== undefined) fronted(filePart("description", `tools/${tool.name}`, file.source, toolTextOf(file)?.description ?? tool.description));
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
  return { text, parts, stack, front, snapshot: snapshot(o.agent, front), skills, ...(contract !== undefined ? { contract } : {}) };
}

/**
 * What of a block made earlier no longer stands, given the same agent's block made now from the files
 * as they stand (§5.2, §10.2): each part changed, with its whole current text, or off, in the
 * `notices` part's `file_changed` and `file_off` lines; then, when the skills' index is another, its
 * `skills_changed` line and the index as it stands. Empty when all of it stands.
 */
export function changedText(made: { snapshot: StackSnapshot; skills?: string }, now: OpeningBlock, notices: PromptPart | undefined): string {
  const files = changesText(changes(made.snapshot, now.front), notices);
  if (now.skills === (made.skills ?? "")) return files;
  const line = notices?.format === "lines" ? notices.line("skills_changed", now.skills !== "" ? { listed: true } : {}) : undefined;
  return joined([files, line ?? "", now.skills]);
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

/** The tag names a reply contract's header gives, when it gives both. */
function tagsOf(header: Readonly<Record<string, unknown>>): ReplyTags | undefined {
  const tags = header["tags"];
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) return undefined;
  const { reply, intent } = tags as Record<string, unknown>;
  return typeof reply === "string" && typeof intent === "string" ? { reply, intent } : undefined;
}

/** What a lead's opening block is made from: as its session's first turn makes it, or as the owner's "Apply now" makes it afresh at his press (R-119). */
export interface LeadOpeningOf {
  env: Environment;
  scope: Scope;
  /** The lead, as the reader of what its definition's `opening:` names. */
  lead: AgentRef;
  guidance: Guidance;
  definition: AgentDefinition;
  /** The tools the session's runs hold, as the turn registers them. */
  registry: Registry;
  settings: Settings;
  /** The connection the lead runs on, for the form its replies take. */
  connection: { id: string | null; name: string | null };
  contract: TemplatePart | undefined;
  /** A slice of the prompt by its name as written, for what `opening:` names of it. */
  slice: (ref: string, reader: AgentRef) => Promise<string | undefined>;
}

/**
 * A lead's opening block, which holds still for the session (§5.2, §10.2), made by the one builder;
 * what its definition's `opening:` names is asked of the host once, here (§8.2, R-163). Or why it
 * cannot be made: the reply's form is the tags and the contract names none.
 */
export async function leadOpening(o: LeadOpeningOf): Promise<Opening | "no-tags"> {
  const { env, guidance, definition, registry, settings, contract } = o;
  const { form, stream } = formFor(settings, o.connection);
  let tags: ReplyTags | undefined;
  let intentFile: string | undefined;
  if (contract !== undefined) {
    tags = tagsOf(contract.header);
    const file = contract.header["intent_file"];
    intentFile = typeof file === "string" && file !== "" ? file : undefined;
  }
  if (form === "tags" && tags === undefined) return "no-tags";
  const held = registry.hold(definition.tools);
  const [layout, delegation] = await Promise.all([guidance.part(GIVEN_PART), guidance.part(DELEGATION_PART)]);
  const items = await attach({ env, scope: o.scope, lines: lines(delegation), most: settings.perCall, moment: { task: "" }, slice: o.slice }, o.lead, definition.opening.map((ref) => ({ ref, from: "opening" as const })));
  if (items.missing.length > 0) env.log.warn("What the lead's definition gives as its session opens could not be found.", { agent: definition.name, missing: items.missing });
  // The skills in the block stand as the session opened it, and the briefing says when the list no longer does.
  const block = await openingOf({ guidance, agent: definition.name, definition, tools: held.tools, isTool: (name) => registry.has(name), ...(contract !== undefined ? { contract: { part: contract, form } } : {}), items: { given: items, layout: template(layout) }, log: env.log });
  return {
    text: block.text,
    snapshot: block.snapshot,
    ...(block.skills !== "" ? { skills: block.skills } : {}),
    tools: [...definition.tools],
    given: [...definition.given],
    outOfReach: [...definition.outOfReach],
    declared: Object.fromEntries(held.tools.map((tool) => [tool.name, { description: tool.description, parameters: tool.parameters }])),
    form,
    stream,
    ...(tags !== undefined ? { tags } : {}),
    ...(intentFile !== undefined ? { intentFile } : {}),
    ...(block.contract !== undefined && block.contract !== "" ? { contract: block.contract } : {}),
  };
}
