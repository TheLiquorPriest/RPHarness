// The owner's own commands and calls out (§5.4, §16; P15), as the harness uses them: his tools for a
// run's registry (its third source, after RPH's own and the host's): command tools, HTTP tools and
// his MCP servers' tools; a rule's command asked yes or no; and the list of everything that runs a
// command or calls out with where each stands (C3). All of it waits on the host's switches: without
// them, nothing here runs. His MCP servers are kept running between runs, and stopped at `close`.

import type { ExternalApi, ExternalEntry, FilesPort, HostTool, Log, Scope, SwitchesPort } from "../contract";
import { loadGuidance } from "../files";
import type { Guidance, RuleRunOptions } from "../files/api";
import type { Settings } from "../harness/settings";
import type { Words } from "../tools/kit";
import { askRuleCommand } from "./command";
import { externalList } from "./list";
import { McpServers } from "./mcp/servers";
import { ownerTools } from "./tools";

export interface ExternalDeps {
  files: FilesPort;
  switches: SwitchesPort | undefined;
  /** A secret's value for the user's tools and servers, by its name (the model layer's `toolSecret`, C4). */
  secret(user: string, name: string): Promise<string | undefined>;
  log: Log;
}

/** The settings his tools, servers and rule commands run under. */
export type ExternalSettings = Pick<Settings, "commandTimeout" | "httpTimeout" | "answerMax" | "ruleCommandTimeout" | "mcpStartTimeout" | "mcpCallTimeout" | "model">;

export class External implements ExternalApi {
  readonly #d: ExternalDeps;
  readonly #servers: McpServers;

  constructor(deps: ExternalDeps) {
    this.#d = deps;
    this.#servers = new McpServers({ switches: deps.switches, secret: deps.secret, log: deps.log });
  }

  list(scope: Scope): Promise<ExternalEntry[]> {
    return externalList(loadGuidance(this.#d.files, scope), this.#d.switches, this.#servers);
  }

  /** His tools as the run's files write them, for its registry: his manifests' and those of his MCP servers that are switched on, each server started when first needed. */
  async tools(guidance: Guidance, settings: ExternalSettings, words: Words): Promise<HostTool[]> {
    const terms = { commandTimeout: settings.commandTimeout, httpTimeout: settings.httpTimeout, answerMax: settings.answerMax, secrets: { wordsMost: settings.model.wordsMost, secretFloor: settings.model.secretFloor } };
    const servers = (await guidance.mcpServers()).flatMap((read) => (read.server !== undefined ? [read.server] : []));
    const [own, mcp] = await Promise.all([ownerTools({ guidance, switches: this.#d.switches, words, terms, secret: this.#d.secret }), this.#servers.tools(guidance.scope.user, servers, guidance, { ...terms, startMs: settings.mcpStartTimeout, callMs: settings.mcpCallTimeout }, words)]);
    return [...own, ...mcp];
  }

  /** How a run's rules ask a rule's command (`RuleRunOptions.command`), under the user's `rules.commandTimeoutSeconds`. */
  ruleCommands(user: string, settings: ExternalSettings): NonNullable<RuleRunOptions["command"]> {
    return (_agent, rule, input) => askRuleCommand({ rule: rule.rule, command: rule.command, user, input, timeoutMs: settings.ruleCommandTimeout, readMost: settings.answerMax, switches: this.#d.switches });
  }

  /** Stops every MCP server: the harness is closing. */
  close(): Promise<void> {
    return this.#servers.close();
  }
}
