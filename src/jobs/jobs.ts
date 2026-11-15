// Jobs (§13.5, Appendix A `JobsApi`): an agent's run that outlives the turn's reply. Nothing starts
// one but an agent's `job_start` or the user (`Harness.jobs.start`); code never does. Code holds
// jobs to the user's settings and to nothing else: how many run at once (one past it waits for a
// place), how many may be started in the user's day, the same for the jobs on one connection, how
// many the agents of one run may start, the tokens all of the user's jobs may spend in the user's
// day (none starts past it, and a running one is stopped at its next call), and what one job's run
// may spend. A job an agent of another job started spends from that job's run as well as its own, so
// that a chain of jobs never spends more than its first may. A job is tied to the turn that started
// it: the host saying that turn left the path cancels it, and a stop of the turn does not. Each change
// of a job's state, and what it spent, wrote and wrote down as it goes, is kept in the host's store
// (its typed part for job records) under its user, told to the host and traced, so a restart finds a
// job that was running and lists it as interrupted, with what it had done and spent, and a job that was
// only waiting waits again from its kept start; the day's counts of jobs and of their tokens are kept
// there too, under the user alone. RPH cannot list the users a store holds, so what a restart cut off
// is found for each user at his first call. The owner's controls are here too, each his own press and
// nothing a rule or an agent reaches: the two switches over all of his jobs (kept in the store, so a
// restart keeps them), one waiting job held, a job started again, and the answer to a job that asks. A
// job whose start named an ask point is held, not ended, once its tokens reach it: its agents wait at
// their next call, in the session they have, until he answers.
import type { DelegateCall } from "../agents/tools";
import type { JobAnswer, JobLimits, JobPage, JobQuery, JobRefusal, JobsApi, JobStart, JobState, JobSwitches, JobView, JsonValue, LimitHit, Scope, ToolCtx, Usage } from "../contract";
import { loadGuidance } from "../files";
import { lines } from "../harness/means";
import { type ConnectionCounts, jobCountsFor, type Settings } from "../harness/settings";
import { Budget, emptyUsage, type LoopToolResult } from "../loop";
import { answer } from "../tools";
import { type JobAsk, type JobCore, type PreparedJob, prepareJob } from "./run";
import type { JobCall, JobsWork, RunJobs } from "./tool";

/** The lines `job_start` answers with (`.prompts/jobs.md`). */
const LINES_PART = "jobs";

/** Where the count of each day's jobs is kept, by the user's day. */
const DAYS = "jobs/days/";

/** Where the owner's two switches over all of a user's jobs are kept, under the user. */
const SWITCHES = "jobs/switches";

/** A day, in the milliseconds the clock counts: what `jobs.keepDays` is in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The states a job is still under way in: a restart finds a running or asking one interrupted, and one that only waited (held or not) waiting again. */
const UNDER_WAY: readonly JobState[] = ["queued", "held", "running", "asking"];

/** The states a job may be started again from, by the owner or by an agent: it did not end by itself. */
const AGAIN: readonly JobState[] = ["interrupted", "failed", "cancelled"];

