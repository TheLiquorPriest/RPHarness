// What the loop's tests share: a trace port and a reply sink that record, the texts a runner sends
// (invented here; shipped ones are files), and a runner for an agent on a scripted model.
import type { UserMessage } from "@earendil-works/pi-ai";
import type { AgentRef, JsonValue, ReplyError, ReplySink, RuleMoment, Scope, ToolCtx, ToolResult, TraceDelta, TracePort, TraceRecord, Usage } from "../../src/contract";
import { AgentRunner, type Fired, type LoopTool, type LoopToolResult, type RunEndRules, type RunnerOptions, RunTrace } from "../../src/loop";
import { type Answer, FakeClock, scriptedModel, type ScriptedModel } from "../../src/testing/rig";

export { type Answer, FakeClock, gate, type Piece, type RecordedRequest, type Reply, scriptedModel, type ScriptedModel } from "../../src/testing/rig";

export const scope: Scope = { user: "user-a", chat: "chat-a", session: "session-a", turn: "turn-a" };

/** The texts a runner sends a model, as test fixtures. */
export const texts = {
  continueAfterRule: ({ shown }: { shown: string }) => `[Already shown]\n${shown}\n[Go on from there]`,
  closing: "Fixture: true when this call needs no answer.",
};

export class TraceRecorder implements TracePort {
  readonly records: TraceRecord[] = [];
  readonly deltas: TraceDelta[] = [];
  /** performance.now() of each record, in the same order. */
  readonly walls: number[] = [];

  event(record: TraceRecord): void {
    this.records.push(record);
    this.walls.push(performance.now());
  }

  delta(delta: TraceDelta): void {
    this.deltas.push(delta);
  }

  async flush(): Promise<void> {}

  /** The kinds of the records about one agent, in order. */
  kinds(agent?: string): string[] {
    return this.records.filter((record) => agent === undefined || record.agent.id === agent).map((record) => record.event.kind);
  }

  of<K extends TraceRecord["event"]["kind"]>(kind: K): (TraceRecord & { event: Extract<TraceRecord["event"], { kind: K }> })[] {
    return this.records.filter((record): record is TraceRecord & { event: Extract<TraceRecord["event"], { kind: K }> } => record.event.kind === kind);
  }
}

export class SinkRecorder implements ReplySink {
  text = "";
  /** Each piece of the reply, with when it came by the wall and by the clock. */
  readonly pieces: { text: string; wall: number; at: number }[] = [];
  readonly lines: { line: string; at: number }[] = [];
  readonly finished: Usage[] = [];
  readonly errors: ReplyError[] = [];
  readonly #clock: { now(): number } | undefined;

  constructor(clock?: { now(): number }) {
    this.#clock = clock;
  }

  progress(line: string): void {
    this.lines.push({ line, at: this.#clock?.now() ?? Date.now() });
  }

  content(delta: string): void {
    this.text += delta;
    this.pieces.push({ text: delta, wall: performance.now(), at: this.#clock?.now() ?? Date.now() });
  }

  finish(usage: Usage): void {
    this.finished.push(usage);
  }

  error(e: ReplyError): void {
    this.errors.push(e);
  }
}

export interface Rigged {
  runner: AgentRunner;
  scripted: ScriptedModel;
  recorder: TraceRecorder;
  trace: RunTrace;
  clock: FakeClock;
}

/** An agent on a scripted model, in a run of its own unless `trace` puts it in another's. */
export function rigAgent(agent: AgentRef, answers: readonly Answer[], options: Partial<RunnerOptions> & { clock?: FakeClock; recorder?: TraceRecorder; trace?: RunTrace } = {}): Rigged {
  const { clock: givenClock, recorder: givenRecorder, trace: givenTrace, ...rest } = options;
  const clock = givenClock ?? new FakeClock();
  const recorder = givenRecorder ?? new TraceRecorder();
  const trace = givenTrace ?? new RunTrace(recorder, scope, "run-1", clock);
  const scripted = scriptedModel(answers, { clock, id: `model-of-${agent.id}` });
  const runner = new AgentRunner({ agent, trace, model: scripted.model, streamFn: scripted.streamFn, connection: "connection-a", session: `session-of-${agent.id}`, texts, ...rest });
  return { runner, scripted, recorder, trace, clock };
}

/** A tool with one optional text argument, for tests. */
export function tool(name: string, run: (args: JsonValue, ctx: ToolCtx) => Promise<LoopToolResult>, extra: Partial<LoopTool> = {}): LoopTool {
  return { name, description: `Fixture tool ${name}.`, parameters: { type: "object", properties: { note: { type: "string" } } }, run, ...extra };
}

export function said(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** The text of a message as a model was sent it. */
export function textOf(message: { content: unknown }): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")).join("");
}

/** A message from the player, as a prompt ends with one. */
export function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

/** A rule as the rules would give it to the runner when it fires. */
export function fired(rule: string, moment: RuleMoment, text: string, extra: Partial<Fired["firing"]> = {}): Fired {
  return { firing: { rule, path: `rules/${rule}.md`, level: "shipped", moment, ...extra }, text };
}

/** The shipped `reply-missing` rule's working, for tests: due at a run's end while no reply is released, once per turn. */
export function replyMissing(released: () => boolean, text: string): RunEndRules & { fired: number } {
  const rules = {
    fired: 0,
    due: (): Fired[] => {
      if (released() || rules.fired > 0) return [];
      rules.fired += 1;
      return [fired("reply-missing", "run-end", text, { fact: { name: "reply.released", value: { count: 0 } } })];
    },
  };
  return rules;
}