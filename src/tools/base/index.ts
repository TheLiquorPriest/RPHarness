// RPH's base tools over the host's ports (§6.8): the chat, the lore, a gap check across every place
// the host can search, skills, suggestions to the user, a search of the chat's earlier sessions and
// the host's other stores, and a search of the web once the user sets a provider. The harness reads
// their files with its other tools' (`BASE_TOOLS`) and adds `baseTools` to RPH's own tools, for the
// environment it runs in.
import type { OwnTool } from "../kit";
import { chatRead, chatSearch } from "./chat";
import type { BaseToolsDeps } from "./deps";
import { gapCheck } from "./gap";
import { loreRead, loreSearch } from "./lore";
import { skillLoad, suggest } from "./other";
import { archiveSearch, webSearch } from "./searches";

export { BASE_PART, type BaseToolsDeps } from "./deps";
export { SKILL_LOAD, SKILLS_PART, skillsIndex } from "./other";

/** The names of these tools, whose files the harness reads with its other tools' (`.tools/<name>.md`). */
export const BASE_TOOLS = ["chat_read", "chat_search", "lore_read", "lore_search", "gap_check", "skill_load", "suggest", "archive_search", "web_search"] as const;

/** The base tools for an environment, every one for every host: `archive_search` reaches RPH's own earlier sessions where the host has no other stores, and `web_search` answers that it is off until the host's web searcher is on. */
export function baseTools(deps: BaseToolsDeps): OwnTool[] {
  return [
    chatRead(deps),
    chatSearch(deps),
    loreRead(deps),
    loreSearch(deps),
    gapCheck(deps),
    skillLoad(deps),
    suggest(deps),
    archiveSearch(deps, deps.env.stores),
    webSearch(deps, deps.web),
  ];
}
