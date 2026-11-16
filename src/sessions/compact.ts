// What a compaction summarizes and writes, for any agent's run (§11): at the point before each of
// the agent's requests, when the request as counted would not fit its model's window less the
// reserve, or its provider refused it as too long; at a lead's first call too when the host asked for
// a compaction or the records mode's records passed their size. Nothing is compacted before a call
// would not fit (§10.2). The moment before compaction comes first, where a rule names the agent; then
// the session's earlier turns are summarized, for a lead; then, when the call still would not fit, the
// run's own older calls and results, its newest part kept whole and no call parted from its result.
// Each summary is written from the compaction part, its material laid out by the carried part, by
// calls of the agent's model in sessions of their own, in pieces where the material is more than one
// call takes; and each compaction is told to the trace: why, what it summarized, its sizes as counted
// before and after, and whose session. His before-compaction hooks see each piece of material as it
// is about to be summarized (§5.4 "Hooks", §11 l.1378): a block keeps what is carried as it is, an
// answer's `summary` stands in place of the summary written, and what a hook adds goes after it.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentRef, JsonObject, Log, TraceEvent } from "../contract";
import { agentJson, type Hooks, scopeJson } from "../external/hooks";
import type { Fields, RuleRun, TemplatePart } from "../files/api";
import { type AgentOutcome, AgentRunner, type Budget, type CallTerms, type KeepRequest, type RunnerOptions, type RunnerTexts, type RunTrace, type Work } from "../loop";
import type { PendingRequest, RequestPoint, RequestSpan } from "../loop/types";
import type { AgentModel } from "../model/source";
import { messageText, promptTokens, tokensOf } from "../model/tokens";
import { joined } from "../agents/attachments";
import { nextPiece } from "./carry";

/** Why a compaction was made (S-9). */
export type CompactReason = Extract<TraceEvent, { kind: "compacted" }>["reason"];

/** What a compaction's entry keeps beside its summary, for the Sessions page: why, and the request's size as counted before and after. */
export interface CompactFacts {
  reason: CompactReason;
  before: number;
  after: number;
}

/** How a compaction's material is laid out for its call by the carried part: the summary so far, and the turns (or the run's own work) it is to stand for. */
export type MaterialFields = (summary: string | undefined, turns: readonly JsonObject[]) => Fields | undefined;

/** Summarizes material through the compaction part: its summary, or undefined when none could be written. */
export type Summarize = (fields: MaterialFields, summary: string | undefined, turns: readonly JsonObject[]) => Promise<string | undefined>;

/** A lead's session's earlier turns (§11): what its carried block summarizes. */
export interface EarlierTurns {
  /** At the run's first call, why it compacts though the call would fit: the host asked, or the records mode's records passed their size. */
  starting(): "asked" | "fold" | undefined;
  /** Whether earlier turns are left to summarize. */
  left(): boolean;
  /** Summarizes them and writes the summary as the turn's: the carried block as it then stands, its place in the run's fixed context, and how many turns it keeps as they were. */
  compact(summarize: Summarize, facts: { reason: CompactReason; before: number }): Promise<{ at: number; message: AgentMessage; keptTurns: number } | undefined>;
}

export interface CompactorDeps {
  /** The agent whose run is compacted. */
  agent: AgentRef;
  trace: RunTrace;
  /** The agent's model, which its summary calls are made on too. */
  model: AgentModel;
  connection: string;
  /** The session of the run compacted, which the trace's record names. */
  session: string;
  terms: CallTerms;
  texts: RunnerTexts;
  budget?: Budget;
  /** `compaction.reserve`, `compaction.overflowTries` and `compaction.keepRecent`, as the run read them. */
  settings: { reserve: number; overflowTries: number; keepRecent: number };
  /** The compaction part and the carried part, as they stand. */
  parts(): Promise<{ compaction: TemplatePart | undefined; carried: TemplatePart | undefined }>;
  ids(): string;
  log: Log;
  /** A summary call's own session ended: what pi keeps for it is let go. */
  ended(session: string): void;
  keep?(agent: AgentRef): KeepRequest | undefined;
  /** A call of the compaction's own began: it stops with the run, and is forgotten once it ends. */
  track(entry: { runner: AgentRunner; work: Work }): () => void;
  /** Whether the run has stopped, beside each request's own signal. */
  stopped?(): boolean;
  /** The moment before compaction (§11 l.1375): the rules due for this agent, and its save call on its context as it stands. None: no such moment. */
  before?(request: PendingRequest): Promise<void>;
  /** The session's earlier turns, for a lead. */
  earlier?: EarlierTurns;
  /** Where a summary of the run's own older calls is kept as the run's: the agent's session file. */
  written?(summary: string, facts: CompactFacts): void;
  /** His hooks, asked before each compaction's summary; none asks none. */
  hooks?: Hooks;
}

