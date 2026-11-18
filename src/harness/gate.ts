// What is asked around each of an agent's tool calls (§13.3), from pi's own hooks through the
// runner: before the call (`beforeToolCall`), the host's switches for a tool that runs a command or
// calls out (§16), the user's permission for what it writes (Auto, Confirm or Never per lane, and the
// external tier's own setting, §6.8), and the user's rules on its arguments; after it
// (`afterToolCall`), the rules on its result, and the user's bound on what the model reads of one
// call (R-118): its answer and reports, the rules' texts after it, and a refusal's or a hold's words,
// with the whole kept in the turn's folder (`cache/results/`), or the session's where the run has no
// turn. A tool found through `tool_use` is asked about as itself. His hooks (§5.4 "Hooks") run around
// each call too: before it, after the permission, a block is the call's answer, a change of its
// arguments is what the rules and the tool see, and what a hook adds comes back with the result;
// after it, a block puts the hook's reason in place of what the model reads, the whole kept in the
// turn's folder, and what a hook adds goes after the answer. Every word the model is told comes
// from the tool answers' file, or from his hooks. A tool's own answer stands whatever fails around
// it: a rule on its result that could not be asked, or a whole that could not be kept, is a line
// beside it, and the log names what failed, said once while the place it is kept at goes on failing
// (`FailingWrites`). Every refusal says why, as a fact, for the call's end record. Every read and
// search a call makes is saved whole in the turn's `queries/` (the session's, for a run with no turn).
import type { AgentRef, ApprovalsPort, CallPermission, Clock, FilesPort, Log, Places, RunScope, SwitchesPort, ToolContent } from "../contract";
import { agentJson, type Hooks, scopeJson } from "../external/hooks";
import type { RuleRun } from "../files/api";
import type { Fired } from "../loop/rules";
import type { ParentCall, RunTrace } from "../loop/trace";
import type { Bounded, GateAfter, GateBefore, GateCall, LoopToolResult, ToolGate } from "../loop/types";
import type { HeldTool } from "../tools/registry";
import { answer, type Words } from "../tools/kit";
import { FailingWrites } from "./failing";
import { agentFileName } from "./requests";

/** Where a clipped result's whole is kept, inside the turn's own `cache/` folder, or the session's. */
const KEPT_RESULTS = "cache/results/";
/** Where every read and search is saved, beside the gap checks (§5.3). */
const QUERIES = "queries/";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface GateDeps {
  scope: RunScope;
  agent: AgentRef;
  parent?: ParentCall;
  trace: RunTrace;
  clock: Clock;
  files: FilesPort;
  approvals?: ApprovalsPort;
  /** The host's registry of what is switched on; without it, every tool that runs a command or calls out is off. */
  switches?: SwitchesPort;
  places: Places;
  rules: RuleRun;
  words: Words;
  /** The agent's tools by name, with their tier and lane. */
  tools: ReadonlyMap<string, HeldTool>;
  /** The owner's own ceiling on the characters of one call that the model reads (`results.clipChars`); none by default. */
  clipChars?: number;
  /** Where what failed around a tool is named: a rule that could not be asked, a whole that could not be kept. */
  log: Log;
  /** The places the run's saves fail at now, shared by every gate of the run, so each is said once while it lasts; none: this gate's own. */
  failing?: FailingWrites;
  /** His hooks before and after a tool; none runs none. */
  hooks?: Hooks;
}

export class TurnGate implements ToolGate {
  readonly #d: GateDeps;
  /** What a hook before a call added, by its id: it comes back with the call's result. */
  readonly #added = new Map<string, string[]>();
  readonly #failing: FailingWrites;

  constructor(deps: GateDeps) {
    this.#d = deps;
    this.#failing = deps.failing ?? new FailingWrites(deps.log);
  }

