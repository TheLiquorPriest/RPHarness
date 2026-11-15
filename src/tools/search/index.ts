// Tool search (§6.8): `tool_search` and `tool_use`, an agent's way to every tool it may reach beyond
// its fixed list. The harness reads their files with its other tools' (`SEARCH_TOOLS`), gives them
// what the registry and the gate know (`ToolReach`), and adds `searchTools` to RPH's own tools.
import type { OwnTool } from "../kit";
import { TOOL_SEARCH, TOOL_USE } from "./reach";
import { toolSearch, type ToolSearchDeps, toolUse } from "./tools";

export { plainRank, type Rank } from "./rank";
export { type AgentReach, type ReachableTool, TOOL_SEARCH, TOOL_USE, type ToolReach } from "./reach";
export { takes } from "./takes";
export { SEARCH_PART, toolSearch, type ToolSearchDeps, toolUse } from "./tools";

/** The names of these tools, whose files the harness reads with its other tools' (`.tools/<name>.md`). */
export const SEARCH_TOOLS = [TOOL_SEARCH, TOOL_USE] as const;

/** Tool search's two tools, over what the harness gives them. */
export function searchTools(deps: ToolSearchDeps): OwnTool[] {
  return [toolSearch(deps), toolUse(deps)];
}