/** What an agent's save call at the moment before compaction is made with. */
export interface SaveDeps {
  /** The agent's own runner's options: the save call is its call, on its model, tools, gate and session. */
  options: RunnerOptions;
  rules: RuleRun;
  /** `compaction.saveCalls`: the calls the rule gives, bounded by the definition's own where that is less. */
  saveCalls: number;
  /** What keeps the save call's requests (`.save-<n>.json`). */
  keep?: KeepRequest;
  track(entry: { runner: AgentRunner; work: Work }): () => void;
  stopped(): boolean;
  /** What its start record names it was handed. */
  given?: string[];
}

/**
 * The moment before compaction (§11 l.1375) for one agent: the rules due for it give it a call with
 * their text, on its context as it stands (its fixed context and its own work so far), so it can save
 * what it wants kept; its last call's tools run, and nothing after them. Whatever that call came to,
 * the compaction goes ahead: a refused or failed save call is in the trace.
 */
export async function saveBeforeCompaction(request: PendingRequest, d: SaveDeps): Promise<void> {
  const { options } = d;
  const due = await d.rules.beforeCompaction(options.agent);
  if (due.length === 0 || d.stopped()) return;
  for (const fired of due) options.trace.event(options.agent, undefined, { kind: "rule_fired", firing: { ...fired.firing, agent: options.agent, action: "call" } });
  const { channel: _channel, point: _point, runEnd: _runEnd, questions: _questions, changed: _changed, keep: _keep, ...own } = options;
  const saver = new AgentRunner({
    ...own,
    context: request.messages.slice(request.context.from),
    limits: { ...options.limits, calls: Math.min(d.saveCalls, options.limits?.calls ?? d.saveCalls) },
    stream: d.rules.stream(options.agent),
    ...(d.keep !== undefined ? { keep: d.keep } : {}),
  });
  if (d.stopped()) return;
  const text = due.map((fired) => fired.text.trimEnd()).filter((line) => line.trim() !== "").join("\n\n");
  const work = saver.start({ messages: [{ role: "user", content: text, timestamp: options.trace.clock.now() }] }, d.given !== undefined ? { given: d.given } : {});
  const untrack = d.track({ runner: saver, work });
  try {
    await work.done;
  } finally {
    untrack();
  }
}

/** A message's tokens, by the model layer's estimate. */
function weigh(messages: readonly AgentMessage[], ratio: number): number {
  return promptTokens(messages as Message[], ratio);
}

function textOf(message: AgentMessage): string {
  return messageText(message as Message).trim();
}

/**
 * The run's own work as the carried part lays it out (`run`): what the agent wrote, each call with
 * what came back, and what it was told between them, in order.
 */
export function workItems(messages: readonly AgentMessage[]): JsonObject[] {
  const results = new Map<string, Message & { role: "toolResult" }>();
  for (const message of messages as readonly Message[]) if (message.role === "toolResult") results.set(message.toolCallId, message);
  return (messages as readonly Message[]).flatMap((message): JsonObject[] => {
    if (message.role === "user") {
      const text = textOf(message);
      return text === "" ? [] : [{ heard: text }];
    }
    if (message.role !== "assistant") return [];
    const said = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
    const items: JsonObject[] = said === "" ? [] : [{ said }];
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      const call: JsonObject = { tool: part.name, args: JSON.stringify(part.arguments) };
      const result = results.get(part.id);
      if (result !== undefined) call["result"] = textOf(result);
      if (result?.isError === true) call["error"] = true;
      items.push({ call });
    }
    return items;
  });
}

/**
 * The run's own older work a summary is to stand for: from the first answer of the agent's own work
 * (what it was started with stays, and a summary of its own written before is folded in) up to the
 * newest `keep` tokens, which stay whole; the cut never falls between a call and its result. With
 * `prior`, the summary of the run's own work it begins with. Undefined when nothing older is left.
 */
export function olderWork(messages: readonly AgentMessage[], start: number, keep: number, ratio: number, summaries: ReadonlyMap<AgentMessage, string>): { from: number; to: number; prior?: string } | undefined {
  let from = start;
  while (from < messages.length && (messages[from] as Message).role !== "assistant" && !summaries.has(messages[from]!)) from += 1;
  if (from >= messages.length) return undefined;
  const prior = summaries.get(messages[from]!);
  let to = messages.length;
  let kept = 0;
  while (to > from && kept < keep) {
    to -= 1;
    kept += weigh([messages[to]!], ratio);
  }
  // Whole calls only: a result stays with the call it answers.
  while (to > from && (messages[to] as Message | undefined)?.role === "toolResult") to -= 1;
  const first = prior !== undefined ? from + 1 : from;
  if (to <= first) return undefined;
  return { from, to, ...(prior !== undefined ? { prior } : {}) };
}

