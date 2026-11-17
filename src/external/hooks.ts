// Hooks (§5.4 "Hooks", P6, P15; PlanHarnessCore-2): his commands, named in `hooks.yml` by the moment
// they run at, run by the one command runner as his user outside RPH's process, with the moment's
// JSON on stdin, each under its own timeout or `hooks.timeoutSeconds`. Nothing runs that the host's switches
// do not have on for him, asked by exactly the line written (§16). A hook answers with JSON on its
// stdout: `decision: "block"` with a `reason` blocks, as does its exit code `hooks.blockExit` with its
// stderr as the reason; `context` adds a text; `input` (before a tool) gives the call's arguments as
// they are to be. Any other failure, an answer past `hooks.maxAnswerBytes`, or a timeout blocks nothing and
// is shown with its words. The hooks of one moment run one after another, the farthest level's
// first; the first block ends the rest. Every run of a hook is traced (`hook`), with its reason or
// what it added. With no hooks nothing runs and nothing waits (§17.5).
import type { AgentRef, HookEvent, JsonObject, JsonValue, LayerLevel, Log, RunScope, SwitchesPort, TraceEvent } from "../contract";
import type { Settings } from "../harness/settings";
import type { ParentCall } from "../loop/trace";
import { runCommand } from "./run";

/**
 * A hook as `hooks.yml` names it (§5.4 "Hooks"): the moment it runs at, its name, the command line
 * exactly as written, its timeout in seconds where it names one, and the file and line it is written
 * at. Switched off by `off:` as `hooks/<name>`, as any of his files is.
 */
export interface HookEntry {
  name: string;
  on: HookEvent;
  command: string;
  timeout?: number;
  path: string;
  level: LayerLevel;
  line: number;
}

/** What the hooks of one moment came to: the first block, the texts they added, and a tool call's arguments as a hook changed them. */
export interface HookAnswer {
  blocked?: { hook: string; reason: string };
  added: string[];
  input?: JsonObject;
  /** Before a compaction: the summary a hook gives in place of the one that would be written (§11 l.1378). */
  summary?: string;
}

/** The settings hooks run under (`hooks.*`): the timeout where a hook names none, the exit code that blocks, the most read of an answer, and what of stderr is kept as a reason. */
export interface HookSettings {
  timeoutMs: number;
  blockExit: number;
  answerMax: number;
  reasonChars: number;
}

export interface HooksDeps {
  /** The hooks in force for the run's scope, the farthest level's first (`Guidance.hooks`). */
  hooks(): Promise<readonly HookEntry[]>;
  switches: SwitchesPort | undefined;
  user: string;
  settings: HookSettings;
  trace: HookTrace;
  log: Log;
}

/** Where each hook's run is told: a run's trace, or, at a moment that is no agent's (a session's close by the host), the host's trace with no agent. */
export interface HookTrace {
  event(agent: AgentRef | undefined, parent: ParentCall | undefined, event: TraceEvent): void;
}

/** Who a moment's hooks run for: the agent (none at a moment that is no agent's), the call its work hangs under, and the tool call where the moment is one's. */
export interface HookWho {
  agent?: AgentRef;
  parent?: ParentCall;
  callId?: string;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A run's scope as a hook is sent it. */
export function scopeJson(scope: RunScope): JsonObject {
  return { user: scope.user, session: scope.session, ...(scope.chat !== undefined ? { chat: scope.chat } : {}), ...(scope.turn !== undefined ? { turn: scope.turn } : {}) };
}

/** An agent as a hook is sent it. */
export function agentJson(agent: AgentRef): JsonObject {
  return { id: agent.id, definition: agent.definition, ...(agent.plays !== undefined ? { plays: agent.plays } : {}) };
}

/** The settings hooks run under, from the user's (`hooks.*`). */
export function hookSettings(settings: Pick<Settings, "hookTimeout" | "hookBlockExit" | "hookAnswerMax" | "hookReasonChars">): HookSettings {
  return { timeoutMs: settings.hookTimeout, blockExit: settings.hookBlockExit, answerMax: settings.hookAnswerMax, reasonChars: settings.hookReasonChars };
}

/** A run's hooks, read once for the run. */
export class Hooks {
  readonly #d: HooksDeps;
  #entries: Promise<readonly HookEntry[]> | undefined;

