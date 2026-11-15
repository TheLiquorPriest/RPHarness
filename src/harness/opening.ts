// An agent's opening block (§5.2, §10.2): what it is made of, and which of its parts it holds.
import { SKILL_LOAD } from "../tools/base/other";
import { TOOL_USE } from "../tools/search";

/** The family `skill_load` belongs to, which a definition's `out_of_reach:` may keep from a search. */
const SKILLS_FAMILY = "skills";

/**
 * Whether an agent can call `skill_load`, and so is given the skills' index (§5.4): it holds it, or
 * it holds `tool_use` and the skills' family is not out of its reach (§6.8). The fixed list is not
 * touched (R-65).
 */
export function canLoadSkills(tools: readonly { name: string }[], outOfReach: readonly string[]): boolean {
  const holds = (name: string): boolean => tools.some((tool) => tool.name === name);
  return holds(SKILL_LOAD) || (holds(TOOL_USE) && !outOfReach.includes(SKILLS_FAMILY));
}
