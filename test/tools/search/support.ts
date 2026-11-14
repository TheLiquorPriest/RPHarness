// A bench for tool search: a folder host holding the kit's seed with RPH's own shipped files as its
// lowest level, tools of the kind an engine adds (families of searchable tools, one of them a write
// on a lane, and tools of an MCP server and an HTTP address that only run once switched on), and a
// stand-in of what the harness gives tool search: every tool an agent may reach, and a call of a
// found tool run as itself through the turn's gate. Everything here is invented.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRef, ApprovalsPort, HostTool, JsonValue, Switchable, SwitchesPort, SwitchState, ToolCtx, ToolResult } from "../../../src/contract";
import { createFacts, loadGuidance } from "../../../src/files";
import type { Guidance } from "../../../src/files/api";
import { TurnGate } from "../../../src/harness/gate";
import { DEFAULT_SETTINGS } from "../../../src/harness/settings";
import { SHIPPED_GUIDANCE } from "../../../src/harness/shipped";
import type { FolderHost } from "../../../src/hosts/folder";
import type { AgentOutcome, Fired, GateCall, LoopToolResult, ToolGate } from "../../../src/loop";
import { RunTrace } from "../../../src/loop";
import { KIT_SEED } from "../../../src/testing/kit";
import type { ToolText, Words } from "../../../src/tools/kit";
import { type HeldTool, Registry } from "../../../src/tools/registry";
import { type ReachableTool, searchTools, TOOL_SEARCH, TOOL_USE, type ToolReach, type ToolSearchDeps } from "../../../src/tools/search";
import { layFolderSeed, makeFolderHost } from "../../hosts/folder-kit";
import { type Answer, FakeClock, rigAgent, type ScriptedModel, TraceRecorder, user } from "../../loop/support";

export const SCOPE = KIT_SEED.scope;

/** The agent that searches. */
export const AUTHOR: AgentRef = { id: "author", definition: "author" };

/** A call's context, as the runner gives one. */
export function ctxOf(callId = "call-1", agent: AgentRef = AUTHOR): ToolCtx {
  return { scope: SCOPE, agent, run: "run-1", callId, signal: new AbortController().signal, onUpdate: () => {} };
}

export function said(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** An answer's text, its parts one after another. */
export function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

const TEXT = { type: "string" };

/** The MCP server the fixture's dice tools come from, and the address its page tool calls. */
export const DICE_SERVER: Switchable = { kind: "mcp-server", name: "dice-tower", target: "dice-tower --stdio" };
export const PAGE_ADDRESS: Switchable = { kind: "http-tool", name: "page_fetch", target: "https://pages.example.invalid/fetch" };

/** Every call a fixture tool ran, as `name args`. */
export type Ran = string[];

/** Tools of the kind an engine adds, and three that call out. Each records its runs in `ran`. */
export function fixtureTools(ran: Ran): HostTool[] {
  const tool = (name: string, family: string, description: string, parameters: Record<string, JsonValue>, required: string[], result: (args: JsonValue) => ToolResult, extra: Partial<HostTool> = {}): HostTool => ({
    name,
    family,
    tier: "read",
    description,
    parameters: { type: "object", properties: parameters, required },
    run: async (args) => {
      ran.push(`${name} ${JSON.stringify(args)}`);
      return result(args);
    },
    ...extra,
  });
  const write = { tier: "write", lane: "engine" } as const;
  return [
    tool("world_query", "state", "Reads the world tree at any place and depth.", { at: TEXT }, ["at"], () => said("The tavern holds three people.")),
    tool("weather_set", "time", "Sets the weather over a region for a while.\nThe answer says how the sky now stands.", { region: TEXT, state: TEXT, minutes: { type: "number" } }, ["region", "state"], (args) => said(`Weather set: ${JSON.stringify(args)}`), write),
    tool("weather_clear", "time", "Clears the weather a region was given, back to its season's own.", { region: TEXT }, ["region"], () => said("Weather cleared."), write),
    tool("open_account", "money", "Opens an account for someone at a bank, with a first deposit.", { holder: TEXT, bank: TEXT, deposit: { type: "integer", minimum: 0 } }, ["holder", "bank"], (args) => ({ ...said(`Account opened: ${JSON.stringify(args)}`), marks: ["unsourced"] }), write),
    tool("apply_credit", "money", "Puts a sum on someone's credit at a shop.", { holder: TEXT, shop: TEXT, amount: { type: "integer" } }, ["holder", "shop", "amount"], () => said("Credit applied."), write),
    tool("map_measure", "maps", "Measures the distance and the line of sight between two squares of a map.", { from: TEXT, to: TEXT, through: { enum: ["walls", "doors"] }, waypoints: { type: "array", items: TEXT } }, ["from", "to"], () => said("Twelve squares; the line of sight is clear.")),
    tool("map_lay", "maps", "Lays a grid of squares over a place, with its legend.", { place: TEXT, rows: { type: "array", items: TEXT } }, ["place", "rows"], () => said("Grid laid."), write),
    tool("vehicles_drive", "vehicles", "Drives a vehicle along a road to a place, and says how long it took.", { vehicle: TEXT, to: TEXT }, ["vehicle", "to"], () => said("Arrived after two hours."), write),
    tool("dice_roll", "dice", "Rolls dice by a formula on the dice tower and gives each die.", { formula: TEXT }, ["formula"], () => said("17"), { tier: "external", switchable: DICE_SERVER }),
    tool("dice_stats", "dice", "Gives the odds of a dice formula.", { formula: TEXT }, ["formula"], () => said("Even odds."), { tier: "external", switchable: DICE_SERVER }),
    tool("page_fetch", "web", "Fetches a page by its address and gives its text.", { address: TEXT }, ["address"], () => said("A page."), { tier: "external", switchable: PAGE_ADDRESS }),
  ];
}

/** The host's switches, as a map from a thing's name to where it stands; a name it does not have waits. */
export function switches(states: Readonly<Record<string, SwitchState>>): SwitchesPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    state: async (thing) => {
      asked.push(thing.name);
      return states[thing.name] ?? "waiting";
    },
  };
}

