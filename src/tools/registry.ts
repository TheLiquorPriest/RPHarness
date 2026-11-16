// The tool registry (§6.8, §13.1): RPH's own tools and the host's, by name. An agent holds exactly
// the tools its definition lists; a name nobody registered is left out and reported, never an error.
// A lead's session holds the list it opened with (`opened`): RPH, not the host, holds what its
// requests carry, so a tool the host withdraws mid-session stays declared and answers that it is gone.
import type { HostTool, JsonSchema, Switchable, ToolTier } from "../contract";
import type { LoopTool, LoopToolResult } from "../loop/types";
import type { OwnTool } from "./kit";

/** A tool as an agent holds it, with what the user's permissions are judged by. */
export interface HeldTool extends LoopTool {
  family: string;
  tier: ToolTier;
  lane?: string;
  /** RPH's own, or the host's. */
  from: "rph" | "host";
  /** For a tool that runs a command or calls out (an MCP server's tool, a command tool, an HTTP tool): what it runs or calls, which the host's switches must have on. */
  switchable?: Switchable;
}

export interface Held {
  /** The tools, in the order the definition lists them. */
  tools: HeldTool[];
  /** Names the definition lists that no tool answers to. */
  missing: string[];
}

export class Registry {
  readonly #tools = new Map<string, HeldTool>();
  /** Host tools left out because one of RPH's own has the name. */
  readonly shadowed: string[] = [];

  constructor(own: readonly OwnTool[], host: readonly HostTool[]) {
    for (const tool of own) this.#tools.set(tool.name, { ...tool, from: "rph" });
    for (const tool of host) {
      // A host's tool never takes the name of one of RPH's own (Appendix A); one that does is left out.
      if (this.#tools.has(tool.name)) {
        this.shadowed.push(tool.name);
        continue;
      }
      this.#tools.set(tool.name, { name: tool.name, description: tool.description, parameters: tool.parameters, run: (args, ctx) => tool.run(args, ctx), family: tool.family, tier: tool.tier, ...(tool.lane !== undefined ? { lane: tool.lane } : {}), ...(tool.switchable !== undefined ? { switchable: tool.switchable } : {}), from: "host" });
    }
  }

  /** Whether a tool answers to the name. */
  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Every tool registered, RPH's own first: everything an agent may reach by searching (§6.8). */
  all(): HeldTool[] {
    return [...this.#tools.values()];
  }

  /** The tools an agent whose definition lists `names` holds, each once. */
  hold(names: readonly string[]): Held {
    const tools: HeldTool[] = [];
    const missing: string[] = [];
    for (const name of new Set(names)) {
      const tool = this.#tools.get(name);
      if (tool === undefined) missing.push(name);
      else tools.push(tool);
    }
    return { tools, missing };
  }

  /**
   * The tools a session declared as it opened (§6.8), in that order, each as declared then whatever
   * the registry holds now. One the host no longer offers (withdrawn, or its file switched off)
   * answers with `withdrawn` and runs nothing; `withdrawn` names them. A name the session never
   * declared stays out, as it was at the opening.
   */
  opened(names: readonly string[], declared: Readonly<Record<string, { description: string; parameters: JsonSchema }>>, withdrawn: (name: string) => Promise<LoopToolResult>): { tools: HeldTool[]; withdrawn: string[] } {
    const tools: HeldTool[] = [];
    const gone: string[] = [];
    for (const name of new Set(names)) {
      const as = Object.hasOwn(declared, name) ? declared[name] : undefined;
      if (as === undefined) continue;
      const now = this.#tools.get(name);
      if (now !== undefined) {
        tools.push({ ...now, description: as.description, parameters: as.parameters });
        continue;
      }
      gone.push(name);
      tools.push({ name, description: as.description, parameters: as.parameters, run: () => withdrawn(name), family: "withdrawn", tier: "read", from: "host" });
    }
    return { tools, withdrawn: gone };
  }
}