  async before(call: GateCall, signal: AbortSignal): Promise<GateBefore> {
    const d = this.#d;
    const tool = d.tools.get(call.tool);
    // A tool that runs a command or calls out does nothing until the host's switches have its thing on for this user, pinned or found (§16, C31).
    const thing = tool?.switchable;
    if (thing !== undefined) {
      const state = d.switches === undefined ? "off" : await d.switches.state(d.scope.user, thing);
      if (state !== "on") {
        // Its record still names the lane and the permission it would have run under.
        const would = await this.permissionOf(call);
        return { refuse: answer(d.words("not_switched_on", { tool: call.tool, name: thing.name, kind: thing.kind, ...(state === "waiting" ? { waiting: true } : {}) }), true), refused: { by: "switch", thing, state }, remind: [], ...(would !== undefined ? { permission: would } : {}) };
      }
    }
    const lane = laneOf(tool);
    let permission: CallPermission | undefined;
    if (lane !== undefined) {
      // Without the host's approvals port every lane is Auto (Appendix D.1), and the record says so.
      const approvals = d.approvals;
      const setting = approvals === undefined ? "auto" : await approvals.permission(d.scope, lane);
      permission = { lane, setting };
      if (setting === "never") return { refuse: answer(d.words("never", { tool: call.tool, lane }), true), refused: { by: "never", lane }, remind: [], permission };
      if (setting === "confirm" && approvals !== undefined) {
        d.trace.event(d.agent, d.parent, { kind: "approval_asked", callId: call.callId, tool: call.tool, lane });
        const said = await approvals.ask(d.scope, { agent: d.agent, callId: call.callId, tool: call.tool, lane, args: call.args, at: d.clock.now() }, signal);
        d.trace.event(d.agent, d.parent, { kind: "approval_answered", callId: call.callId, tool: call.tool, lane, answer: said });
        permission = { lane, setting, answer: said };
        if (!said.go) return { refuse: answer(d.words("declined", { tool: call.tool, ...(said.reason !== undefined ? { reason: said.reason } : {}) }), true), refused: { by: "declined", lane, ...(said.reason !== undefined ? { reason: said.reason } : {}) }, remind: [], permission };
      }
    }
    // His hooks before the call, one after another (R-200): a block is its answer, in the hook's words.
    let args = call.args;
    if (d.hooks !== undefined) {
      const hooked = await d.hooks.run("before-tool", { scope: scopeJson(d.scope), agent: agentJson(d.agent), tool: call.tool, callId: call.callId, args }, { agent: d.agent, ...(d.parent !== undefined ? { parent: d.parent } : {}), callId: call.callId }, signal);
      if (hooked.blocked !== undefined) return { refuse: answer(hooked.blocked.reason, true), refused: { by: "hook", hook: hooked.blocked.hook, reason: hooked.blocked.reason }, remind: [], ...(permission !== undefined ? { permission } : {}) };
      if (hooked.input !== undefined) args = hooked.input;
      if (hooked.added.length > 0) this.#added.set(call.callId, hooked.added);
    }
    const fired = await d.rules.toolCall(d.agent, { id: call.callId, tool: call.tool, args });
    return { ...(fired.hold !== undefined ? { hold: fired.hold } : {}), remind: fired.remind, ...(permission !== undefined ? { permission } : {}), ...(args !== call.args ? { args } : {}) };
  }

  async permissionOf(call: GateCall): Promise<CallPermission | undefined> {
    const d = this.#d;
    const lane = laneOf(d.tools.get(call.tool));
    if (lane === undefined) return undefined;
    return { lane, setting: d.approvals === undefined ? "auto" : await d.approvals.permission(d.scope, lane) };
  }