/** What the harness gives tool search, standing in for it: `run` runs the tool as it is unless a test gives its own. */
export function standIn(tools: readonly ReachableTool[], options: { fixed?: readonly string[]; outOfReach?: readonly string[]; run?: ToolReach["run"] } = {}): ToolReach {
  return {
    of: async () => ({ tools, fixed: options.fixed ?? [TOOL_SEARCH, TOOL_USE], outOfReach: options.outOfReach ?? [] }),
    run: options.run ?? ((tool, args, ctx) => tool.run(args, ctx)),
  };
}

/**
 * The runner's gate as the harness's owner sets it for tool search: a call of `tool_use` passes
 * through untouched, because the call it carries goes through the gate itself, as the found tool;
 * every other call goes through the turn's gate.
 */
function carrierGate(gate: ToolGate): ToolGate {
  return {
    before: (call, signal) => (call.tool === TOOL_USE ? Promise.resolve({ remind: [] }) : gate.before(call, signal)),
    after: (call, result, signal) => (call.tool === TOOL_USE ? Promise.resolve({ result, remind: [] }) : gate.after(call, result, signal)),
  };
}

/**
 * A found tool run as itself, standing in for the harness: what the runner does around a call of the
 * fixed list, under the found tool's own name. The trace has its start (reached `via` tool_use), the
 * rules that fired on it, and its end; the turn's gate is asked about it before and after; and the
 * texts of rules that remind come after its answer.
 */
function asItself(gate: ToolGate, trace: RunTrace, notices: Words): ToolReach["run"] {
  return async (tool, args, ctx) => {
    const call: GateCall = { agent: ctx.agent, callId: ctx.callId, tool: tool.name, args };
    trace.event(ctx.agent, undefined, { kind: "tool_started", callId: ctx.callId, tool: tool.name, args, closing: false, via: TOOL_USE });
    const fired: { fired: Fired; action: "hold" | "remind" }[] = [];
    const before = await gate.before(call, ctx.signal);
    fired.push(...before.remind.map((f) => ({ fired: f, action: "remind" as const })));
    let result: LoopToolResult;
    if (before.refuse !== undefined) result = before.refuse;
    else if (before.hold !== undefined) {
      fired.push({ fired: before.hold, action: "hold" });
      result = { content: [{ type: "text", text: before.hold.text.trimEnd() }] };
    } else {
      const ran = await tool.run(args, ctx).catch((error: unknown): LoopToolResult => ({ content: [{ type: "text", text: notices("failed", { tool: tool.name, error: String(error) }) ?? "" }], error: true }));
      const after = await gate.after(call, ran, ctx.signal);
      fired.push(...after.remind.map((f) => ({ fired: f, action: "remind" as const })));
      result = { ...after.result, content: [...after.result.content, ...fired.filter((f) => f.action === "remind").map((f) => ({ type: "text" as const, text: f.fired.text.trimEnd() }))] };
    }
    for (const f of fired) trace.event(ctx.agent, undefined, { kind: "rule_fired", firing: { callId: ctx.callId, tool: tool.name, ...f.fired.firing, agent: ctx.agent, action: f.action } });
    trace.event(ctx.agent, undefined, { kind: "tool_ended", callId: ctx.callId, tool: tool.name, result, clean: result.error !== true && fired.length === 0, endedRun: false, ms: 0 });
    return result;
  };
}

export interface Bench {
  host: FolderHost;
  guidance: Guidance;
  /** The two tools' files, as the harness reads them. */
  texts: Map<string, ToolText>;
  /** The tool answers' lines (`tool-notices`). */
  notices: Words;
  /** Tool search's deps over the bench, with `reach` and anything else a test sets. */
  deps(reach: ToolReach, extra?: Partial<ToolSearchDeps>): ToolSearchDeps;
  close(): Promise<void>;
}

