// The folder host's tools (§6.8, §13.6), listed from a manifest. The code that makes the host gives
// what runs each tool, by name; a manifest entry nothing runs is not listed. A tool that names a
// command (`command`) is the host's own command tool: of the external tier, its command line the
// thing the host's switches must have on (§16), run through RPH's command runner with its arguments
// as JSON on stdin and the JSON it prints as its answer, under the host's own limits.
//
// The list holds for a session (§6.8): the first listing in a session is kept with the session's
// records, and every later one, by this host or by a new one over the same folder, gives it back.

import { join } from "node:path";
import type { FilesPort, HostTool, JsonObject, JsonValue, Log, RunScope, SwitchesPort, ToolCtx, ToolResult, ToolsPort, ToolTier } from "../../contract/index";
import { isRecord } from "../../contract/json";
import { runCommand } from "../../external/run";
import { hostLimits } from "./config";
import { readJson, safeId, writeJson } from "./disk";
import { manifest } from "./shape";
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
  /** A command tool's command line. */
  command?: string;
}

export function folderTools(site: Site, files: FilesPort, manifestPath: string, handlers: Readonly<Record<string, ToolHandler>>, log: Log, switches: SwitchesPort): ToolsPort {
  const keptPath = (scope: RunScope): string => join(site.recordsOf(scope), "sessions", safeId("session", scope.session), "tools.json");

  /** A command tool's call: run once switched on; its JSON answer is the result, anything else is said in the error the call fails with. */
  async function commanded(t: KeptTool & { command: string }, args: JsonValue, ctx: ToolCtx): Promise<ToolResult> {
    const limits = await hostLimits(site);
    const ran = await runCommand({ command: t.command, kind: "command-tool", name: t.name, user: ctx.scope.user, input: args, timeoutMs: limits.commandTimeout * 1000, readMost: limits.answerMax, signal: ctx.signal }, switches);
    if (ran.status === "failed") throw new Error(`${t.name}'s command could not be started: ${ran.why}`);
    if (ran.status !== "ran") throw new Error(`${t.name} is not switched on (${ran.status}).`);
    if (ran.timedOut) throw new Error(`${t.name} did not answer within ${limits.commandTimeout} seconds.`);
    if (ran.cut) throw new Error(`${t.name} answered more than ${limits.answerMax} bytes.`);
    if (ran.exit !== 0) throw new Error(`${t.name}'s command ended with code ${ran.exit ?? "none"}: ${ran.stderr.trim().slice(-500)}`);
    if (ran.output === undefined) throw new Error(`${t.name} answered with something that is not JSON: ${ran.text.trim().slice(0, 500)}`);
    return { content: [{ type: "text", text: JSON.stringify(ran.output) }], details: { ms: ran.ms } };
  }

  function bind(t: KeptTool): HostTool {
    const { command } = t;
    if (command !== undefined) {
      const { command: _command, ...shown } = t;
      return { ...shown, tier: "external", switchable: { kind: "command-tool", name: t.name, target: command }, run: (args, ctx) => commanded({ ...t, command }, args, ctx) };
    }
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
  async function listed(scope: RunScope): Promise<KeptTool[]> {
    const value = await readJson(manifestPath);
    if (value === undefined) return [];
    const out: KeptTool[] = [];
    for (const t of manifest(manifestPath, value)) {
      if (out.some((o) => o.name === t.name)) {
        log.warn("A tool is listed twice in the manifest; the first is kept.", { tool: t.name, manifest: manifestPath });
        continue;
      }
      if (t.command === undefined && !Object.hasOwn(handlers, t.name)) {
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
      out.push({ name: t.name, family: t.family, tier: t.command !== undefined ? "external" : t.tier, ...(t.lane !== undefined ? { lane: t.lane } : {}), description, parameters: t.parameters, ...(t.command !== undefined ? { command: t.command } : {}) });
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
