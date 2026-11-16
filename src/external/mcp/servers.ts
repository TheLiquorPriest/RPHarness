// His MCP servers as the harness keeps them (§5.4, P15, §16): each started, or reached, when it is
// first needed once the host's switches have it on for the user, its tools listed then; kept while
// it lives; one that died is said and started again at the next need; all stopped when the harness
// closes. A server is kept by its user, its name and exactly what it runs, so a changed command line
// or address is a new server, and waits for its own switch. Its tools are of the external tier,
// under the server's family, found by search and pinnable; their answers are data, and every
// secret the server was given is taken out of what reaches the model, a trace or a page.

import type { HostTool, JsonObject, JsonValue, Log, SwitchesPort, ToolContent, ToolResult } from "../../contract";
import type { Guidance } from "../../files/api";
import type { McpServer } from "../../files/mcp";
import { toolTextOf } from "../../harness/means";
import { redact } from "../../model/words";
import { answer, type Words } from "../../tools/kit";
import type { ExternalTerms } from "../tools";
import { McpClient, ServerGone } from "./client";

/** What a server is started with: the user's secrets, by name, and his settings in milliseconds. */
export interface McpTerms extends ExternalTerms {
  startMs: number;
  callMs: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tool's name: its server's, then its own, in the letters every provider takes, at most 64 long. */
function toolName(server: string, tool: string): string {
  return `${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** A server running for a user, or starting, with the secrets it was given. */
interface Kept {
  client: Promise<McpClient>;
  secrets: string[];
}

export class McpServers {
  readonly #switches: SwitchesPort | undefined;
  readonly #secret: (user: string, name: string) => Promise<string | undefined>;
  readonly #log: Log;
  readonly #kept = new Map<string, Kept>();
  /** Why a server could not be started or reached, by its key, as last tried: what the list shows as its problem. */
  readonly #failed = new Map<string, string>();
  #closed = false;

  constructor(deps: { switches: SwitchesPort | undefined; secret: (user: string, name: string) => Promise<string | undefined>; log: Log }) {
    this.#switches = deps.switches;
    this.#secret = deps.secret;
    this.#log = deps.log;
  }

  static key(user: string, server: McpServer): string {
    return JSON.stringify([user, server.name, "command" in server.runs ? server.runs.command : server.runs.address]);
  }

  /** What exactly the server runs or calls: what its switch is for. */
  static target(server: McpServer): string {
    return "command" in server.runs ? server.runs.command : server.runs.address;
  }

  /** Why the server could not be started or reached when it was last tried, if it could not. */
  problem(user: string, server: McpServer): string | undefined {
    return this.#failed.get(McpServers.key(user, server));
  }

  /** The server, started or reached once the switches have it on: its client, or why there is none (`waiting`, `off`, or words). */
  async #running(user: string, server: McpServer, terms: McpTerms): Promise<{ client: McpClient; secrets: string[] } | { not: "waiting" | "off" } | { failed: string }> {
    const state = this.#switches === undefined ? "off" : await this.#switches.state(user, { kind: "mcp-server", name: server.name, target: McpServers.target(server) });
    if (state !== "on") return { not: state };
    if (this.#closed) return { failed: "the harness is closing" };
    const key = McpServers.key(user, server);
    let kept = this.#kept.get(key);
    if (kept === undefined) {
      const named = "command" in server.runs ? server.env : server.runs.headers;
      const values: Record<string, string> = {};
      for (const [field, secret] of Object.entries(named)) {
        const value = await this.#secret(user, secret);
        if (value === undefined) return { failed: `the secret ${secret} it is given as ${field} is not set` };
        values[field] = value;
      }
      const secrets = Object.values(values);
      const client = McpClient.start(server, { values, startMs: terms.startMs, readMost: terms.answerMax });
      kept = { client, secrets };
      this.#kept.set(key, kept);
      const mine = kept;
      client.then(
        (started) => {
          this.#failed.delete(key);
          // A server that dies is let go, and started again at the next need.
          void started.ended.then((why) => {
            if (this.#kept.get(key) !== mine) return;
            this.#kept.delete(key);
            if (!this.#closed) this.#log.warn("An MCP server stopped; it is started again when next needed.", { server: server.name, why: redact(why, secrets, terms.secrets) });
          });
        },
        (error: unknown) => {
          if (this.#kept.get(key) === mine) this.#kept.delete(key);
          this.#failed.set(key, redact(errorText(error), secrets, terms.secrets));
        },
      );
    }
    try {
      return { client: await kept.client, secrets: kept.secrets };
    } catch (error) {
      return { failed: redact(errorText(error), kept.secrets, terms.secrets) };
    }
  }

  /**
   * The tools of the scope's servers that are switched on, each started or reached as it is first
   * needed: tools of the external tier under the server's family, their descriptions their guides'
   * (`.tools/<tool's name>.md`) where there is one, else the server's own. A server that waits, is
   * off, or could not start gives none, and the last is logged.
   */
  async tools(user: string, servers: readonly McpServer[], guidance: Guidance, terms: McpTerms, words: Words): Promise<HostTool[]> {
    const lists = await Promise.all(
      servers.map(async (server): Promise<HostTool[]> => {
        const running = await this.#running(user, server, terms);
        if ("failed" in running) this.#log.warn("An MCP server could not be started or reached; its tools are not offered this time.", { server: server.name, why: running.failed });
        if (!("client" in running)) return [];
        return Promise.all(
          running.client.tools.map(async (tool): Promise<HostTool> => {
            const name = toolName(server.name, tool.name);
            const text = toolTextOf(await guidance.tool(name));
            return {
              name,
              family: server.name,
              tier: "external",
              description: text?.description ?? tool.description ?? "",
              parameters: tool.inputSchema,
              switchable: { kind: "mcp-server", name: server.name, target: McpServers.target(server) },
              run: (args, ctx) => this.#call(ctx.scope.user, server, tool.name, name, args, ctx.signal, terms, words),
            };
          }),
        );
      }),
    );
    return lists.flat();
  }

  /** One call of a server's tool, within `mcp.callTimeout`: its answer as data, or why there is none, in the file's words. */
  async #call(user: string, server: McpServer, own: string, tool: string, args: JsonValue, signal: AbortSignal, terms: McpTerms, words: Words): Promise<ToolResult> {
    const running = await this.#running(user, server, terms);
    if ("not" in running) return answer(words("not_switched_on", { tool, name: server.name, kind: "mcp-server", ...(running.not === "waiting" ? { waiting: true } : {}) }), true);
    if ("failed" in running) {
      this.#log.warn("An MCP server could not be started or reached for a call.", { server: server.name, why: running.failed });
      return answer(words("server_failed", { tool, server: server.name }), true);
    }
    const clean = (text: string): string => redact(text, running.secrets, { ...terms.secrets, wordsMost: Number.MAX_SAFE_INTEGER });
    const timeout = AbortSignal.timeout(terms.callMs);
    const started = performance.now();
    let result;
    try {
      result = await running.client.call(own, args, AbortSignal.any([signal, timeout]));
    } catch (error) {
      if (signal.aborted) throw new Error("The call was stopped with its run.");
      if (timeout.aborted) return answer(words("timed_out", { tool, seconds: terms.callMs / 1000 }), true);
      // A server that died in the call is said; it is started again at the next call.
      if (error instanceof ServerGone) return answer(words("server_stopped", { tool, server: server.name }), true);
      throw new Error(clean(`The MCP server ${server.name} failed the call: ${errorText(error)}`));
    }
    const content: ToolContent[] = [];
    for (const part of result.content) {
      const p = part as JsonObject;
      if (p.type === "text" && typeof p.text === "string") content.push({ type: "text", text: clean(p.text) });
      else if (p.type === "image" && typeof p.data === "string" && typeof p.mimeType === "string") content.push({ type: "image", data: p.data, mimeType: p.mimeType });
      else content.push({ type: "text", text: clean(JSON.stringify(part)) });
    }
    if (content.length === 0 && result.structuredContent !== undefined) content.push({ type: "text", text: clean(JSON.stringify(result.structuredContent)) });
    const details: JsonValue = { server: server.name, ms: Math.round(performance.now() - started) };
    if (content.length === 0) return { ...answer(words("empty_answer", { tool }), result.isError === true), details };
    return { content, ...(result.isError === true ? { error: true as const } : {}), details };
  }

  /** Stops every server: the harness is closing. */
  async close(): Promise<void> {
    this.#closed = true;
    const kept = [...this.#kept.values()];
    this.#kept.clear();
    await Promise.all(kept.map((k) => k.client.then((client) => client.close()).catch(() => undefined)));
  }
}
