// What tool search works over (§6.8): every tool an agent may reach as the registry holds them,
// what the agent's definition says of them (its fixed list, and the families it keeps out of its
// reach), the host's switches (§16), and a call of a found tool run as itself through the gate.
// The harness gives these (`ToolReach`); tool search only works out where each tool stands for the
// agent that asks.
import type { AgentRef, JsonValue, Switchable, SwitchesPort, SwitchState, ToolCtx } from "../../contract";
import type { LoopTool, LoopToolResult } from "../../loop/types";

/** The two tools tool search is made of. Neither is ever found by a search or carried by `tool_use`. */
export const TOOL_SEARCH = "tool_search";
export const TOOL_USE = "tool_use";

/** A tool as tool search reads it: the registry's, with its family. */
export interface ReachableTool extends LoopTool {
  family: string;
  /**
   * For a tool that runs a command or calls out (an MCP server's tool, a command tool, an HTTP
   * tool): what it runs or calls. It is found and called only while the host's switches say it
   * is on.
   */
  switchable?: Switchable;
}

/** What one agent may reach, as the registry and its definition give it. */
export interface AgentReach {
  /** Every tool the registry holds: RPH's own and the host's. */
  tools: readonly ReachableTool[];
  /** The tools its requests carry, by name: its definition's list, with any searchable tool it pins. */
  fixed: readonly string[];
  /** Families its definition keeps out of its reach. A tool of one that its fixed list names is still held. */
  outOfReach: readonly string[];
}

/** What tool search needs of the harness: the registry's view for an agent, and the gate. */
export interface ToolReach {
  /** What the calling agent may reach. It does not change within a session (§6.8). */
  of(agent: AgentRef): Promise<AgentReach>;
  /**
   * Runs a tool an agent named in `tool_use`, its arguments already checked against its own
   * schema, as itself: permitted, ruled on, hooked, clipped and traced under its own name, as a
   * call of the fixed list is (§6.8, Appendix A). What it gives is the call's answer.
   */
  run(tool: ReachableTool, args: JsonValue, ctx: ToolCtx): Promise<LoopToolResult>;
}

/** Where a tool stands for one agent: in its fixed list, found by search, waiting to be switched on, or out of its reach. */
export type Standing = { at: "fixed" | "found"; tool: ReachableTool } | { at: "waiting"; tool: ReachableTool; thing: Switchable } | { at: "unreached" };

/** One agent's reach for one call, laid out for looking tools up; the host's switches are asked about each thing once. */
export class Reach {
  readonly #byName: ReadonlyMap<string, ReachableTool>;
  readonly #fixed: ReadonlySet<string>;
  readonly #outOfReach: ReadonlySet<string>;
  readonly #switches: SwitchesPort | undefined;
  readonly #asked = new Map<string, Promise<SwitchState>>();

  constructor(reach: AgentReach, switches: SwitchesPort | undefined) {
    this.#byName = new Map(reach.tools.map((tool) => [tool.name, tool]));
    this.#fixed = new Set(reach.fixed);
    this.#outOfReach = new Set(reach.outOfReach);
    this.#switches = switches;
  }

  /** Where the tool of that name stands; a name no tool answers to is out of reach. */
  named(name: string): Promise<Standing> {
    return this.standing(this.#byName.get(name));
  }

  async standing(tool: ReachableTool | undefined): Promise<Standing> {
    if (tool === undefined || tool.name === TOOL_SEARCH || tool.name === TOOL_USE) return { at: "unreached" };
    const fixed = this.#fixed.has(tool.name);
    if (!fixed && this.#outOfReach.has(tool.family)) return { at: "unreached" };
    if (tool.switchable !== undefined) {
      const state = await this.#state(tool.switchable);
      if (state === "waiting") return { at: "waiting", tool, thing: tool.switchable };
      if (state !== "on") return { at: "unreached" };
    }
    return { at: fixed ? "fixed" : "found", tool };
  }

  #state(thing: Switchable): Promise<SwitchState> {
    // Without the host's registry, everything that runs a command or calls out is off (`Environment.switches`).
    if (this.#switches === undefined) return Promise.resolve("off");
    const key = JSON.stringify([thing.kind, thing.name, thing.target]);
    let state = this.#asked.get(key);
    if (state === undefined) {
      state = this.#switches.state(thing);
      this.#asked.set(key, state);
    }
    return state;
  }
}