  async after(call: GateCall, result: LoopToolResult, signal?: AbortSignal, added: readonly string[] = [], room?: number): Promise<GateAfter> {
    const d = this.#d;
    // Every search and read is saved whole beside the gap checks, so another agent, a query, the live view and he can see what was looked at (§5.3).
    if (d.tools.get(call.tool)?.tier === "read") await this.#saveRead(call, result);
    // The rules see the result whole; the model reads it held to the bound, with every rule's text after it.
    let remind: Fired[] = [];
    const beside: string[] = [];
    try {
      remind = await d.rules.toolResult(d.agent, { id: call.callId, tool: call.tool }, result);
    } catch (error) {
      // The tool's answer stands: a write that went through is never told as failed, so it is not made again.
      d.log.warn("The rules on a tool's answer could not be asked; the answer stands as the tool gave it.", { agent: d.agent.id, tool: call.tool, callId: call.callId, error: errorText(error) });
      const line = d.words("rule_unasked", { tool: call.tool });
      if (line !== undefined) beside.push(line);
    }
    // What a hook before the call added, then his hooks after it: a block puts its reason in place of what the model reads, the whole kept.
    const hookAdded = this.#added.get(call.callId) ?? [];
    this.#added.delete(call.callId);
    let read = result;
    if (d.hooks !== undefined) {
      const text = [...result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])), ...(result.reports ?? [])].join("\n");
      const hooked = await d.hooks.run("after-tool", { scope: scopeJson(d.scope), agent: agentJson(d.agent), tool: call.tool, callId: call.callId, args: call.args, result: { text, ...(result.error === true ? { error: true } : {}) } }, { agent: d.agent, ...(d.parent !== undefined ? { parent: d.parent } : {}), callId: call.callId }, signal);
      hookAdded.push(...hooked.added);
      if (hooked.blocked !== undefined) {
        await this.#keep(call, text);
        read = { content: [{ type: "text", text: hooked.blocked.reason }], ...(result.details !== undefined ? { details: result.details } : {}) };
      }
    }
    const bounded = await this.#bound(call, read, [...added, ...hookAdded, ...remind.map((fired) => fired.text.trimEnd())], room, beside);
    return { ...bounded, remind };
  }

  /** A read or a search, saved whole in the turn's `queries/` (the session's, for a run with no turn), named by agent, call and tool; logged when it cannot be. */
  async #saveRead(call: GateCall, result: LoopToolResult): Promise<void> {
    const d = this.#d;
    const name = `${agentFileName(d.agent)}.${call.callId}.${call.tool}`.replace(/[^A-Za-z0-9._-]/g, "_");
    const folder = `${d.places.turn ?? d.places.session}${QUERIES}`;
    const at = `${folder}${name}.md`;
    const text = [...result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])), ...(result.reports ?? [])].join("\n");
    const failed = "A read's result could not be saved in queries/.";
    try {
      const written = await d.files.write(d.scope, at, { op: "write", text }, "harness");
      if (written.status === "written") this.#failing.landed(folder, "Reads' results are saved in queries/ again; those that failed before are not there.", { agent: d.agent.id, folder });
      else this.#failing.failed(folder, failed, { agent: d.agent.id, tool: call.tool, callId: call.callId, path: at, status: written.status, reason: written.reason });
    } catch (error) {
      this.#failing.failed(folder, failed, { agent: d.agent.id, tool: call.tool, callId: call.callId, path: at, error: errorText(error) });
    }
  }

  /**
   * What the model reads of one call, cut only where it is longer than the room the call that reads
   * it has (`room`: the model's window less the reserve and less the request as it stands, and the
   * agent's prompt per call where it has one) or the owner's own ceiling (`results.clipChars`, where he set
   * one). It reads the answer's text, then its reports, one line each, then the texts that go after it
   * (the rules' texts), in that order, and the cut counts them all: no more than that of any call
   * reaches the model, the trace, the session file or a later request. Its whole is kept in the
   * turn's folder (the session's, for a run with no turn), and the file's line says how much was left
   * out and where: it comes after all that is shown, and the answer as it is kept ends with it, among
   * its reports where it has any. A whole that could not be kept is said beside it, and logged.
   */
  bound(call: GateCall, result: LoopToolResult, added: readonly string[] = [], room?: number): Promise<Bounded> {
    return this.#bound(call, result, added, room, []);
  }

  /** `bound`, with lines that go beside the answer whatever the cut: what could not be done around it. */
  async #bound(call: GateCall, result: LoopToolResult, added: readonly string[], room: number | undefined, beside: readonly string[]): Promise<Bounded> {
    const d = this.#d;
    // Cut only where the whole would not fit the call that reads it (`room`), or past the owner's own ceiling where he set one (§10.2).
    const most = Math.min(d.clipChars ?? Number.POSITIVE_INFINITY, room ?? Number.POSITIVE_INFINITY);
    const texts = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    const reports = result.reports ?? [];
    const whole = [...texts, ...reports, ...added];
    const length = whole.reduce((sum, text) => sum + text.length, 0);
    const lines = (shown: readonly string[]): ToolContent[] => shown.map((text) => ({ type: "text", text }));
    if (length <= most) {
      const read = [...result.content, ...lines([...reports, ...added, ...beside])];
      if (beside.length === 0) return { result, read };
      return reports.length > 0 ? { result: { ...result, reports: [...reports, ...beside] }, read } : { result: { ...result, content: [...result.content, ...lines(beside)] }, read };
    }
    let left = most;
    const cut = (text: string): string | undefined => {
      if (left <= 0) return undefined;
      const kept = text.slice(0, left);
      left -= kept.length;
      return kept;
    };
    const content = result.content.flatMap((part): ToolContent[] => {
      if (part.type !== "text") return [part];
      const kept = cut(part.text);
      return kept === undefined ? [] : [{ ...part, text: kept }];
    });
    const shownReports = reports.flatMap((report) => {
      const kept = cut(report);
      return kept === undefined ? [] : [kept];
    });
    const shownAdded = added.flatMap((text) => {
      const kept = cut(text);
      return kept === undefined ? [] : [kept];
    });
    const shown = most - left;
    const reportsLeft = reports.length - shownReports.filter((kept, at) => kept.length === reports[at]?.length).length;
    const path = await this.#keep(call, whole.join("\n"));
    const line = d.words("clipped", { shown, length, left: length - shown, ...(reportsLeft > 0 ? { reports: reports.length, reports_left: reportsLeft } : {}), ...(path !== undefined ? { path } : {}) });
    const notKept = path === undefined ? d.words("not_kept", { tool: call.tool }) : undefined;
    const said = [line, notKept, ...beside].filter((text): text is string => text !== undefined);
    const read = [...content, ...lines([...shownReports, ...shownAdded, ...said])];
    if (reports.length > 0) return { result: { ...result, content, reports: [...shownReports, ...said] }, read };
    return { result: { ...result, content: [...content, ...lines(said)] }, read };
  }

  /** Keeps a clipped answer's whole in the turn's `cache/results/`, or the session's for a run with no turn (§11); where it went, or undefined, logged, when it could not be kept. */
  async #keep(call: GateCall, text: string): Promise<string | undefined> {
    const d = this.#d;
    const folder = `${d.places.turn ?? d.places.session}${KEPT_RESULTS}`;
    const at = `${folder}${call.callId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`;
    const failed = "A clipped tool answer's whole could not be kept.";
    try {
      const written = await d.files.write(d.scope, at, { op: "write", text }, "harness");
      if (written.status === "written") {
        this.#failing.landed(folder, "Clipped tool answers' wholes are kept again; those that failed before are not.", { agent: d.agent.id, folder });
        return written.path;
      }
      this.#failing.failed(folder, failed, { agent: d.agent.id, tool: call.tool, callId: call.callId, path: at, status: written.status, reason: written.reason });
    } catch (error) {
      this.#failing.failed(folder, failed, { agent: d.agent.id, tool: call.tool, callId: call.callId, path: at, error: errorText(error) });
    }
    return undefined;
  }
}

/** The lane a tool's permission is asked under: the external tier's own setting whatever lane it names; a write, its lane's. */
function laneOf(tool: HeldTool | undefined): string | undefined {
  return tool?.tier === "external" ? "external" : tool?.tier === "write" ? tool.lane : undefined;
}
