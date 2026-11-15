// Jobs (§13.5, Appendix A `JobsApi`): an agent's run that outlives the turn's reply. Nothing starts
// one but an agent's `job_start` or the user (`Harness.jobs.start`); code never does. Code holds
// jobs to the user's settings and to nothing else: how many run at once (one past it waits for a
// place), how many may be started in the user's day, the same for the jobs on one connection, how
// many the agents of one run may start, the tokens all of the user's jobs may spend in the user's
// day (none starts past it, and a running one is stopped at its next call), and what one job's run
// may spend. A job an agent of another job started spends from that job's run as well as its own, so
// that a chain of jobs never spends more than its first may. A job is tied to the turn that started
// it: the host saying that turn left the path cancels it, and a stop of the turn does not. Each change
// of a job's state is kept in the host's store under its user, told to the host and traced, so a
// restart finds a job that was running and lists it as interrupted, with what it had done; the day's
// counts of jobs and of their tokens are kept there too, under the user alone. RPH cannot list the
// users a store holds, so what a restart cut off is found for each user at his first call.
import type { DelegateCall } from "../agents/tools";
import type { JobsApi, JobStart, JobState, JobView, JsonValue, LimitHit, Scope, ToolCtx, Usage } from "../contract";
import { loadGuidance } from "../files";
import { lines } from "../harness/means";
import { type ConnectionCounts, jobCountsFor, type Settings } from "../harness/settings";
import { emptyUsage, type LoopToolResult } from "../loop";
import { answer } from "../tools";
import { type JobAsk, type JobCore, type PreparedJob, prepareJob } from "./run";
import type { JobsWork, RunJobs } from "./tool";

/** The lines `job_start` answers with (`.prompts/jobs.md`). */
const LINES_PART = "jobs";

/** Where each job is kept in the host's store, by its id. */
const KEPT = "jobs/all/";
/** Where the count of each day's jobs is kept, by the user's day. */
const DAYS = "jobs/days/";

/** The states a job is still under way in: a restart finds it interrupted. */
const UNDER_WAY: Readonly<Partial<Record<JobState, true>>> = { queued: true, running: true };

/** A job of this process, waiting for its place or running. */
interface Live {
  view: JobView;
  prepared: PreparedJob;
  /** The settings' keys of its connection's own counts, and their counts. */
  connections: { key: string; atOnce?: number }[];
  /** What the user's jobs spent in the day it was started on, which its calls count into. */
  spend: DaySpend;
  /** Stops its run; the state it ends in is the reason's. */
  controller: AbortController;
  /** Settles once its end is kept and told. */
  done: Promise<JobView>;
  settle(view: JobView): void;
}

/**
 * A day's count of the jobs a user started: all of them, those on each connection a setting names,
 * and the tokens all of them sent (cached ones included), read again from a provider's cache, and
 * wrote. The tokens are kept as they were spent, so that the weight of a cached token in force
 * applies to the whole day.
 */
interface DayCount {
  all: number;
  connections: Record<string, number>;
  tokens: { input: number; cacheRead: number; output: number };
}

/** What all of one user's jobs spent in one of the user's days, as this process counts it: from the day's record in the store, then from every call of their agents as it is made. */
interface DaySpend {
  /** The day's record in the store. */
  key: string;
  user: string;
  /** Counted into by the budget of every job of the user's started that day. */
  used: Usage;
}

/** What came of making a job: the job, as it stands once it had its chance at a place; the user's limit it would pass; or the answer that says why none could be made. */
type Begun = { view: JobView } | { hit: LimitHit } | LoopToolResult;

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A kept job, read back: undefined for anything that is not one. */
function keptView(value: JsonValue | undefined): JobView | undefined {
  if (!isObject(value) || typeof value["id"] !== "string" || typeof value["state"] !== "string") return undefined;
  return value as unknown as JobView;
}

function dayCount(value: JsonValue | undefined): DayCount {
  const all = isObject(value) && typeof value["all"] === "number" ? value["all"] : 0;
  const connections: Record<string, number> = {};
  const kept = isObject(value) ? value["connections"] : undefined;
  if (isObject(kept)) for (const [key, count] of Object.entries(kept)) if (typeof count === "number") connections[key] = count;
  const spent = isObject(value) ? value["tokens"] : undefined;
  const part = (name: string): number => {
    const count = isObject(spent) ? spent[name] : undefined;
    return typeof count === "number" ? count : 0;
  };
  return { all, connections, tokens: { input: part("input"), cacheRead: part("cacheRead"), output: part("output") } };
}

