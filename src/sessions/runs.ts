// Every agent's run, a session of its own (§11, §13.4, §13.5): a sub-agent's and a job's agent's
// work is kept in a file in its own session's folder, as a lead's is kept in its scene's. Its first
// line says what it is (`agent`, `job`) and what started it (the session, turn, agent and call, or
// the owner); then, as the work goes, what the agent wrote in each call, its calls and what came
// back, never its thinking (`entryOf`, the one way a record becomes an entry, the lead's too).
// `agent_message` writes on in the same file. The run's end closes each of its sessions, whatever
// the end, so a job a restart cut off leaves every entry written before it.
import type { AgentRef, Log, Scope, SessionParent, TraceEvent } from "../contract";
import type { AgentRecord, ParentCall, RunTrace } from "../loop/trace";
import type { HeldFile, NewEntry, SessionBook } from "./book";
import type { CompactFacts } from "./compact";

/** What a record of an agent's work is in its session's file: its intent record, what it wrote in a call, a call, what came back; nothing for any other record. */
export function entryOf(event: TraceEvent, turn: string, parent: string | null): NewEntry | undefined {
  switch (event.kind) {
    case "intent":
      return { type: "intent", parent, turn, text: event.text };
    case "call_ended":
      return { type: "message", parent, turn, call: event.call, text: event.text, stop: event.stop, ...(event.error !== undefined ? { error: event.error } : {}) };
    case "tool_started":
      return { type: "call", parent, turn, callId: event.callId, tool: event.tool, args: event.args, ...(event.closing ? { closing: true as const } : {}), ...(event.via !== undefined ? { via: event.via } : {}) };
    case "tool_ended": {
      const { result } = event;
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      return { type: "result", parent, turn, callId: event.callId, tool: event.tool, text, ...(result.reports !== undefined && result.reports.length > 0 ? { reports: result.reports } : {}), ...(result.error === true ? { error: true as const } : {}) };
    }
    default:
      return undefined;
  }
}

export interface RunSessionsDeps {
  book: SessionBook;
  /** The run's own scope: its user, chat, session and turn. */
  scope: Scope;
  /** The run's id: what a run with no turn (a job the owner started) keys its sessions' work by. */
  run: string;
  log: Log;
  /** Where each write still under way is handed: the run's end waits for it. */
  tell(written: Promise<unknown>): void;
}

/** One agent's run that is a session of its own: its file, held while the run goes on. */
interface Opened {
  scope: Scope;
  held: Promise<HeldFile>;
}

/** The sessions of one run's agents (a turn's sub-agents; a job's agent and its sub-agents). */
export class RunSessions {
  readonly #d: RunSessionsDeps;
  /** Each agent's session, by its id, as its start record names it: what a sub-agent's file names as the session it was started from. */
  readonly #sessions = new Map<string, string>();
  /** The runs that are sessions of their own, by agent id: what they are, until each begins. */
  readonly #asked = new Map<string, { kind: "agent" | "job"; parent: SessionParent }>();
  readonly #opened = new Map<string, Opened>();
  /** The turn their work is kept under: the run's turn, or the run itself where it has none. */
  readonly #turn: string;

  constructor(deps: RunSessionsDeps) {
    this.#d = deps;
    this.#turn = deps.scope.turn ?? deps.run;
  }

  /** Writes every record of the run's agents that are sessions of their own into their files. */
  follow(trace: RunTrace): void {
    trace.watch((record) => this.#take(record));
  }

  /**
   * An agent's run is a session of its own: a sub-agent (`agent`), or a job's first agent (`job`).
   * `by` is the call that started it, none for a job the owner started. Its file begins when its work
   * does.
   */
  open(agent: AgentRef, kind: "agent" | "job", by: ParentCall | undefined): void {
    const session = by === undefined ? undefined : this.#sessions.get(by.agent);
    const turn = this.#d.scope.turn;
    const parent: SessionParent = by === undefined ? { owner: true } : { agent: by.agent, call: by.call, ...(session !== undefined ? { session } : {}), ...(turn !== undefined ? { turn } : {}) };
    this.#asked.set(agent.id, { kind, parent });
  }

  #take(record: AgentRecord): void {
    const { event, agent } = record;
    if (event.kind === "agent_started") {
      this.#sessions.set(agent.id, event.session);
      this.#begin(agent, event.session);
      return;
    }
    const opened = this.#opened.get(agent.id);
    if (opened === undefined) return;
    this.#on(opened, (file) => {
      const entry = entryOf(event, this.#turn, file.log.tip(this.#turn) ?? null);
      if (entry !== undefined) file.add(entry);
    });
  }

  /** Its file, begun at its first start, and its work as a turn of it; a later start (`agent_message`) writes on under the same. */
  #begin(agent: AgentRef, session: string): void {
    const asked = this.#asked.get(agent.id);
    if (asked === undefined || this.#opened.has(agent.id)) return;
    const { scope } = this.#d;
    const own: Scope = { user: scope.user, chat: scope.chat, session };
    const opened: Opened = { scope: own, held: this.#d.book.hold(own) };
    this.#opened.set(agent.id, opened);
    this.#on(opened, (file) => {
      file.begin({ kind: asked.kind, parent: asked.parent, agent: agent.definition });
      if (file.log.turn(this.#turn) === undefined) file.add({ type: "turn", parent: file.log.leaf, turn: this.#turn, kind: "new", lead: agent.definition });
    });
  }

  /** A summary of such an agent's own older calls (§11), kept in its file as its run's compaction; it stands for those entries, which the file keeps. */
  compacted(agent: AgentRef, summary: string, facts: CompactFacts): void {
    const opened = this.#opened.get(agent.id);
    if (opened === undefined) return;
    this.#on(opened, (file) => {
      const begun = file.log.turn(this.#turn);
      if (begun !== undefined) file.add({ type: "compacted", parent: file.log.tip(this.#turn) ?? begun.id, turn: this.#turn, summary, kept: begun.id, of: "run", ...facts });
    });
  }

  /** Works on an opened file, in the order asked (each waits on the one hold); a failure is logged, and the run goes on. */
  #on(opened: Opened, work: (file: HeldFile["file"]) => void): void {
    const done = opened.held.then(({ file }) => work(file));
    this.#d.tell(done.catch((error: unknown) => this.#d.log.error("An agent's session file could not be written.", { session: opened.scope.session, error: error instanceof Error ? error.message : String(error) })));
  }

  /** One agent ended before its run did (a sub-agent at the turn's reply, §13.4): its session is closed now, and let go once written. */
  end(agent: AgentRef): void {
    const opened = this.#opened.get(agent.id);
    if (opened === undefined) return;
    this.#opened.delete(agent.id);
    this.#d.tell(this.#closed(opened).catch((error: unknown) => this.#d.log.error("An agent's session file could not be written.", { session: opened.scope.session, error: error instanceof Error ? error.message : String(error) })));
  }

  /** The run ended: each of its sessions is closed as the work of its turn, and let go once written. */
  async close(): Promise<void> {
    const opened = [...this.#opened.values()];
    this.#opened.clear();
    await Promise.allSettled(opened.map((one) => this.#closed(one)));
  }

  /** Closes one session as the work of its turn, and lets it go once written. */
  async #closed(one: Opened): Promise<void> {
    const { file, release } = await one.held;
    try {
      if (file.log.entries.every((entry) => entry.type !== "closed")) file.add({ type: "closed", parent: file.log.tip(this.#turn) ?? file.log.leaf, turn: this.#turn });
      await file.settled();
    } finally {
      release();
    }
  }
}
