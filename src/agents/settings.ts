// The user's limits on sub-agents (§10.11: "sub-agent depth and count ... every one is a
// setting"), from the config files of the chat's levels, the nearer level's value over the farther
// one's. A value that is not one the setting takes is logged with its file and passed over, and the
// default holds; it never stops a turn.
//
// The keys, in each level's config file (YAML), beside the turn's other limits:
//
//   limits:
//     turn:
//       depth: 2     how deep a sub-agent may stand: 1, the lead's own; 2, the ones they start too; 0, none
//       agents: 24   sub-agents one turn may start in all; ~ for no limit
import type { FilesPort, JsonValue, Log, Scope } from "../contract";
import type { Guidance } from "../files/api";

export interface AgentSettings {
  /** How deep a sub-agent may stand: the lead's own stand at 1, the ones they start at 2. 0: none is started. */
  depth: number;
  /** Sub-agents one turn may start in all; absent is no limit. */
  agents?: number;
}

/** The defaults, where no level sets a value: today's build's own (LumiAH's `delegation.depth` and `delegation.perRun`), kept as §10.11 says. */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = { depth: 2, agents: 24 };

type Mapping = { [key: string]: JsonValue };

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWhole(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A setting as the nearest level that sets it has it, and that level's file. */
interface Found {
  value: JsonValue;
  path: string;
}

/** The limits on sub-agents of a scope, as its config files set them over the defaults. */
export async function readAgentSettings(guidance: Guidance, files: FilesPort, scope: Scope, log: Log): Promise<AgentSettings> {
  let depth: Found | undefined;
  let agents: Found | undefined;
  // Farthest first, so a nearer level's value stands over a farther one's.
  for (const layer of await guidance.layers()) {
    if (layer.config === undefined) continue;
    const path = `${layer.mount}${layer.config}`;
    const read = await files.read(scope, path);
    if (read.status !== "read" || read.text.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(read.text);
    } catch {
      // The harness's own settings say in the log that the file does not parse.
      continue;
    }
    const limits = isMapping(parsed) ? parsed["limits"] : undefined;
    const turn = isMapping(limits) ? limits["turn"] : undefined;
    if (!isMapping(turn)) continue;
    const depthValue = turn["depth"];
    const agentsValue = turn["agents"];
    if (depthValue !== undefined) depth = { value: depthValue, path };
    if (agentsValue !== undefined) agents = { value: agentsValue, path };
  }
  const passed = (setting: string, found: Found): void => {
    log.warn("A setting has a value it does not take; its default holds.", { setting, value: found.value, files: found.path });
  };
  let settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  if (depth !== undefined) {
    if (isWhole(depth.value)) settings = { ...settings, depth: depth.value };
    else passed("limits.turn.depth", depth);
  }
  if (agents !== undefined) {
    // `agents: ~` (null) lifts the limit.
    if (agents.value === null) {
      const { agents: _lifted, ...rest } = settings;
      settings = rest;
    } else if (isWhole(agents.value)) settings = { ...settings, agents: agents.value };
    else passed("limits.turn.agents", agents);
  }
  return settings;
}
