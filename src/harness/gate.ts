// What runs around each of an agent's tool calls (§13.3): before the call, the user's permission
// for what it writes (Auto, Confirm or Never per lane, and the external tier's own setting, §6.8),
// and the user's rules on its arguments; after it, the rules on its result, and a long result
// clipped to what the model reads, with the whole kept in the turn's folder (`cache/`). Every word
// the model is told comes from the tool answers' file.
import type { AgentRef, ApprovalsPort, Clock, FilesPort, Places, Scope, ToolContent } from "../contract";
import type { RuleRun } from "../files/api";
import type { ParentCall, RunTrace } from "../loop/trace";
import type { GateAfter, GateBefore, GateCall, LoopToolResult, ToolGate } from "../loop/types";
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
  places: Places;
  rules: RuleRun;
  words: Words;
  /** The agent's tools by name, with their tier and lane. */
  tools: ReadonlyMap<string, HeldTool>;
  /** Characters of a result the model reads. */
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
    // A tool of the external tier is under the user's `external` setting whatever lane it names; a write, under its lane's.
    const lane = tool?.tier === "external" ? "external" : tool?.tier === "write" ? tool.lane : undefined;
    if (lane !== undefined && d.approvals !== undefined) {
      const permission = await d.approvals.permission(d.scope, lane);
      if (permission === "never") return { refuse: answer(d.words("never", { tool: call.tool, lane }), true), remind: [] };
      if (permission === "confirm") {
        d.trace.event(d.agent, d.parent, { kind: "approval_asked", callId: call.callId, tool: call.tool, lane });
        const said = await d.approvals.ask(d.scope, { agent: d.agent, callId: call.callId, tool: call.tool, lane, args: call.args, at: d.clock.now() }, signal);
        d.trace.event(d.agent, d.parent, { kind: "approval_answered", callId: call.callId, tool: call.tool, lane, answer: said });
        if (!said.go) return { refuse: answer(d.words("declined", { tool: call.tool, ...(said.reason !== undefined ? { reason: said.reason } : {}) }), true), remind: [] };
      }
    }
    const fired = await d.rules.toolCall(d.agent, { id: call.callId, tool: call.tool, args: call.args });
    return { ...(fired.hold !== undefined ? { hold: fired.hold } : {}), remind: fired.remind };
  }

  async after(call: GateCall, result: LoopToolResult): Promise<GateAfter> {
    // The rules see the result whole; the model reads it clipped.
    const remind = await this.#d.rules.toolResult(this.#d.agent, { id: call.callId, tool: call.tool }, result);
    return { result: await this.#clip(call, result), remind };
  }

  /** A result longer than the setting, cut to it: its whole is kept in the turn's folder, and the file's line says where. */
  async #clip(call: GateCall, result: LoopToolResult): Promise<LoopToolResult> {
    const d = this.#d;
    const texts = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    const length = texts.reduce((sum, text) => sum + text.length, 0);
    if (length <= d.clipChars) return result;
    let left = d.clipChars;
    const content = result.content.flatMap((part): ToolContent[] => {
      if (part.type !== "text") return [part];
      if (left <= 0) return [];
      const kept = part.text.slice(0, left);
      left -= kept.length;
      return [{ ...part, text: kept }];
    });
    let path: string | undefined;
    if (d.places.turn !== undefined) {
      const written = await d.files.write(d.scope, `${d.places.turn}${KEPT_RESULTS}${call.callId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`, { op: "write", text: texts.join("\n") }, "harness");
      if (written.status === "written") path = written.path;
    }
    const line = d.words("clipped", { shown: d.clipChars, length, ...(path !== undefined ? { path } : {}) });
    return { ...result, content: line === undefined ? content : [...content, { type: "text", text: line }] };
  }
}
