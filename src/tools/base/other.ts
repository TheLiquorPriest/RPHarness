// `skill_load` and `suggest` (§6.8, §5.1). `skill_load` gives a skill's text by its name, through the
// guidance loader, from whichever level has it in force; `skillsIndex` lists the skills in force, by
// name and description, for an agent that holds it (§5.4: only names and descriptions sit in the
// prompt). `suggest` hands the user a proposed change to one of their files or to lore, with its
// reason; the host keeps it for the user to accept, edit or dismiss, and nothing is changed by it. A
// file is named as the agents' view has it.
import type { Suggestion } from "../../contract";
import type { Guidance } from "../../files/api";
import { answer, argumentsOf, fieldsOf, type OwnTool, text } from "../kit";
import { type BaseToolsDeps, noticesOf, textsOf, wordsOf } from "./deps";

/** The tool that gives a skill's text by its name. */
export const SKILL_LOAD = "skill_load";

/** The part that lists the skills in force (`.prompts/skills.md`). */
export const SKILLS_PART = "skills";

/**
 * The skills in force, each by its name and the description its header gives, laid out by the
 * skills part, for an agent that can call `skill_load`, which loads them by those names: it holds
 * it, or it holds `tool_use` and the skills' family is in its reach (the caller says which). Empty
 * for any other agent, while no skill is in force, or when the part is not a template.
 */
export async function skillsIndex(guidance: Pick<Guidance, "part" | "skills">, canLoad: boolean): Promise<string> {
  if (!canLoad) return "";
  const [part, skills] = await Promise.all([guidance.part(SKILLS_PART), guidance.skills()]);
  if (part?.format !== "template" || skills.length === 0) return "";
  return part.render({ skills: skills.map(({ name, description }) => ({ name, description })) }).text;
}

export function skillLoad(deps: BaseToolsDeps): OwnTool {
  const own = deps.texts.get(SKILL_LOAD);
  return {
    name: SKILL_LOAD,
    family: "skills",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ name: { type: "string" } }, ["name"], own),
    async run(args) {
      const name = (text(fieldsOf(args), "name") ?? "").trim();
      const [words, skill] = await Promise.all([wordsOf(deps.guidance), name === "" ? undefined : deps.guidance.skill(name)]);
      if (skill === undefined) return answer(words("no_skill", { name }), true);
      return answer(skill.body);
    },
  };
}

export function suggest(deps: BaseToolsDeps): OwnTool {
  const own = deps.texts.get("suggest");
  return {
    name: "suggest",
    family: "suggestions",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf(
      { file: { type: "string" }, lore: { type: "string" }, new_lore: { type: "boolean" }, text: { type: "string" }, reason: { type: "string" }, book: { type: "string" }, title: { type: "string" }, keys: { type: "array", items: { type: "string" } }, was: { type: "string" } },
      ["text", "reason"],
      own,
    ),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const file = text(given, "file")?.trim() || undefined;
      const lore = text(given, "lore")?.trim() || undefined;
      const targets: Suggestion["target"][] = [...(file !== undefined ? [{ file }] : []), ...(lore !== undefined ? [{ lore }] : []), ...(given["new_lore"] === true ? [{ newLore: true as const }] : [])];
      const words = await wordsOf(deps.guidance);
      const [target] = targets;
      if (target === undefined || targets.length > 1) return answer(words("suggest_target"), true);
      // An entry the agent may not read is one it cannot have a change for.
      if (lore !== undefined && (await deps.env.lore.read(ctx.scope, [lore], ctx.agent)).length === 0) return answer(words("no_entry", { id: lore }), true);
      let handed = target;
      if (file !== undefined) {
        // A path that leaves the view, or passes through a link, is no file of the user's that anyone could change (§5.1).
        const read = await deps.env.files.read(ctx.scope, file, { start: 1, end: 1 });
        if (read.status === "refused") return answer((await noticesOf(deps.guidance))(`refused_${read.reason}`, { path: read.path, writable: read.writable }), true);
        handed = { file: read.path };
      }
      // A lore suggestion carries its draft whole (§9.5): a new entry's book, title and keys; an edit's passage as it stands.
      const book = text(given, "book")?.trim() || undefined;
      const title = text(given, "title")?.trim() || undefined;
      const keys = textsOf(given["keys"]).map((key) => key.trim()).filter((key) => key !== "");
      const draft = "newLore" in handed ? { ...(book !== undefined ? { book } : {}), ...(title !== undefined ? { title } : {}), ...(keys.length > 0 ? { keys } : {}) } : {};
      const was = "lore" in handed ? text(given, "was") : undefined;
      await deps.env.events.suggestion(ctx.scope, ctx.agent, { target: handed, text: text(given, "text") ?? "", reason: text(given, "reason") ?? "", ...(Object.keys(draft).length > 0 ? { draft } : {}), ...(was !== undefined && was !== "" ? { was } : {}) });
      return answer(words("suggested"));
    },
  };
}