/**
 * Compaction for one agent's run: its point before each request (`point`), and the summary calls,
 * which the lead's compaction of its session's earlier turns makes through it too.
 */
export class Compactor {
  readonly #d: CompactorDeps;
  /** The summaries of the run's own work put in place, by the message that holds each. */
  readonly #summaries = new Map<AgentMessage, string>();
  /** Whether the run's first call is still to be checked for the reasons only it has. */
  #first = true;
  /** The signal of the request being checked: a stop of the work ends the compaction's own calls. */
  #signal: AbortSignal | undefined;

  constructor(deps: CompactorDeps) {
    this.#d = deps;
  }

  #stopped(): boolean {
    return this.#d.stopped?.() === true || this.#signal?.aborted === true;
  }

  /** The run's point before each request (§11). */
  point(window: number | undefined): RequestPoint {
    return { ...(window !== undefined && window > 0 ? { window } : {}), reserve: this.#d.settings.reserve, resend: this.#d.settings.overflowTries, check: (request) => this.check(request) };
  }

  /** What to put in place before `request` goes out: nothing, or the spans the compaction gives. */
  async check(request: PendingRequest): Promise<readonly RequestSpan[] | undefined> {
    const d = this.#d;
    const ratio = d.terms.charsPerToken;
    const window = request.window ?? 0;
    const fits = window > 0 ? window - request.reserve : Number.POSITIVE_INFINITY;
    const refused = request.refused !== undefined;
    const tight = refused || request.tokens > fits;
    const start = request.call === 1 && this.#first ? d.earlier?.starting() : undefined;
    this.#first = false;
    this.#signal = request.signal;
    if ((!tight && start === undefined) || this.#stopped()) return undefined;
    const reason: CompactReason = refused ? "refused" : tight ? "would-not-fit" : start!;
    const keep = Math.min(d.settings.keepRecent, Number.isFinite(fits) ? Math.floor(fits / 2) : d.settings.keepRecent);
    const earlier = d.earlier?.left() === true;
    const own = tight ? olderWork(request.messages, request.context.to, keep, ratio, this.#summaries) : undefined;
    const fields = { ...(d.trace.scope.turn !== undefined ? { turn: d.trace.scope.turn } : {}), run: d.trace.run, agent: d.agent.id, tokens: request.tokens, ...(window > 0 ? { window, reserve: request.reserve } : {}) };
    if (!earlier && own === undefined) {
      if (tight) d.log.warn(refused ? "A call was refused as too long, and its run has nothing left to summarize; it ends as the provider answered." : "A call would not fit its model's window less the reserve, and its run has nothing left to summarize; it goes out as it is.", fields);
      return undefined;
    }
    const parts = await d.parts();
    if ((parts.compaction?.render().text.trim() ?? "") === "") {
      d.log.warn("Nothing can be summarized: the compaction part is empty or missing. The run goes on as it is.", fields);
      return undefined;
    }
    await d.before?.(request);
    if (this.#stopped()) return undefined;

    const messages = [...request.messages];
    const spans: RequestSpan[] = [];
    let size = request.tokens;
    const told = (of: "turns" | "run", before: number, keptTurns?: number): void =>
      d.trace.event(d.agent, undefined, { kind: "compacted", session: d.session, reason, of, before, after: size, ...(keptTurns !== undefined ? { keptTurns } : {}) });
    const summarize: Summarize = async (layout, summary, turns) => {
      // His before-compaction hooks, with what is about to be summarized: a block keeps the carried block as it is; `summary` replaces the one written; what they add goes after it.
      const hooked = await d.hooks?.run("before-compaction", { scope: scopeJson(d.trace.scope), agent: agentJson(d.agent), reason, ...(summary !== undefined ? { summary } : {}), turns: [...turns] }, { agent: d.agent }, request.signal);
      if (hooked?.blocked !== undefined) return undefined;
      const made = hooked?.summary ?? (await this.#summarize(parts, layout, summary, turns, fits));
      return made === undefined || hooked === undefined || hooked.added.length === 0 ? made : joined([made, ...hooked.added]);
    };
    if (earlier) {
      const done = await d.earlier!.compact(summarize, { reason, before: size });
      if (done !== undefined) {
        const at = request.context.from + done.at;
        const before = size;
        size += weigh([done.message], ratio) - weigh([messages[at]!], ratio);
        messages[at] = done.message;
        spans.push({ from: at, to: at + 1, messages: [done.message] });
        told("turns", before, done.keptTurns);
      }
    }
    // The run's own older calls, when no earlier turn was left to summarize or the call still would not fit.
    if (tight && !this.#stopped() && (spans.length === 0 || (!refused && size > fits))) {
      const work = olderWork(messages, request.context.to, keep, ratio, this.#summaries);
      if (work !== undefined) {
        const summary = await summarize((prior, turns) => ({ run: true, compacting: true, ...(prior !== undefined ? { summary: prior } : {}), turns: [...turns] }), work.prior, [{ items: workItems(messages.slice(work.prior !== undefined ? work.from + 1 : work.from, work.to)) }]);
        if (summary !== undefined && !this.#stopped()) {
          const text = parts.carried?.render({ run: true, summary }).text.trim() || summary;
          const message: AgentMessage = { role: "user", content: text, timestamp: d.trace.clock.now() };
          this.#summaries.set(message, summary);
          const before = size;
          size += weigh([message], ratio) - weigh(messages.slice(work.from, work.to), ratio);
          spans.push({ from: work.from, to: work.to, messages: [message] });
          d.written?.(summary, { reason, before, after: size });
          told("run", before);
        }
      }
    }
    return spans.length > 0 ? spans : undefined;
  }

  /**
   * Summarizes material from the compaction part: one call, or, where the material is more than the
   * model's window less the reserve takes, one a piece, oldest first, each piece's summary handed to
   * the next as the summary its material follows.
   */
  async #summarize(parts: { compaction: TemplatePart | undefined; carried: TemplatePart | undefined }, layout: MaterialFields, summary: string | undefined, turns: readonly JsonObject[], fits: number): Promise<string | undefined> {
    const d = this.#d;
    const ratio = d.terms.charsPerToken;
    const instructions = parts.compaction?.render().text.trim() ?? "";
    if (instructions === "" || turns.length === 0) {
      d.log.warn("Nothing can be summarized: the compaction part, or what it would summarize, is empty. The run goes on as it is.", { agent: d.agent.id });
      return undefined;
    }
    const laid = (before: string | undefined, piece: readonly JsonObject[]): string => {
      const fields = layout(before, piece);
      return fields === undefined ? "" : (parts.carried?.render(fields).text.trim() ?? "");
    };
    let written = summary;
    let left: readonly JsonObject[] = turns;
    while (left.length > 0) {
      const { piece, rest } = nextPiece(left, fits, (some) => tokensOf(instructions, ratio) + tokensOf(laid(written, some), ratio));
      const next = await this.#call(instructions, laid(written, piece));
      if (next === undefined) return undefined;
      written = next;
      left = rest;
    }
    return written;
  }

  /**
   * One summary call: the compaction part's instructions, and one piece of what is summarized, in a
   * session of its own for the call, let go when it ends, so it never takes the agent's cached front
   * or thread (§10.2). Its summary, or undefined when the run stopped or the call gave none, which the
   * log is told.
   */
  async #call(instructions: string, material: string): Promise<string | undefined> {
    const d = this.#d;
    if (this.#stopped()) return undefined;
    const session = d.ids();
    const summarizing: AgentRef = { id: d.ids(), definition: d.agent.definition, ...(d.agent.job !== undefined ? { job: d.agent.job } : {}) };
    const keep = d.keep?.(summarizing);
    const runner = new AgentRunner({
      agent: summarizing,
      trace: d.trace,
      model: d.model.model,
      streamFn: d.model.streamFn,
      connection: d.connection,
      session,
      thinkingLevel: d.model.thinkingLevel,
      terms: d.terms,
      instructions,
      texts: d.texts,
      ...(d.budget !== undefined ? { turn: d.budget } : {}),
      ...(keep !== undefined ? { keep } : {}),
    });
    const work = runner.start({ messages: [{ role: "user", content: material, timestamp: d.trace.clock.now() }] });
    const untrack = d.track({ runner, work });
    let outcome: AgentOutcome;
    try {
      outcome = await work.done;
    } finally {
      untrack();
      d.ended(session);
    }
    if (this.#stopped()) return undefined;
    const summary = outcome.status === "done" ? outcome.text.trim() : "";
    if (summary !== "") return summary;
    d.log.warn("A compaction's summary could not be written; the run goes on as it is.", { agent: d.agent.id, status: outcome.status, ...(outcome.error !== undefined ? { error: outcome.error } : {}) });
    return undefined;
  }
}