  constructor(deps: HooksDeps) {
    this.#d = deps;
  }

  /** Whether any hook of `on` would run: written for it, and switched on for the user. */
  async any(on: HookEvent): Promise<boolean> {
    const d = this.#d;
    if (d.switches === undefined) return false;
    for (const hook of (await this.#read()).filter((entry) => entry.on === on)) {
      if ((await d.switches.state(d.user, { kind: "hook", name: hook.name, target: hook.command })) === "on") return true;
    }
    return false;
  }

  /** Runs the hooks of `on`, one after another, with `input` on stdin; a block ends the rest. */
  async run(on: HookEvent, input: JsonObject, who: HookWho, signal?: AbortSignal): Promise<HookAnswer> {
    const d = this.#d;
    const answer: HookAnswer = { added: [] };
    for (const hook of (await this.#read()).filter((entry) => entry.on === on)) {
      if (signal?.aborted === true) break;
      const sent: JsonObject = answer.input !== undefined ? { ...input, args: answer.input } : input;
      const result = await runCommand({ command: hook.command, kind: "hook", name: hook.name, user: d.user, input: { hook: hook.name, event: on, ...sent }, timeoutMs: hook.timeout !== undefined ? hook.timeout * 1000 : d.settings.timeoutMs, readMost: d.settings.answerMax, ...(signal !== undefined ? { signal } : {}) }, d.switches);
      const traced = (outcome: "ok" | "added" | "changed" | "blocked" | "failed" | "timed-out", ms: number, text?: string): void => {
        d.trace.event(who.agent, who.parent, { kind: "hook", hook: hook.name, on, outcome, ms, ...(who.callId !== undefined ? { callId: who.callId } : {}), ...(text !== undefined && text !== "" ? { text } : {}) });
      };
      if (result.status === "failed") {
        traced("failed", 0, result.why);
        continue;
      }
      // A hook the switches do not have on does not run; the list of what waits names it.
      if (result.status !== "ran") continue;
      const reason = (text: string): string => text.trim().slice(-d.settings.reasonChars);
      if (result.timedOut) {
        traced("timed-out", result.ms, reason(result.stderr));
        continue;
      }
      if (result.exit === d.settings.blockExit) {
        answer.blocked = { hook: hook.name, reason: reason(result.stderr) };
        traced("blocked", result.ms, answer.blocked.reason);
        break;
      }
      if (result.exit !== 0 || result.cut) {
        traced("failed", result.ms, result.cut ? `answered more than ${d.settings.answerMax} bytes` : reason(result.stderr));
        continue;
      }
      const said = isObject(result.output) ? result.output : {};
      if (said["decision"] === "block") {
        answer.blocked = { hook: hook.name, reason: typeof said["reason"] === "string" ? said["reason"] : reason(result.stderr) };
        traced("blocked", result.ms, answer.blocked.reason);
        break;
      }
      const context = typeof said["context"] === "string" && said["context"].trim() !== "" ? said["context"] : undefined;
      const changed = on === "before-tool" && isObject(said["input"]) ? said["input"] : undefined;
      const summary = on === "before-compaction" && typeof said["summary"] === "string" ? said["summary"] : undefined;
      if (changed !== undefined) answer.input = changed;
      if (summary !== undefined) answer.summary = summary;
      if (context !== undefined) answer.added.push(context);
      traced(changed !== undefined || summary !== undefined ? "changed" : context !== undefined ? "added" : "ok", result.ms, context);
    }
    return answer;
  }

  /** The hooks in force, read once for the run. */
  #read(): Promise<readonly HookEntry[]> {
    const d = this.#d;
    this.#entries ??= d.hooks().catch((error: unknown) => {
      d.log.error("The hooks could not be read; none runs.", { error: error instanceof Error ? error.message : String(error) });
      return [];
    });
    return this.#entries;
  }

  /**
   * The moment an agent's work would end (§13.3 l.1458): the run-end hooks, with the run's scope and
   * the agent. A hook's block gives the reason the agent goes on with, for one more call.
   */
  async atRunEnd(scope: RunScope, who: HookWho & { agent: AgentRef }, signal?: AbortSignal): Promise<string | undefined> {
    return (await this.run("run-end", { scope: scopeJson(scope), agent: agentJson(who.agent) }, who, signal)).blocked?.reason;
  }
}
