// One way to make an agent's run (§13.2 l.1434: sub-agents, jobs and transcripts on pi's loop,
// once): a turn and a job each make their agents' gates and keep their requests here, so a fix to
// one is a fix to both. Every write of a run is handed to the run (`tell`), so a run's end waits for
// its request files and transcripts as a turn's does. Every agent of a run made here writes its
// transcript (`transcripts.ts`), and each sub-agent and job's agent its own session's file
// (`sessions/runs.ts`), closed at the run's end (`close`).
import type { AgentRef, Environment, Places, RunScope } from "../contract";
import type { Guidance, RuleRun } from "../files/api";
import type { ParentCall, RunTrace } from "../loop/trace";
import type { GateCall, KeepRequest, LoopToolResult, ToolGate } from "../loop/types";
import type { HeldTool } from "../tools/registry";
import type { Words } from "../tools/kit";
import { TurnGate } from "./gate";
import { type PointedFile, pointerForm, requestPath, sentMessages } from "./requests";
import type { Settings } from "./settings";
import { Transcripts } from "./transcripts";
import { RunSessions } from "../sessions/runs";
import type { SessionBook } from "../sessions/book";
import type { CompactFacts } from "../sessions/compact";
import type { Hooks } from "../external/hooks";

export interface AgentRunDeps {
  env: Environment;
  scope: RunScope;
  trace: RunTrace;
  places: Places;
  /** The guidance of the run: where each of RPH's own tools' descriptions comes from. */
  guidance: Pick<Guidance, "tool">;
  /** The run's settings: which requests are kept (`trace.requests`) and the bound on one call (`results.clip`). */
  settings(): Pick<Settings, "requests" | "clipChars">;
  rules(): RuleRun;
  words: Words;
  /** Every tool an agent of the run may reach, so a tool found by `tool_use` is gated by its own tier and lane. */
  tools(): readonly HeldTool[];
  /** Where each write still under way is handed: the run's end waits for it. */
  tell(written: Promise<unknown>): void;
  /** The files of the turn's folder a kept request may point into, as they are written (the views, `briefing.md`); none: every message is kept as its text. */
  sources?(): Promise<readonly PointedFile[]>;
  /** Told of each call that ran, as its gate takes it after the tool: a job's record of its writes. */
  ran?(call: GateCall, result: LoopToolResult, tool: HeldTool | undefined): void;
  /** The session files, where each sub-agent's and job's agent's run is kept as a session of its own (§13.4); none keeps none. */
  book?: SessionBook;
  /** His hooks, which run before and after each tool of the run's agents; none runs none. */
  hooks?: Hooks;
}

/** What every agent of one run is made with: its gate, its kept requests, its transcript, its session. */
export class AgentRuns {
  readonly #d: AgentRunDeps;
  /** Calls of a write tool that ran without failing, by any agent of the run: the loop's count of the same call starts again after one. */
  #writes = 0;
  /** The sessions of the run's agents that are sessions of their own. */
  readonly #sessions: RunSessions | undefined;

  constructor(deps: AgentRunDeps) {
    this.#d = deps;
    const { env, scope, places } = deps;
    new Transcripts({ files: env.files, scope, folder: places.turn ?? places.session, log: env.log, tell: (written) => deps.tell(written) }).follow(deps.trace);
    if (deps.book !== undefined) {
      this.#sessions = new RunSessions({ book: deps.book, scope, run: deps.trace.run, log: env.log, tell: (written) => deps.tell(written) });
      this.#sessions.follow(deps.trace);
    }
  }

  /** An agent's run is a session of its own: a sub-agent's (`agent`), or a job's first agent (`job`); `by` the call that started it, none for a job the owner started. */
  session(agent: AgentRef, kind: "agent" | "job", by: ParentCall | undefined): void {
    this.#sessions?.open(agent, kind, by);
  }

  /** A summary of such an agent's own older calls (§11), kept in its session's file. */
  compacted(agent: AgentRef, summary: string, facts: CompactFacts): void {
    this.#sessions?.compacted(agent, summary, facts);
  }

  /** One agent ended before the run did (a sub-agent at the turn's reply): its session is closed and written now. */
  end(agent: AgentRef): void {
    this.#sessions?.end(agent);
  }

  /** The run ended, whatever the end: each of its agents' sessions is closed and written. */
  async close(): Promise<void> {
    await this.#sessions?.close();
  }

  /** The gate around each tool call of an agent (§13.3), which counts the run's writes. */
  gate(agent: AgentRef, parent: ParentCall | undefined): ToolGate {
    const d = this.#d;
    const { env } = d;
    const tools = new Map(d.tools().map((tool) => [tool.name, tool]));
    const clip = d.settings().clipChars;
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
      ...(clip !== undefined ? { clipChars: clip } : {}),
      ...(d.hooks !== undefined ? { hooks: d.hooks } : {}),
    });
    const ran = d.ran;
    return {
      before: (call, signal) => gate.before(call, signal),
      after: (call, result, signal, added, room) => {
        const tool = tools.get(call.tool);
        if (tool?.tier === "write" && result.error !== true) this.#writes += 1;
        ran?.(call, result, tool);
        return gate.after(call, result, signal, added, room);
      },
      bound: (call, answer, added, room) => gate.bound(call, answer, added, room),
      permissionOf: (call) => gate.permissionOf(call),
      writes: () => this.#writes,
    };
  }

  /**
   * Keeps what an agent's calls are sent, as `trace.requests` names them, in the turn's folder beside
   * the transcripts, in the pointer form (`requests.ts`), with each declared tool and the file its
   * description came from; none for a run with no turn. A lead's call before a compaction is kept as
   * `save`, apart from its run's own calls.
   */
  keep(agent: AgentRef, kind: "call" | "save" = "call"): KeepRequest | undefined {
    const d = this.#d;
    const which = d.settings().requests;
    const turn = d.places.turn;
    if (which === "none" || turn === undefined) return undefined;
    const { env } = d;
    return (call, messages, opening, declared) => {
      if (which === "first" && call !== 1) return undefined;
      const path = requestPath(turn, agent, call, kind);
      const sent = sentMessages(messages, opening);
      const kept = (async () => {
        const own = new Set(d.tools().flatMap((tool) => (tool.from === "rph" ? [tool.name] : [])));
        const [sources, tools] = await Promise.all([d.sources?.() ?? [], Promise.all(declared.map(async (name) => ({ name, ...(own.has(name) ? await describedBy(d.guidance, name) : {}) })))]);
        return env.files.write(d.scope, path, { op: "write", text: pointerForm(sent, sources, tools) }, "harness");
      })();
      d.tell(
        kept.then(
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

/** The file one of RPH's own tools is described by, where it has one. */
async function describedBy(guidance: Pick<Guidance, "tool">, name: string): Promise<{ file?: string }> {
  const file = (await guidance.tool(name))?.source.path;
  return file === undefined ? {} : { file };
}