/** A tool's file as the harness reads it: its body, and each argument's line of its header. */
async function toolText(guidance: Guidance, name: string): Promise<ToolText | undefined> {
  const part = await guidance.tool(name);
  if (part?.format !== "template") return undefined;
  const given = part.header["arguments"];
  const args: Record<string, string> = {};
  if (typeof given === "object" && given !== null && !Array.isArray(given)) {
    for (const [arg, text] of Object.entries(given)) if (typeof text === "string") args[arg] = text;
  }
  return { description: part.render().text.trimEnd(), arguments: args };
}

/** A bench over a new folder; `files` are more files of the agents' tree, by their path under `files/` (the global level). */
export async function bench(files: Readonly<Record<string, string>> = {}): Promise<Bench> {
  const place = await mkdtemp(join(tmpdir(), "rph-tool-search-"));
  await layFolderSeed(KIT_SEED, place);
  await cp(SHIPPED_GUIDANCE, join(place, "files", "defaults"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(place, "files", path)), { recursive: true });
    await writeFile(join(place, "files", path), text, "utf8");
  }
  const host = await makeFolderHost(KIT_SEED, place);
  const guidance = loadGuidance(host.files, SCOPE);
  const texts = new Map<string, ToolText>();
  for (const name of [TOOL_SEARCH, TOOL_USE]) {
    const text = await toolText(guidance, name);
    if (text !== undefined) texts.set(name, text);
  }
  const part = await guidance.part("tool-notices");
  const lines = part?.format === "lines" ? part : undefined;
  const notices: Words = (name, fields) => lines?.line(name, fields);
  return {
    host,
    guidance,
    texts,
    notices,
    deps: (reach, extra = {}) => ({ reach, guidance, notices, texts, schemaShown: 600, ...extra }),
    async close() {
      await host.close();
      await rm(place, { recursive: true, force: true });
    },
  };
}

export interface Play {
  scripted: ScriptedModel;
  recorder: TraceRecorder;
  /** Every call a host tool ran, as `name args`. */
  ran: Ran;
  /** The tools the agent's requests carry, by name, as the registry held them. */
  held: string[];
  /** One stretch of the agent's work from a message, to its end; each after the first goes on in the same session. */
  work(message: string): Promise<AgentOutcome>;
}

/**
 * An agent on a scripted model in a turn of the bench's host: it holds `fixed` from a registry of
 * tool search's own two tools and the fixture tools, as the harness holds a definition's list, and
 * every call goes through the turn's gate (the user's permissions from `approvals`, the rules in
 * the bench's files) and is traced.
 */
export async function play(b: Bench, options: { answers: Answer[]; fixed: string[]; outOfReach?: string[]; switches?: SwitchesPort; approvals?: ApprovalsPort }): Promise<Play> {
  const ran: Ran = [];
  const hosted = fixtureTools(ran);
  const clock = new FakeClock();
  const recorder = new TraceRecorder();
  const trace = new RunTrace(recorder, SCOPE, "run-1", clock);
  let gate: TurnGate | undefined;
  const reach: ToolReach = {
    of: async () => ({ tools: [...own, ...hosted], fixed: options.fixed, outOfReach: options.outOfReach ?? [] }),
    run: (tool, args, ctx) => {
      if (gate === undefined) throw new Error("The gate is made before any call.");
      return asItself(gate, trace, b.notices)(tool, args, ctx);
    },
  };
  const own = searchTools(b.deps(reach, options.switches !== undefined ? { switches: options.switches } : {}));
  const registry = new Registry(own, hosted);
  gate = new TurnGate({
    scope: SCOPE,
    agent: AUTHOR,
    trace,
    clock,
    files: b.host.files,
    ...(options.approvals !== undefined ? { approvals: options.approvals } : {}),
    places: await b.host.files.places(SCOPE),
    rules: await b.guidance.ruleRun({ facts: createFacts(b.host.facts, () => ({})) }),
    words: b.notices,
    // The gate knows every tool the agent may reach, so a found tool's tier and lane are its own.
    tools: new Map<string, HeldTool>([...own.map((tool) => [tool.name, { ...tool, from: "rph" as const }] as const), ...hosted.map((tool) => [tool.name, { ...tool, from: "host" as const }] as const)]),
    clipChars: DEFAULT_SETTINGS.clipChars,
    ready: async () => {},
  });
  const held = registry.hold(options.fixed).tools;
  const { runner, scripted } = rigAgent(AUTHOR, options.answers, { tools: held, gate: carrierGate(gate), clock, recorder, trace });
  let started = false;
  return {
    scripted,
    recorder,
    ran,
    held: held.map((tool) => tool.name),
    // Nothing in a script waits on the clock, so the work runs to its end however long the disk takes.
    work: (message) => {
      const work = runner.start(started ? { message } : { messages: [user(message)] });
      started = true;
      return work.done;
    },
  };
}
