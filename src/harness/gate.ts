// What is asked around each of an agent's tool calls (§13.3), from pi's own hooks through the
// runner: before the call (`beforeToolCall`), the host's switches for a tool that runs a command or
// calls out (§16), the user's permission for what it writes (Auto, Confirm or Never per lane, and the
// external tier's own setting, §6.8), and the user's rules on its arguments; after it
// (`afterToolCall`), the rules on its result, and the user's bound on what the model reads of one
// call (R-118): its answer and reports, the rules' texts after it, and a refusal's or a hold's words,
// with the whole kept in the turn's folder (`cache/results/`). A tool found through `tool_use` is
// asked about as itself. Every word the model is told comes from the tool answers' file.
import type { AgentRef, ApprovalsPort, CallPermission, Clock, FilesPort, Places, Scope, SwitchesPort, ToolContent } from "../contract";
import type { RuleRun } from "../files/api";
import type { ParentCall, RunTrace } from "../loop/trace";
import type { Bounded, GateAfter, GateBefore, GateCall, LoopToolResult, ToolGate } from "../loop/types";
import type { HeldTool } from "../tools/registry";
import { answer, type Words } from "../tools/kit";

/** Where a clipped result's whole is kept, inside the turn's own `cache/` folder. */
const KEPT_RESULTS = "cache/results/";

export interface GateDeps {
  scope: Scope;
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
  /** Characters of one call that the model reads (`results.clip`). */
  clipChars: number;
  /** Resolves once what the host must hear before any tool runs (the intent record) has been told. */
  ready(): Promise<void>;
}

export class TurnGate implements ToolGate {
  readonly #d: GateDeps;

  constructor(deps: GateDeps) {
    this.#d = deps;
  }

  async before(call: GateCall, signal: AbortSignal): Promise<GateBefore> {
    const d = this.#d;
    await d.ready();
    const tool = d.tools.get(call.tool);
    // A tool that runs a command or calls out does nothing until the host's switches have its thing on, pinned or found (§16).
    const thing = tool?.switchable;
    if (thing !== undefined) {
      const state = d.switches === undefined ? "off" : await d.switches.state(thing);
      if (state !== "on") return { refuse: answer(d.words("not_switched_on", { tool: call.tool, name: thing.name, kind: thing.kind, ...(state === "waiting" ? { waiting: true } : {}) }), true), remind: [] };
    }
    // A tool of the external tier is under the user's `external` setting whatever lane it names; a write, under its lane's.
    const lane = tool?.tier === "external" ? "external" : tool?.tier === "write" ? tool.lane : undefined;
    let permission: CallPermission | undefined;
    if (lane !== undefined) {
      // Without the host's approvals port every lane is Auto (Appendix D.1), and the record says so.
      const approvals = d.approvals;
      const setting = approvals === undefined ? "auto" : await approvals.permission(d.scope, lane);
      permission = { lane, setting };
      if (setting === "never") return { refuse: answer(d.words("never", { tool: call.tool, lane }), true), remind: [], permission };
      if (setting === "confirm" && approvals !== undefined) {
        d.trace.event(d.agent, d.parent, { kind: "approval_asked", callId: call.callId, tool: call.tool, lane });
        const said = await approvals.ask(d.scope, { agent: d.agent, callId: call.callId, tool: call.tool, lane, args: call.args, at: d.clock.now() }, signal);
        d.trace.event(d.agent, d.parent, { kind: "approval_answered", callId: call.callId, tool: call.tool, lane, answer: said });
        permission = { lane, setting, answer: said };
        if (!said.go) return { refuse: answer(d.words("declined", { tool: call.tool, ...(said.reason !== undefined ? { reason: said.reason } : {}) }), true), remind: [], permission };
      }
    }
    const fired = await d.rules.toolCall(d.agent, { id: call.callId, tool: call.tool, args: call.args });
    return { ...(fired.hold !== undefined ? { hold: fired.hold } : {}), remind: fired.remind, ...(permission !== undefined ? { permission } : {}) };
  }

  async after(call: GateCall, result: LoopToolResult, _signal?: AbortSignal, added: readonly string[] = []): Promise<GateAfter> {
    // The rules see the result whole; the model reads it held to the bound, with every rule's text after it.
    const remind = await this.#d.rules.toolResult(this.#d.agent, { id: call.callId, tool: call.tool }, result);
    const bounded = await this.bound(call, result, [...added, ...remind.map((fired) => fired.text.trimEnd())]);
    return { ...bounded, remind };
  }

  /**
   * What the model reads of one call, cut to the setting where it is longer. It reads the answer's
   * text, then its reports, one line each, then the texts that go after it (the rules' texts), in
   * that order, and the setting counts them all: no more than the setting of any call reaches the
   * model, the trace, the session file or a later request. Its whole is kept in the turn's folder,
   * and the file's line says how much was left out and where: it comes after all that is shown, and
   * the answer as it is kept ends with it, among its reports where it has any.
   */
  async bound(call: GateCall, result: LoopToolResult, added: readonly string[] = []): Promise<Bounded> {
    const d = this.#d;
    const texts = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    const reports = result.reports ?? [];
    const whole = [...texts, ...reports, ...added];
    const length = whole.reduce((sum, text) => sum + text.length, 0);
    const lines = (shown: readonly string[]): ToolContent[] => shown.map((text) => ({ type: "text", text }));
    if (length <= d.clipChars) return { result, read: [...result.content, ...lines([...reports, ...added])] };
    let left = d.clipChars;
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
    const shown = d.clipChars - left;
    const reportsLeft = reports.length - shownReports.filter((kept, at) => kept.length === reports[at]?.length).length;
    let path: string | undefined;
    if (d.places.turn !== undefined) {
      const written = await d.files.write(d.scope, `${d.places.turn}${KEPT_RESULTS}${call.callId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`, { op: "write", text: whole.join("\n") }, "harness");
      if (written.status === "written") path = written.path;
    }
    const line = d.words("clipped", { shown, length, left: length - shown, ...(reportsLeft > 0 ? { reports: reports.length, reports_left: reportsLeft } : {}), ...(path !== undefined ? { path } : {}) });
    const said = line === undefined ? [] : [line];
    const read = [...content, ...lines([...shownReports, ...shownAdded, ...said])];
    if (reports.length > 0) return { result: { ...result, content, reports: [...shownReports, ...said] }, read };
    return { result: { ...result, content: [...content, ...lines(said)] }, read };
  }
}
