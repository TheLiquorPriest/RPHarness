// RPH's base tools over the host's ports (§6.8): the chat, the lore, a gap check across every place
// the host can search, skills, suggestions to the user, and searches of the host's other stores and
// of the web where the host offers them. The harness reads their files with its other tools'
// (`BASE_TOOLS`) and adds `baseTools` to RPH's own tools, for the environment it runs in.
import type { OwnTool } from "../kit";
import { chatRead, chatSearch } from "./chat";
import type { BaseToolsDeps } from "./deps";
import { gapCheck } from "./gap";
import { loreRead, loreSearch } from "./lore";
import { skillLoad, suggest } from "./other";
import { archiveSearch, webSearch } from "./searches";

// The contract carries the web searcher; the base tools' own tests name it from here.
export type { WebSearchPort } from "../../contract";
export { BASE_PART, type BaseToolsDeps } from "./deps";
export { SKILL_LOAD, SKILLS_PART, skillsIndex } from "./other";

/** The names of these tools, whose files the harness reads with its other tools' (`.tools/<name>.md`). */
export const BASE_TOOLS = ["chat_read", "chat_search", "lore_read", "lore_search", "gap_check", "skill_load", "suggest", "archive_search", "web_search"] as const;

/** The base tools for an environment: `archive_search` only while the host has other stores, and `web_search` only while it offers a web searcher. */
export function baseTools(deps: BaseToolsDeps): OwnTool[] {
  const { stores } = deps.env;
  return [
    chatRead(deps),
    chatSearch(deps),
    loreRead(deps),
    loreSearch(deps),
    gapCheck(deps),
    skillLoad(deps),
    suggest(deps),
    ...(stores !== undefined ? [archiveSearch(deps, stores)] : []),
    ...(deps.web !== undefined ? [webSearch(deps, deps.web)] : []),
  ];
}
