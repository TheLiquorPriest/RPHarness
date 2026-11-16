// His own tools (§5.4 "Tools", P15, §6.8 l.759): one manifest each in `.tools/` (manifest.ts), a
// command it runs or an address it calls, its description its `.tools/<name>.md` guide like every
// tool's. Each is a tool of the external tier, under the `external` permission, its command line or
// address the thing the host's switches must have on: found by `tool_search` and run only then,
// pinned or found (the gate and the search ask). Its arguments are data: JSON on stdin, or the body.

import type { HostTool, JsonObject, JsonValue, SwitchesPort } from "../contract";
import type { Guidance, ToolManifest } from "../files/api";
import { toolTextOf } from "../harness/means";
import type { SecretTerms } from "../model/words";
import type { ToolText, Words } from "../tools/kit";
import { callCommandTool } from "./command";
import { callHttpTool } from "./http";

/** What his tools run under, from his settings: milliseconds, and bytes read of an answer. */
export interface ExternalTerms {
  commandTimeout: number;
  httpTimeout: number;
  answerMax: number;
  secrets: SecretTerms;
}

export interface OwnerToolsDeps {
  guidance: Guidance;
  switches: SwitchesPort | undefined;
  words: Words;
  terms: ExternalTerms;
  /** A secret's value for the user's tools, by its name. */
  secret(user: string, name: string): Promise<string | undefined>;
}

/** The manifest's schema, each property given the words its guide's `arguments:` has for it where the schema has none. */
function described(parameters: JsonObject, text: ToolText | undefined): JsonObject {
  const properties = parameters.properties;
  if (text === undefined || typeof properties !== "object" || properties === null || Array.isArray(properties)) return parameters;
  const out: Record<string, JsonValue> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const words = text.arguments[name];
    out[name] = words !== undefined && typeof schema === "object" && schema !== null && !Array.isArray(schema) && schema.description === undefined ? { ...schema, description: words } : schema;
  }
  return { ...parameters, properties: out };
}

/** A manifest as a tool. */
function ownerTool(d: OwnerToolsDeps, m: ToolManifest, text: ToolText | undefined): HostTool {
  const runs = m.runs;
  const tool = { name: m.name, family: m.family, tier: "external" as const, description: text?.description ?? "", parameters: described(m.parameters, text) };
  if ("command" in runs) {
    const timeoutMs = m.timeout !== undefined ? m.timeout * 1000 : d.terms.commandTimeout;
    return { ...tool, switchable: { kind: "command-tool", name: m.name, target: runs.command }, run: (args, ctx) => callCommandTool({ tool: m.name, command: runs.command, args, ctx, timeoutMs, readMost: d.terms.answerMax, switches: d.switches, words: d.words }) };
  }
  const timeoutMs = m.timeout !== undefined ? m.timeout * 1000 : d.terms.httpTimeout;
  return {
    ...tool,
    switchable: { kind: "http-tool", name: m.name, target: runs.address },
    run: (args, ctx) => callHttpTool({ tool: m.name, address: runs.address, method: runs.method, headers: runs.headers, args, ctx, timeoutMs, readMost: d.terms.answerMax, switches: d.switches, words: d.words, secret: (name) => d.secret(ctx.scope.user, name), secrets: d.terms.secrets }),
  };
}

/** His tools as the scope's files write them now: the registry's third source. */
export async function ownerTools(d: OwnerToolsDeps): Promise<HostTool[]> {
  const manifests = await d.guidance.manifests();
  return Promise.all(manifests.map(async (m) => ownerTool(d, m, toolTextOf(await d.guidance.tool(m.name)))));
}