function errorWords(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Jobs implements JobsApi, JobsWork {
  readonly #core: Omit<JobCore, "jobs">;
  readonly #live = new Map<string, Live>();
  /** The jobs waiting for a place, oldest first. */
  readonly #queue: Live[] = [];
  /** What is being kept and told, until it settles. */
  readonly #pending = new Set<Promise<unknown>>();
  /** Each job's latest write to the store, so its writes land in the order its state changed. */
  readonly #writes = new Map<string, Promise<unknown>>();
  /** What each user's jobs have spent today, by the day and the user, read from the store once in this process. */
  readonly #days = new Map<string, Promise<DaySpend>>();
  /** For each user this process has acted for: settles once the jobs a restart found him under way are kept as interrupted. */
  readonly #recovered = new Map<string, Promise<void>>();

  constructor(core: Omit<JobCore, "jobs">) {
    this.#core = core;
  }

  /**
   * `job_start`: a job tied to the caller's turn, in a session of its own, counted among the jobs of
   * the caller's run (`run`), and for a caller that is a job's agent, against that job's run too; the
   * answer says what became of it.
   */
  async startFor(call: DelegateCall, ctx: ToolCtx, run: RunJobs): Promise<LoopToolResult> {
    const { scope } = ctx;
    // Its place among the run's jobs is taken before anything is awaited, so the calls of one step
    // cannot pass the limit together; a call that starts nothing gives it back.
    const full = run.max !== undefined && run.started >= run.max;
    if (!full) run.started += 1;
    const part = lines(await loadGuidance(this.#core.env.files, scope).part(LINES_PART));
    if (full) return answer(part?.line("run_limit", { agent: call.agent, max: run.max, value: run.started, ...(ctx.agent.job !== undefined ? { job: true } : {}) }), true);
    const starter = ctx.agent.job === undefined ? undefined : this.#live.get(ctx.agent.job);
    let begun: Begun;
    try {
      begun = await this.#begin({ scope: { user: scope.user, chat: scope.chat, session: this.#core.ids(), ...(scope.turn !== undefined ? { turn: scope.turn } : {}) }, call, by: ctx.agent, parent: { agent: ctx.agent.id, run: ctx.run, call: ctx.callId }, ...(starter !== undefined ? { over: starter.prepared.budget } : {}) });
    } catch (error) {
      run.started -= 1;
      throw error;
    }
    if (!("view" in begun)) run.started -= 1;
    if ("content" in begun) return begun;
    if ("hit" in begun) {
      const { hit } = begun;
      // The day's tokens, or the day's count of jobs, of every job or of those on one connection.
      const line = hit.limit === "tokens" ? "day_tokens" : "day_limit";
      return answer(part?.line(line, { agent: call.agent, max: hit.max, value: hit.value, ...(hit.connection !== undefined ? { connection: hit.connection } : {}) }), true);
    }
    const { view } = begun;
    return answer(part?.line("started", { job: view.id, agent: view.agent, ...(view.state === "queued" ? { queued: true } : {}) }));
  }

  // ---------------------------------------------------------------- the Jobs page (`JobsApi`)

  async list(filter: { user: string; chat?: string; states?: JobState[] }): Promise<JobView[]> {
    const user = { user: filter.user };
    await this.#recovery(filter.user);
    await Promise.allSettled([...this.#writes.values()]);
    const { store } = this.#core.env;
    const views = new Map<string, JobView>();
    for (const key of await store.list(user, KEPT)) {
      const view = keptView(await store.get(user, key));
      if (view !== undefined) views.set(view.id, view);
    }
    for (const live of this.#live.values()) if (live.view.scope.user === filter.user) views.set(live.view.id, live.view);
    return [...views.values()].filter((view) => (filter.chat === undefined || view.scope.chat === filter.chat) && (filter.states === undefined || filter.states.includes(view.state))).map((view) => ({ ...view }));
  }

  async get(user: string, id: string): Promise<JobView | undefined> {
    await this.#recovery(user);
    const live = this.#live.get(id);
    if (live !== undefined && live.view.scope.user === user) return { ...live.view };
    await this.#writes.get(id);
    return keptView(await this.#core.env.store.get({ user }, `${KEPT}${id}`));
  }

  /** The user starts a job, tied to no turn, held to the limits it was given where they are tighter than the settings'. It rejects when none can be started; the error says why, for the host. */
  async start(scope: Scope, start: JobStart): Promise<JobView> {
    const bad = Object.entries(start.limits ?? {}).find(([, value]) => value !== undefined && !(Number.isInteger(value) && value > 0));
    if (bad !== undefined) throw new Error(`No job was started: its limit ${bad[0]} is ${String(bad[1])}, and a limit is a whole number above 0.`);
    const begun = await this.#begin({ scope: { user: scope.user, chat: scope.chat, session: this.#core.ids() }, call: { agent: start.agent, brief: start.brief, attach: start.attach ?? [] }, ...(start.limits !== undefined ? { limits: start.limits } : {}) });
    if ("view" in begun) return { ...begun.view };
    if ("hit" in begun && begun.hit.limit === "tokens") throw new Error(`No job was started: what jobs sent and wrote today counts as ${begun.hit.value} tokens, and the setting allows ${begun.hit.max}.`);
    if ("hit" in begun) throw new Error(`No job was started: ${begun.hit.value} jobs were started today${begun.hit.connection !== undefined ? ` on ${begun.hit.connection}` : ""}, and the setting allows ${begun.hit.max}.`);
    throw new Error(`No job was started: there is no agent definition named "${start.agent}", or no model for it to run on.`);
  }

  async cancel(user: string, id: string): Promise<JobView | undefined> {
    const live = this.#live.get(id);
    if (live === undefined || live.view.scope.user !== user) return this.get(user, id);
    return this.#stop(live, "cancelled");
  }

  // ---------------------------------------------------------------- the host's word

  /** The host: this turn left the path. Its jobs are cut off, waiting or running (§13.5). */
  async turnLeft(scope: Scope): Promise<void> {
    if (scope.turn === undefined) return;
    const cut = [...this.#live.values()].filter((live) => live.view.scope.user === scope.user && live.view.scope.chat === scope.chat && live.view.scope.turn === scope.turn);
    await Promise.all(cut.map((live) => this.#stop(live, "off-path")));
  }

  /** Stops every job, kept as interrupted (§13.5), and waits for what is kept and told to settle. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#recovered.values()]);
    await Promise.all([...this.#live.values()].map((live) => this.#stop(live, "interrupted")));
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  // ---------------------------------------------------------------- inside

  /**
   * Makes a job and counts it in the user's day: its view, the limit it would pass, or the answer that
   * says why none can be made. `over` is the budget of the job whose agent started it. No job is
   * started once the user's jobs have spent the day's tokens, and none such is counted among the
   * day's jobs.
   */
  async #begin(ask: Omit<JobAsk, "id" | "spent">): Promise<Begun> {
    const { scope, call, by, parent } = ask;
    const core = this.#core;
    // What a restart cut off of the user's is kept as interrupted first, so no job of this process is taken for one.
    await this.#recovery(scope.user);
    const id = core.ids();
    const spend = await this.#spend(scope.user);
    const prepared = await prepareJob({ ...core, jobs: this }, { ...ask, id, spent: spend.used });
    if (!("run" in prepared)) return prepared;
    const own = jobCountsFor(prepared.settings, prepared.connection);
    const hit = prepared.day.reached(prepared.agent) ?? (await this.#count(scope.user, prepared.settings, own));
    if (hit !== undefined) {
      prepared.trace.event(by ?? prepared.agent, parent, { kind: "limit", hit });
      return { hit };
    }
    const { promise, resolve } = Promise.withResolvers<JobView>();
    const view: JobView = { id, agent: prepared.agent.definition, brief: call.brief, state: "queued", scope, startedBy: by ?? "user", started: core.env.clock.now(), usage: emptyUsage() };
    const live: Live = {
      view,
      prepared,
      connections: own.map(({ key, counts }) => ({ key, ...(counts.atOnce !== undefined ? { atOnce: counts.atOnce } : {}) })),
      spend,
      controller: new AbortController(),
      done: promise,
      settle: resolve,
    };
    this.#live.set(id, live);
    this.#queue.push(live);
    this.#changed(live);
    this.#next();
    // As it stands once it had its chance at a place: running, or still waiting.
    return { view: live.view };
  }

  /**
   * Counts a job in the user's day, unless that passes the user's count for the day, of every job or
   * of those on its connection: then the limit it would pass. Counted in the host's store, so the
   * count holds across a restart and across jobs started at once.
   */
  async #count(user: string, settings: Settings, own: readonly ConnectionCounts[]): Promise<LimitHit | undefined> {
    const limits: { max: number; connection?: string }[] = [...(settings.jobs.perDay !== undefined ? [{ max: settings.jobs.perDay }] : []), ...own.flatMap(({ key, counts }) => (counts.perDay !== undefined ? [{ max: counts.perDay, connection: key }] : []))];
    let hit: LimitHit | undefined;
    await this.#core.env.store.update({ user }, `${DAYS}${this.#core.env.clock.day()}`, (current) => {
      const count = dayCount(current);
      for (const { max, connection } of limits) {
        const value = connection === undefined ? count.all : (count.connections[connection] ?? 0);
        if (value >= max) {
          hit = { limit: "jobs", per: "day", max, value, ...(connection !== undefined ? { connection } : {}) };
          return current;
        }
      }
      count.all += 1;
      for (const { key } of own) count.connections[key] = (count.connections[key] ?? 0) + 1;
      return { all: count.all, connections: count.connections, tokens: count.tokens };
    });
    return hit;
  }

  /**
   * What the user's jobs have spent today: read from the day's record in the store the first time
   * this process asks, so that it holds across a restart, then counted into by every call of their
   * agents as it is made. Only today's is kept here; a job started on a day gone by goes on counting
   * into that day's.
   */
  #spend(user: string): Promise<DaySpend> {
    const day = this.#core.env.clock.day();
    const at = `${day}\n${user}`;
    const known = this.#days.get(at);
    if (known !== undefined) return known;
    for (const other of this.#days.keys()) if (!other.startsWith(`${day}\n`)) this.#days.delete(other);
    const key = `${DAYS}${day}`;
    const read = this.#core.env.store.get({ user }, key).then((value): DaySpend => {
      // What was spent before this process, as it was spent: each job's day holds it to the weight of a cached token in force.
      const { tokens } = dayCount(value);
      return { key, user, used: { ...emptyUsage(), ...tokens } };
    });
    this.#days.set(at, read);
    // A read that failed is tried again by the next start.
    void read.catch(() => {
      if (this.#days.get(at) === read) this.#days.delete(at);
    });
    return read;
  }

  /** Keeps what the user's jobs have spent in a day, as counted so far, beside that day's count of jobs; once a job has ended, so that it holds across a restart. */
  #keepSpend(spend: DaySpend, job: string): void {
    const kept = this.#core.env.store.update({ user: spend.user }, spend.key, (current) => {
      const count = dayCount(current);
      return { all: count.all, connections: count.connections, tokens: { input: spend.used.input, cacheRead: spend.used.cacheRead, output: spend.used.output } };
    });
    this.#pend(kept, "What the user's jobs spent today could not be kept.", job);
  }

  /** Starts the waiting jobs that have a place: within the user's count at once, of every job of theirs and of those on each job's connection. */
  #next(): void {
    for (const live of [...this.#queue]) {
      const user = live.view.scope.user;
      const running = [...this.#live.values()].filter((other) => other.view.state === "running" && other.view.scope.user === user);
      if (running.length >= live.prepared.settings.jobs.atOnce) continue;
      const full = live.connections.some(({ key, atOnce }) => atOnce !== undefined && running.filter((other) => other.connections.some((c) => c.key === key)).length >= atOnce);
      if (full) continue;
      this.#queue.splice(this.#queue.indexOf(live), 1);
      this.#run(live);
    }
  }

  #run(live: Live): void {
    live.view = { ...live.view, state: "running" };
    this.#changed(live);
    const signal = live.controller.signal;
    void live.prepared
      .run(signal, (text) => {
        live.view = { ...live.view, report: text };
        this.#keep(live.view);
      })
      .then(
        (end) => {
          const { outcome } = end;
          const stoppedAs = signal.aborted ? (signal.reason as JobState) : undefined;
          const state: JobState = stoppedAs ?? (outcome.status === "failed" ? "failed" : outcome.status === "stopped" ? "cancelled" : "done");
          if (outcome.status === "failed") this.#core.env.log.warn("A job's agent could not go on.", { job: live.view.id, failure: outcome.failure ?? "harness", error: outcome.error ?? "" });
          const report = outcome.text.trim() !== "" ? outcome.text : live.view.report;
          this.#keepSpend(live.spend, live.view.id);
          this.#end(live, { ...live.view, state, usage: end.usage, ...(report !== undefined ? { report } : {}), ...(end.limit !== undefined && stoppedAs === undefined ? { limit: end.limit } : {}) });
        },
        (error: unknown) => {
          this.#core.env.log.error("A job failed in the harness.", { job: live.view.id, error: errorWords(error) });
          this.#keepSpend(live.spend, live.view.id);
          this.#end(live, { ...live.view, state: "failed" });
        },
      );
  }

  /** Stops a job where it stands, to end in `state`: one waiting ends at once, one running once its agents have stopped. */
  #stop(live: Live, state: JobState): Promise<JobView> {
    const waiting = this.#queue.indexOf(live);
    if (waiting >= 0) {
      this.#queue.splice(waiting, 1);
      this.#end(live, { ...live.view, state });
    } else if (!live.controller.signal.aborted) live.controller.abort(state);
    return live.done;
  }

  #end(live: Live, view: JobView): void {
    live.view = { ...view, ended: this.#core.env.clock.now() };
    this.#live.delete(view.id);
    this.#changed(live);
    live.settle({ ...live.view });
    this.#next();
  }

  /** A job's state changed: it is kept, traced in its run, and told to the host. */
  #changed(live: Live): void {
    const view = { ...live.view };
    this.#keep(view);
    live.prepared.trace.event(live.prepared.agent, undefined, { kind: "job", job: view });
    this.#tell(view);
  }

  /** Keeps the job's view under its user, after its writes before; resolves once kept, or once it could not be (logged). */
  #keep(view: JobView): Promise<unknown> {
    const { store, log } = this.#core.env;
    const write = (this.#writes.get(view.id) ?? Promise.resolve())
      .then(() => store.set(view.scope, `${KEPT}${view.id}`, view as unknown as JsonValue))
      .catch((error: unknown) => log.error("A job could not be kept.", { job: view.id, error: errorWords(error) }));
    this.#writes.set(view.id, write);
    this.#pend(write, "A job could not be kept.", view.id);
    void write.finally(() => {
      if (this.#writes.get(view.id) === write) this.#writes.delete(view.id);
    });
    return write;
  }

  /** Tells the host of the job; resolves once told, or once it could not be (logged). */
  #tell(view: JobView): Promise<unknown> {
    const told = this.#core.env.events.job?.(view.scope, view);
    return told === undefined ? Promise.resolve() : this.#pend(told, "The host could not be told of a job.", view.id);
  }

  #pend(promise: Promise<unknown>, message: string, job: string): Promise<unknown> {
    const pending = promise.catch((error: unknown) => this.#core.env.log.error(message, { job, error: errorWords(error) }));
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
    return pending;
  }

  /** The user's finding of what a restart cut off, begun at his first call; a finding that failed is begun again by his next. */
  #recovery(user: string): Promise<void> {
    const known = this.#recovered.get(user);
    if (known !== undefined) return known;
    const finding = this.#recover(user).catch((error: unknown) => {
      this.#core.env.log.error("The jobs a restart cut off could not be found.", { user, error: errorWords(error) });
      if (this.#recovered.get(user) === finding) this.#recovered.delete(user);
    });
    this.#recovered.set(user, finding);
    return finding;
  }

  /** After a restart: a job the store holds as the user's and under way was cut off by it. It is kept as interrupted, with what it had done, and told (§13.5). */
  async #recover(user: string): Promise<void> {
    const { store, clock } = this.#core.env;
    const scope = { user };
    const done: Promise<unknown>[] = [];
    for (const key of await store.list(scope, KEPT)) {
      const view = keptView(await store.get(scope, key).catch(() => undefined));
      if (view === undefined || UNDER_WAY[view.state] !== true) continue;
      const interrupted: JobView = { ...view, state: "interrupted", ended: clock.now() };
      done.push(this.#keep(interrupted), this.#tell(interrupted));
    }
    // Its own writes and words alone: other users' jobs may be running and writing meanwhile.
    await Promise.all(done);
  }
}
