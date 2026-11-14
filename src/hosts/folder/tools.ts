// The folder host's tools (§6.8, §13.6), listed from a manifest. The code that makes the host gives
// what runs each tool, by name; a manifest entry nothing runs is not listed. A tool that names a
// command is not run by the folder host and is not listed (§16: nothing that runs a command acts
// until it is switched on, and the folder host has no way to switch one on).
//
// The list holds for a session (§6.8): the first listing in a session is kept with the session's
// records, and every later one, by this host or by a new one over the same folder, gives it back.

import { join } from "node:path";
import type { FilesPort, HostTool, JsonObject, JsonValue, Log, Scope, ToolCtx, ToolResult, ToolsPort, ToolTier } from "../../contract/index";
import { readJson, writeJson } from "./disk";
import { isRecord, manifest } from "./shape";
import type { Site } from "./site";

/** What runs one of the manifest's tools. */
export type ToolHandler = (args: JsonValue, ctx: ToolCtx) => Promise<ToolResult>;

/** A tool as a session's records keep it: everything but what runs it. */
interface KeptTool {
  name: string;
  family: string;
  tier: ToolTier;
  lane?: string;
  description: string;
  parameters: JsonObject;
}

export function folderTools(site: Site, files: FilesPort, manifestPath: string, handlers: Readonly<Record<string, ToolHandler>>, log: Log): ToolsPort {
  const keptPath = (scope: Scope): string => join(site.chatRecords(scope.chat), "sessions", scope.session, "tools.json");

  function bind(t: KeptTool): HostTool {
    const handler = Object.hasOwn(handlers, t.name) ? handlers[t.name] : undefined;
    return {
      ...t,
      run: async (args, ctx) => {
        if (handler === undefined) throw new Error(`The folder host listed ${t.name} when this session began, and has nothing to run it now.`);
        return handler(args, ctx);
      },
    };
  }

  /** The manifest's tools that this host can run, each once, in the manifest's order. */
  async function listed(scope: Scope): Promise<KeptTool[]> {
    const value = await readJson(manifestPath);
    if (value === undefined) return [];
    const out: KeptTool[] = [];
    for (const t of manifest(manifestPath, value)) {
      if (out.some((o) => o.name === t.name)) {
        log.warn("A tool is listed twice in the manifest; the first is kept.", { tool: t.name, manifest: manifestPath });
        continue;
      }
      if (t.command !== undefined) {
        log.info("A command tool is not run by the folder host; it is left out.", { tool: t.name });
        continue;
      }
      if (!Object.hasOwn(handlers, t.name)) {
        log.warn("A tool in the manifest has nothing to run it; it is left out.", { tool: t.name });
        continue;
      }
      let description = t.description;
      if (description === undefined && t.descriptionFile !== undefined) {
        const read = await files.read(scope, t.descriptionFile);
        if (read.status !== "read") {
          log.warn("A tool's description file cannot be read; the tool is left out.", { tool: t.name, file: t.descriptionFile, status: read.status });
          continue;
        }
        description = read.text;
      }
      if (description === undefined) continue;
      out.push({ name: t.name, family: t.family, tier: t.tier, ...(t.lane !== undefined ? { lane: t.lane } : {}), description, parameters: t.parameters });
    }
    return out;
  }

  return {
    async all(scope) {
      site.check(scope);
      const path = keptPath(scope);
      const kept = await readJson(path);
      if (kept !== undefined) {
        if (!isRecord(kept) || !Array.isArray(kept.tools)) throw new Error(`${path} is not a session's list of tools.`);
        return (kept.tools as KeptTool[]).map(bind);
      }
      const tools = await listed(scope);
      await writeJson(path, { tools });
      return tools.map(bind);
    },
  };
}
