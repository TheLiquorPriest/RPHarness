// One list of everything a scope's files name that runs a command or calls out (§16, C3): rule
// commands, command tools and HTTP tools' addresses (hooks and MCP servers join it with their
// packages), each with where it is written, exactly what it runs or calls, where it stands as the
// host's switches say as it is listed, and what keeps it from working. A thing just written in a
// file, or changed, is listed waiting; the switch itself stays on the server's command line (R-46).

import type { ExternalEntry, SwitchesPort } from "../contract";
import type { Guidance } from "../files/api";

export async function externalList(guidance: Guidance, switches: SwitchesPort | undefined): Promise<ExternalEntry[]> {
  const user = guidance.scope.user;
  const [rules, manifests] = await Promise.all([guidance.rules(switches), guidance.manifestFiles()]);
  // The examples are never in force, so nothing of theirs runs.
  const commands = rules.flatMap((rule): ExternalEntry[] => (rule.command !== undefined && rule.why !== "example" ? [{ kind: "rule-command", name: rule.name, runs: rule.command.runs, path: rule.path, level: rule.level, state: rule.command.state }] : []));
  const tools = await Promise.all(
    manifests.map(async (read): Promise<ExternalEntry> => {
      const kind = read.written?.kind ?? "command-tool";
      const runs = read.written?.runs ?? "";
      // A file that writes neither a command nor an address has nothing to switch on.
      const state = runs === "" || switches === undefined ? "off" : await switches.state(user, { kind, name: read.name, target: runs });
      return { kind, name: read.name, runs, path: read.path, level: read.level, state, ...(read.problems.length > 0 ? { problem: read.problems.join(" ") } : {}) };
    }),
  );
  return [...commands, ...tools];
}
