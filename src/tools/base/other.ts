// `skill_load` and `suggest` (§6.8, §5.1). `skill_load` gives a skill's text by its name, through the
// guidance loader, from whichever level has it in force. `suggest` hands the user a proposed change
// to one of their files or to lore, with its reason; the host keeps it for the user to accept, edit
// or dismiss, and nothing is changed by it.
import type { Suggestion } from "../../contract";
import { answer, argumentsOf, fieldsOf, type OwnTool, text } from "../kit";
import { type BaseToolsDeps, wordsOf } from "./deps";

export function skillLoad(deps: BaseToolsDeps): OwnTool {
  const own = deps.texts.get("skill_load");
  return {
    name: "skill_load",
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
    parameters: argumentsOf({ file: { type: "string" }, lore: { type: "string" }, new_lore: { type: "boolean" }, text: { type: "string" }, reason: { type: "string" } }, ["text", "reason"], own),
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
      await deps.env.events.suggestion(ctx.scope, ctx.agent, { target, text: text(given, "text") ?? "", reason: text(given, "reason") ?? "" });
      return answer(words("suggested"));
    },
  };
}