/** A job of this process, waiting for its place or running. */
interface Live {
  view: JobView;
  prepared: PreparedJob;
  /** The settings' keys of its connection's own counts, and their counts. */
  connections: { key: string; atOnce?: number }[];
  /** The point at which it asks the owner whether to go on, in tokens as `JobLimits.askAt` counts them; none once he answered that it asks no more. */
  askAt?: number;
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

/** What came of making a job: the job, as it stands once it had its chance at a place; the user's limit it would pass; why none may be made; or the answer that says why none could be made. */
type Begun = { view: JobView } | { hit: LimitHit } | { refusal: JobRefusal } | LoopToolResult;

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** The owner's switches as the store keeps them; a value that is none, or is not one, leaves both off. */
function switchesOf(value: JsonValue | undefined): JobSwitches {
  return { off: isObject(value) && value["off"] === true, held: isObject(value) && value["held"] === true };
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
  /** For each user this process has acted for: settles once the jobs a restart found him under way are kept as interrupted or queued again. */
  readonly #recovered = new Map<string, Promise<void>>();
  /** Every job this process made, running or ended: none is one a restart cut off, whatever a search of the store reads of it. */
  readonly #made = new Set<string>();
  /** The owner's switches over all of each user's jobs, as read from the store at his first call. */
  readonly #switches = new Map<string, JobSwitches>();

  constructor(core: Omit<JobCore, "jobs">) {
    this.#core = core;
  }

  /**
   * `job_start`: a job tied to the caller's turn, in a session of its own, counted among the jobs of
   * the caller's run (`run`), and for a caller that is a job's agent, against that job's run too; the
   * answer says what became of it, and names what its agent was not given. A call that names an
   * earlier job of the chat that was interrupted, failed or cancelled starts it again, with its
   * agent, brief, attachments and limits where the call gives none of its own: through this same
   * path, so an agent's limits hold, and never the owner's start again, which only his presses call.
   */
  async startFor(call: JobCall, ctx: ToolCtx, run: RunJobs): Promise<LoopToolResult> {
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
      const { repeats, ...delegate } = call;
      let asked: DelegateCall = delegate;
      let limits: JobLimits | undefined;
      if (repeats !== undefined) {
        const earlier = await this.get(scope.user, repeats);
        if (earlier === undefined || earlier.scope.chat !== scope.chat) {
          run.started -= 1;
          return answer(part?.line("no_job", { id: repeats }), true);
        }
        if (!AGAIN.includes(earlier.state)) {
          run.started -= 1;
          return answer(part?.line("not_again", { id: earlier.id, state: earlier.state }), true);
        }
        asked = { ...delegate, agent: delegate.agent !== "" ? delegate.agent : earlier.agent, brief: delegate.brief !== "" ? delegate.brief : earlier.brief, attach: delegate.attach.length > 0 ? delegate.attach : (earlier.attach ?? []) };
        limits = earlier.limits;
      } else if (call.agent === "" || call.brief === "") {
        run.started -= 1;
        return answer(part?.line("no_task"), true);
      }
      begun = await this.#begin({
        scope: { user: scope.user, chat: scope.chat, session: this.#core.ids(), ...(scope.turn !== undefined ? { turn: scope.turn } : {}) },
        call: asked,
        by: ctx.agent,
        parent: { agent: ctx.agent.id, run: ctx.run, call: ctx.callId },
        ...(limits !== undefined ? { limits } : {}),
        ...(repeats !== undefined ? { repeats } : {}),
        ...(starter !== undefined ? { over: starter.prepared.budget } : {}),
      });
    } catch (error) {
      run.started -= 1;
      throw error;
    }
    if (!("view" in begun)) run.started -= 1;
    if ("content" in begun) return begun;
    if ("refusal" in begun) return answer(part?.line("off", { agent: call.agent }), true);
    if ("hit" in begun) {
      const { hit } = begun;
      // The day's tokens, or the day's count of jobs, of every job or of those on one connection.
      const line = hit.limit === "tokens" ? "day_tokens" : "day_limit";
      return answer(part?.line(line, { agent: call.agent, max: hit.max, value: hit.value, ...(hit.connection !== undefined ? { connection: hit.connection } : {}) }), true);
    }
    const { view } = begun;
    const started = answer(part?.line("started", { job: view.id, agent: view.agent, ...(view.state === "queued" ? { queued: true } : {}) }));
    // Each name nobody could find is one line after the answer, as `delegate` reports one.
    const reports = (view.missing ?? []).flatMap((ref) => {
      const line = part?.line("missing", { agent: view.agent, ref });
      return line === undefined ? [] : [line];
    });
    return reports.length > 0 ? { ...started, reports } : started;
  }

  /** `job_list`: the jobs of the caller's chat, the latest started first, one line each, at most `most` of them. */
  async listFor(ctx: ToolCtx, most: number): Promise<LoopToolResult> {
    const { scope } = ctx;
    const part = lines(await loadGuidance(this.#core.env.files, scope).part(LINES_PART));
    const page = await this.list({ user: scope.user, chat: scope.chat, limit: most });
    if (page.jobs.length === 0) return answer(part?.line("none"));
    const rows = page.jobs.flatMap((job) => {
      const line = part?.line("listed", { id: job.id, agent: job.agent, state: job.state, brief: (job.brief.split("\n")[0] ?? "").trim(), ...(job.repeats !== undefined ? { repeats: job.repeats } : {}) });
      return line === undefined ? [] : [line];
    });
    const more = page.next === undefined ? undefined : part?.line("more", { count: page.jobs.length });
    const text = [...rows, ...(more === undefined ? [] : [more])].join("\n");
    return answer(text === "" ? undefined : text);
  }

  /** `job_read`: one job of the caller's chat, its brief and its report whole. */
  async readFor(ctx: ToolCtx, id: string): Promise<LoopToolResult> {
    const { scope } = ctx;
    const part = lines(await loadGuidance(this.#core.env.files, scope).part(LINES_PART));
    const job = await this.get(scope.user, id);
    if (job === undefined || job.scope.chat !== scope.chat) return answer(part?.line("no_job", { id }), true);
    const report = job.report !== undefined && job.report.trim() !== "" ? part?.line("report", { report: job.report }) : part?.line("no_report");
    const rows = [
      part?.line("read", { id: job.id, agent: job.agent, state: job.state, ...(job.repeats !== undefined ? { repeats: job.repeats } : {}), ...(job.limit !== undefined ? { limit: job.limit.limit } : {}) }),
      part?.line("brief", { brief: job.brief }),
      ...(job.missing ?? []).map((ref) => part?.line("missing", { agent: job.agent, ref })),
      report,
    ].flatMap((line) => (line === undefined ? [] : [line]));
    return answer(rows.length === 0 ? undefined : rows.join("\n"));
  }

  /**
   * `job_cancel`: stops a job of the caller's chat that an agent started. One the player started is
   * his to stop, and one that has ended is told so; neither is touched.
   */
  async cancelFor(ctx: ToolCtx, id: string): Promise<LoopToolResult> {
    const { scope } = ctx;
    const part = lines(await loadGuidance(this.#core.env.files, scope).part(LINES_PART));
    const job = await this.get(scope.user, id);
    if (job === undefined || job.scope.chat !== scope.chat) return answer(part?.line("no_job", { id }), true);
    if (job.startedBy === "user") return answer(part?.line("not_yours", { id }), true);
    const live = this.#live.get(id);
    if (live === undefined || live.view.scope.user !== scope.user) return answer(part?.line("cancel_ended", { id, state: job.state }));
    const ended = await this.#stop(live, "cancelled");
    return answer(part?.line(ended.state === "cancelled" ? "cancelled" : "cancel_ended", { id, state: ended.state }));
  }

  // ---------------------------------------------------------------- the Jobs page (`JobsApi`)

  async list(filter: { user: string } & JobQuery): Promise<JobPage> {
    const { user, ...query } = filter;
    await this.#recovery(user);
    await Promise.allSettled([...this.#writes.values()]);
    // Only the page is read from the store; a job of this process is shown as it stands now.
    const page = await this.#core.env.store.jobs.list({ user }, query);
    const jobs = page.jobs.map((view) => {
      const live = this.#live.get(view.id);
      return { ...(live !== undefined && live.view.scope.user === user ? live.view : view) };
    });
    return { jobs, ...(page.next !== undefined ? { next: page.next } : {}) };
  }

  async get(user: string, id: string): Promise<JobView | undefined> {
    await this.#recovery(user);
    const live = this.#live.get(id);
    if (live !== undefined && live.view.scope.user === user) return { ...live.view };
    await this.#writes.get(id);
    return this.#core.env.store.jobs.get({ user }, id);
  }

  /** The owner's two switches over all of the user's jobs. */
  async switches(user: string): Promise<JobSwitches> {
    await this.#recovery(user);
    return { ...this.#switchesOf(user) };
  }

  /** The user starts a job, tied to no turn. The limits of his start stand in place of the settings' for it. The job, or why none could be started. */
  async start(scope: Scope, start: JobStart): Promise<JobView | JobRefusal> {
    const bad = Object.entries(start.limits ?? {}).find(([, value]) => value !== undefined && !(Number.isInteger(value) && value > 0));
    if (bad !== undefined) return { refused: "limit", limit: bad[0] as keyof JobLimits, value: bad[1] as number };
    const begun = await this.#begin({ scope: { user: scope.user, chat: scope.chat, session: this.#core.ids() }, call: { agent: start.agent, brief: start.brief, attach: start.attach ?? [] }, ...(start.limits !== undefined ? { limits: start.limits } : {}) });
    return this.#started(begun, start.agent);
  }

  /** The job a start made, or why it made none. */
  #started(begun: Begun, agent: string): JobView | JobRefusal {
    if ("view" in begun) return { ...begun.view };
    if ("refusal" in begun) return begun.refusal;
    if ("hit" in begun) {
      const { hit } = begun;
      if (hit.limit === "tokens") return { refused: "day-tokens", max: hit.max, value: hit.value };
      return { refused: "day-count", max: hit.max, value: hit.value, ...(hit.connection !== undefined ? { connection: hit.connection } : {}) };
    }
    return { refused: "agent", agent };
  }

  async cancel(user: string, id: string): Promise<JobView | undefined> {
    const live = this.#live.get(id);
    if (live === undefined || live.view.scope.user !== user) return this.get(user, id);
    return this.#stop(live, "cancelled");
  }

  // ---------------------------------------------------------------- the owner's controls

  /** Sets either switch, or both, as the user's own press; kept in the store, so a restart keeps them. A running job is held or let go at its next call; a waiting one starts only while neither is on. */
  async setSwitches(user: string, change: Partial<JobSwitches>): Promise<JobSwitches> {
    await this.#recovery(user);
    const now: JobSwitches = { ...this.#switchesOf(user), ...(change.off !== undefined ? { off: change.off } : {}), ...(change.held !== undefined ? { held: change.held } : {}) };
    await this.#core.env.store.set({ user }, SWITCHES, { off: now.off, held: now.held });
    this.#switches.set(user, now);
    const { holds } = this.#core.hub;
    for (const live of this.#live.values()) {
      const { id, scope, state } = live.view;
      if (scope.user !== user || (state !== "running" && state !== "asking")) continue;
      if (now.held) holds.add(id, "all");
      else holds.drop(id, "all");
    }
    this.#next();
    return { ...now };
  }

  /** Holds a job that waits for a place: it keeps its place, and starts only once it is let go. */
  async hold(user: string, id: string): Promise<JobView | JobRefusal> {
    const live = await this.#control(user, id, ["queued"]);
    if ("refused" in live) return live;
    live.view = { ...live.view, state: "held" };
    this.#changed(live);
    return { ...live.view };
  }

  /** Lets a held job that waits go on waiting: it starts when a place is free. */
  async letGo(user: string, id: string): Promise<JobView | JobRefusal> {
    const live = await this.#control(user, id, ["held"]);
    if ("refused" in live) return live;
    live.view = { ...live.view, state: "queued" };
    this.#changed(live);
    this.#next();
    return { ...live.view };
  }

  /** Starts an interrupted, failed or cancelled job again, as a new job with its agent, brief, attachments and limits, that names the one it repeats. */
  async again(user: string, id: string): Promise<JobView | JobRefusal> {
    const old = await this.get(user, id);
    if (old === undefined) return { refused: "no-job", id };
    if (!AGAIN.includes(old.state)) return { refused: "state", id, state: old.state, applies: [...AGAIN] };
    const begun = await this.#begin({ scope: { user, chat: old.scope.chat, session: this.#core.ids() }, call: { agent: old.agent, brief: old.brief, attach: old.attach ?? [] }, ...(old.limits !== undefined ? { limits: old.limits } : {}), repeats: id });
    return this.#started(begun, old.agent);
  }

  /** The owner's answer to a job that asks: it goes on in the session it has, with the point it asks at next if he names one, or it ends with what it has. */
  async answer(user: string, id: string, word: JobAnswer): Promise<JobView | JobRefusal> {
    const live = await this.#control(user, id, ["asking"]);
    if ("refused" in live) return live;
    if (word.go === "end") return this.#stop(live, "done");
    const at = word.askAt;
    if (at !== undefined && !(Number.isInteger(at) && at > 0)) return { refused: "limit", limit: "askAt", value: at };
    const { asks: _asked, limits, ...rest } = live.view;
    const { askAt: _point, ...kept } = limits ?? {};
    const next: JobLimits = { ...kept, ...(at !== undefined ? { askAt: at } : {}) };
    if (at === undefined) delete live.askAt;
    else live.askAt = at;
    live.view = { ...rest, state: "running", ...(Object.keys(next).length > 0 ? { limits: next } : {}) };
    this.#core.hub.holds.drop(id, "asking");
    this.#changed(live);
    return { ...live.view };
  }

  /** The user's job of this process in one of the states a control applies to, or why there is none. */
  async #control(user: string, id: string, applies: JobState[]): Promise<Live | JobRefusal> {
    await this.#recovery(user);
    const live = this.#live.get(id);
    if (live !== undefined && live.view.scope.user === user) return applies.includes(live.view.state) ? live : { refused: "state", id, state: live.view.state, applies };
    const view = await this.get(user, id);
    return view === undefined ? { refused: "no-job", id } : { refused: "state", id, state: view.state, applies };
  }

  // ---------------------------------------------------------------- the host's word

  /** The host: this turn left the path. Its jobs are cut off, waiting or running (§13.5). */
  async turnLeft(scope: Scope): Promise<void> {
    if (scope.turn === undefined) return;
    const cut = [...this.#live.values()].filter((live) => live.view.scope.user === scope.user && live.view.scope.chat === scope.chat && live.view.scope.turn === scope.turn);
    await Promise.all(cut.map((live) => this.#stop(live, "off-path")));
  }

  /**
   * Stops every running job, kept as interrupted (§13.5), and waits for what is kept and told to settle.
   * A job that was only waiting is let go as it is kept, queued: the next start of the harness queues it again.
   */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#recovered.values()]);
    await Promise.all(
      [...this.#live.values()].map((live) => {
        const waiting = this.#queue.indexOf(live);
        if (waiting < 0) return this.#stop(live, "interrupted");
        this.#queue.splice(waiting, 1);
        this.#live.delete(live.view.id);
        live.settle({ ...live.view });
        return live.done;
      }),
    );
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  // ---------------------------------------------------------------- inside

  /**
   * Makes a job and counts it in the user's day: its view, the limit it would pass, or the answer that
   * says why none can be made. `over` is the budget of the job whose agent started it. No job is
   * started once the user's jobs have spent the day's tokens, and none such is counted among the
   * day's jobs. The user's job records older than `jobs.keepDays` are removed as a job starts.
   */
  async #begin(ask: Omit<JobAsk, "id" | "spent"> & { repeats?: string }): Promise<Begun> {
    const { scope, call, by, parent } = ask;
    const core = this.#core;
    // What a restart cut off of the user's is kept as interrupted first, so no job of this process is taken for one.
    await this.#recovery(scope.user);
    // Jobs switched off by the owner: none may start, by an agent or by him.
    if (this.#switchesOf(scope.user).off) return { refusal: { refused: "off" } };
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
    await this.#prune(scope.user, prepared.settings);
    const view: JobView = {
      id,
      agent: prepared.agent.definition,
      brief: call.brief,
      state: "queued",
      scope,
      startedBy: by ?? "user",
      started: core.env.clock.now(),
      usage: emptyUsage(),
      // Its start is kept with it: a job that waits can wait again after a restart, and be started again with the same task.
      ...(call.attach.length > 0 ? { attach: [...call.attach] } : {}),
      ...(ask.limits !== undefined ? { limits: ask.limits } : {}),
      ...(ask.repeats !== undefined ? { repeats: ask.repeats } : {}),
      ...(prepared.missing.length > 0 ? { missing: prepared.missing } : {}),
    };
    // As it stands once it had its chance at a place: running, or still waiting.
    return { view: this.#enqueue(view, prepared, own, spend).view };
  }

  /** Puts a job of this process in the queue for a place, kept, traced and told as queued, and gives the places that are free. */
  #enqueue(view: JobView, prepared: PreparedJob, own: readonly ConnectionCounts[], spend: DaySpend): Live {
    const { promise, resolve } = Promise.withResolvers<JobView>();
    const live: Live = {
      view,
      prepared,
      connections: own.map(({ key, counts }) => ({ key, ...(counts.atOnce !== undefined ? { atOnce: counts.atOnce } : {}) })),
      ...(view.limits?.askAt !== undefined ? { askAt: view.limits.askAt } : {}),
      spend,
      controller: new AbortController(),
      done: promise,
      settle: resolve,
    };
    this.#made.add(view.id);
    this.#live.set(view.id, live);
    this.#queue.push(live);
    this.#changed(live);
    this.#next();
    return live;
  }

  /** Removes the user's job records started before `jobs.keepDays` days ago; a failure is logged and the start goes on. */
  async #prune(user: string, settings: Settings): Promise<void> {
    const { store, clock, log } = this.#core.env;
    try {
      await store.jobs.prune({ user }, clock.now() - settings.jobs.keepDays * DAY_MS);
    } catch (error) {
      log.error("The jobs kept longer than the setting allows could not be removed.", { user, error: errorWords(error) });
    }
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
      // Held by the owner, or his jobs switched off or held: it keeps its place and waits.
      const switches = this.#switchesOf(user);
      if (live.view.state === "held" || switches.off || switches.held) continue;
      const running = [...this.#live.values()].filter((other) => (other.view.state === "running" || other.view.state === "asking") && other.view.scope.user === user);
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
    // What the run tells as it goes is kept as it comes, so a record found after a crash shows what the job said, wrote and spent.
    const kept = (change: Partial<JobView>): void => {
      live.view = { ...live.view, ...change };
      this.#keep(live.view);
    };
    void live.prepared
      .run(signal, {
        text: (text) => kept({ report: text }),
        spent: (usage) => {
          kept({ usage });
          this.#asks(live, usage);
        },
        wrote: (write) => kept({ wrote: [...(live.view.wrote ?? []), write] }),
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

  /**
   * A call of the job ended and it has spent what its start named as the point to ask at: it is held,
   * not ended, its agents wait at their next call, and the owner is told the point and the count. He
   * answers with `answer`.
   */
  #asks(live: Live, usage: Usage): void {
    const { askAt } = live;
    if (askAt === undefined || live.view.state !== "running") return;
    const reached = new Budget("job", { tokens: askAt }, undefined, { used: usage, cachedWeight: live.prepared.settings.jobs.cachedWeight }).reached(live.prepared.agent);
    if (reached === undefined) return;
    live.view = { ...live.view, state: "asking", asks: { at: askAt, tokens: reached.value } };
    this.#core.hub.holds.add(live.view.id, "asking");
    this.#changed(live);
  }

  /** The user's switches as this process knows them: off where they were never set. */
  #switchesOf(user: string): JobSwitches {
    return this.#switches.get(user) ?? { off: false, held: false };
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
    // A job that ended no longer asks.
    const { asks: _asked, ...rest } = view;
    live.view = { ...rest, ended: this.#core.env.clock.now() };
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
      .then(() => store.jobs.set(view.scope, view))
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

  /**
   * After a restart: a job the store holds as the user's and running was cut off by it. It is kept as
   * interrupted, with what it had done and spent, and told (§13.5). One that was only waiting waits
   * again, from its kept start, and is told as queued. A job this process made is passed over, so a
   * search run again after a failed one marks only the jobs a restart truly cut off; so is a record in
   * the user's store that names another user, which is neither kept nor told (it is logged).
   */
  async #recover(user: string): Promise<void> {
    const { store, clock, log } = this.#core.env;
    const done: Promise<unknown>[] = [];
    // The owner's switches first, so a job queued again meets them: held or switched off, it keeps waiting.
    this.#switches.set(user, switchesOf(await store.get({ user }, SWITCHES)));
    const found = await store.jobs.list({ user }, { states: [...UNDER_WAY] });
    // The oldest first, so the jobs that waited are queued again in the order they were started.
    for (const view of [...found.jobs].reverse()) {
      if (this.#made.has(view.id)) continue;
      if (view.scope.user !== user) {
        log.warn("A kept job names another user than the one whose store holds it, and is passed over.", { job: view.id, user, names: view.scope.user });
        continue;
      }
      if ((view.state === "queued" || view.state === "held") && (await this.#again(view))) continue;
      const { asks: _asked, ...cut } = view;
      const interrupted: JobView = { ...cut, state: "interrupted", ended: clock.now() };
      done.push(this.#keep(interrupted), this.#tell(interrupted));
    }
    // Its own writes and words alone: other users' jobs may be running and writing meanwhile.
    await Promise.all(done);
  }

  /** A job that was waiting when the process stopped waits again, from its kept start; false when it cannot be made again (logged), and it is then kept as interrupted. */
  async #again(view: JobView): Promise<boolean> {
    const { log } = this.#core.env;
    try {
      const spend = await this.#spend(view.scope.user);
      const prepared = await prepareJob({ ...this.#core, jobs: this }, { id: view.id, scope: view.scope, call: { agent: view.agent, brief: view.brief, attach: view.attach ?? [] }, ...(view.startedBy !== "user" ? { by: view.startedBy } : {}), spent: spend.used, ...(view.limits !== undefined ? { limits: view.limits } : {}) });
      if (!("run" in prepared)) {
        log.warn("A job that was waiting could not be queued again.", { job: view.id, agent: view.agent });
        return false;
      }
      this.#enqueue(view, prepared, jobCountsFor(prepared.settings, prepared.connection), spend);
      return true;
    } catch (error) {
      log.error("A job that was waiting could not be queued again.", { job: view.id, error: errorWords(error) });
      return false;
    }
  }
}
