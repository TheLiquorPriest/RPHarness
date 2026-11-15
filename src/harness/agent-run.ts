// One way to make an agent's run (§13.2 l.1434: sub-agents, jobs and transcripts on pi's loop,
// once): a turn and a job each make their agents' gates and keep their requests here, so a fix to
// one is a fix to both. Every write of a run is handed to the run (`tell`), so a run's end waits for
// its request files and transcripts as a turn's does. Every agent of a run made here writes its
// transcript (`transcripts.ts`).
import type { AgentRef, Environment, Places, Scope } from "../contract";
import type { RuleRun } from "../files/api";
import type { ParentCall, RunTrace } from "../loop/trace";
import type { GateCall, KeepRequest, LoopToolResult, ToolGate } from "../loop/types";
import type { HeldTool } from "../tools/registry";
import type { Words } from "../tools/kit";
import { TurnGate } from "./gate";
import { requestPath, sentMessages } from "./requests";
import type { Settings } from "./settings";
import { Transcripts } from "./transcripts";

export interface AgentRunDeps {
  env: Environment;
  scope: Scope;
  trace: RunTrace;
  places: Places;
  /** The run's settings: which requests are kept (`trace.requests`) and the bound on one call (`results.clip`). */
  settings(): Pick<Settings, "requests" | "clipChars">;
  rules(): RuleRun;
  words: Words;
  /** Every tool an agent of the run may reach, so a tool found by `tool_use` is gated by its own tier and lane. */
  tools(): readonly HeldTool[];
  /** Where each write still under way is handed: the run's end waits for it. */
  tell(written: Promise<unknown>): void;
  /** Told of each call that ran, as its gate takes it after the tool: a job's record of its writes. */
  ran?(call: GateCall, result: LoopToolResult, tool: HeldTool | undefined): void;
}

/** What every agent of one run is made with: its gate, its kept requests, its transcript. */
export class AgentRuns {
  readonly #d: AgentRunDeps;

  constructor(deps: AgentRunDeps) {
    this.#d = deps;
    const { env, scope, places } = deps;
    new Transcripts({ files: env.files, scope, folder: places.turn ?? places.session, log: env.log, tell: (written) => deps.tell(written) }).follow(deps.trace);
  }

  /** The gate around each tool call of an agent (§13.3). */
  gate(agent: AgentRef, parent: ParentCall | undefined): ToolGate {
    const d = this.#d;
    const { env } = d;
    const tools = new Map(d.tools().map((tool) => [tool.name, tool]));
    const gate = new TurnGate({
      scope: d.scope,
      agent,
      ...(parent !== undefined ? { parent } : {}),
      trace: d.trace,
      clock: env.clock,
      files: env.files,
      log: env.log,
      ...(env.approvals !== undefined ? { approvals: env.approvals } : {}),
      ...(env.switches !== undefined ? { switches: env.switches } : {}),
      places: d.places,
      rules: d.rules(),
      words: d.words,
      tools,
      clipChars: d.settings().clipChars,
    });
    const ran = d.ran;
    if (ran === undefined) return gate;
    return {
      before: (call, signal) => gate.before(call, signal),
      after(call, result, signal, added, room) {
        ran(call, result, tools.get(call.tool));
        return gate.after(call, result, signal, added, room);
      },
      bound: (call, answer, added, room) => gate.bound(call, answer, added, room),
      permissionOf: (call) => gate.permissionOf(call),
    };
  }

  /** Keeps what an agent's calls are sent, as `trace.requests` names them, in the turn's folder beside the transcripts; none for a run with no turn. */
  keep(agent: AgentRef): KeepRequest | undefined {
    const d = this.#d;
    const which = d.settings().requests;
    const turn = d.places.turn;
    if (which === "none" || turn === undefined) return undefined;
    const { env } = d;
    return (call, messages, opening) => {
      if (which === "first" && call !== 1) return undefined;
      const path = requestPath(turn, agent, call);
      d.tell(
        env.files.write(d.scope, path, { op: "write", text: JSON.stringify({ messages: sentMessages(messages, opening) }) }, "harness").then(
          (done) => {
            if (done.status !== "written") env.log.warn("What a model call was sent could not be kept.", { agent: agent.id, call, path, status: done.status });
          },
          (error: unknown) => env.log.warn("What a model call was sent could not be kept.", { agent: agent.id, call, path, error: error instanceof Error ? error.message : String(error) }),
        ),
      );
      return path;
    };
  }
}
