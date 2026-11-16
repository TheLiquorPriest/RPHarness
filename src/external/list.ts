// One list of everything a scope's files name that runs a command or calls out (§16, C3): rule
// commands, command tools, HTTP tools' addresses and MCP servers (hooks join it with their package),
// each with where it is written, exactly what it runs or calls, where it stands as the host's
// switches say as it is listed, and what keeps it from working. A thing just written in a file, or
// added from the UI, or changed, is listed waiting; the switch itself stays on the server's command
// line (R-46).

import type { ExternalEntry, SwitchableKind, SwitchesPort } from "../contract";
import type { Guidance } from "../files/api";
import type { McpServers } from "./mcp/servers";

export async function externalList(guidance: Guidance, switches: SwitchesPort | undefined, servers: McpServers): Promise<ExternalEntry[]> {
  const user = guidance.scope.user;
  // A file that writes neither a command nor an address has nothing to switch on.
  const stateOf = async (kind: SwitchableKind, name: string, runs: string) => (runs === "" || switches === undefined ? "off" : await switches.state(user, { kind, name, target: runs }));
  const [rules, manifests, mcp] = await Promise.all([guidance.rules(switches), guidance.manifestFiles(), guidance.mcpServers()]);
  // The examples are never in force, so nothing of theirs runs.
  const commands = rules.flatMap((rule): ExternalEntry[] => (rule.command !== undefined && rule.why !== "example" ? [{ kind: "rule-command", name: rule.name, runs: rule.command.runs, path: rule.path, level: rule.level, state: rule.command.state }] : []));
  const tools = await Promise.all(
    manifests.map(async (read): Promise<ExternalEntry> => {
      const kind = read.written?.kind ?? "command-tool";
      const runs = read.written?.runs ?? "";
      return { kind, name: read.name, runs, path: read.path, level: read.level, state: await stateOf(kind, read.name, runs), ...(read.problems.length > 0 ? { problem: read.problems.join(" ") } : {}) };
    }),
  );
  const mcpServers = await Promise.all(
    mcp.map(async (read): Promise<ExternalEntry> => {
      const runs = read.written ?? "";
      // Besides what its file lacks, a server that could not be started or reached when last needed says why.
      const problems = [...read.problems, ...(read.server !== undefined ? [servers.problem(user, read.server)].filter((p): p is string => p !== undefined) : [])];
      return { kind: "mcp-server", name: read.name, runs, path: read.path, level: read.level, state: await stateOf("mcp-server", read.name, runs), ...(problems.length > 0 ? { problem: problems.join(" ") } : {}) };
    }),
  );
  return [...commands, ...tools, ...mcpServers];
}
