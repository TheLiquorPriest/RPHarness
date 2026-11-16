// What runs spent (Appendix A `UsageApi`): calls and tokens per run and per agent, what each user's
// agents spent over the last 24 hours, which the daily caps count (§10.11; plan/CONTRACT.md
// condition 5, READINGS R-35), and how full each working agent's context is. Everything is kept in
// the host's store under the user alone, so it outlives a restart and is never another user's.
//
// Each call counts the moment it ends: it goes into the record of the user's spend at once, in
// memory and in the store, in a document per UTC hour with its time, so a cap counts exactly the last
// 24 hours and a crash loses at most the call in flight. What an agent's work spent beyond the calls
// that ended whole (a call a stop or a limit cut off) counts as its work ends. A job's calls are
// marked as a job's, so the jobs' own day cap reads the same record. Each job started is counted in
// the same documents, with its time and its connection's own counts, for the jobs' counts a day.
//
// A run's usage is counted from the trace as each agent's work ends; once the run is over it is kept
// in the store for as many of the user's runs as his setting says, the oldest going past it, so it
// can be asked for after a restart.
//
// Older day records (one per calendar day, kept before the hours were) count toward the 24 hours
// they fall in, read once, the first time this process reads the user's spend: the day's usage of
// every agent, and the day's job tokens and counts of jobs, in each of their older forms. Read, they
// leave the store.
import type { AgentRef, Clock, FilesPort, JsonObject, JsonValue, LimitHit, Log, RunUsage, Scope, StorePort, TraceRecord, Usage, UsageApi, WindowGauge } from "../contract";
import { addUsage, emptyUsage } from "../loop/budget";
import { readSettingsOf } from "./settings";
import { USAGE } from "./settings/usage";

/** One hour, the span of one stored document of spend: a stored form, not a setting. */
const HOUR_MS = 3_600_000;
/** The daily caps' window (condition 5): a day that rolls with the clock, with no time zone and no midnight. Not a setting: the caps are set per day. */
const DAY_MS = 24 * HOUR_MS;

const HOURS = "usage/hours/";
const RUNS = "usage/runs/";
/** The user's finished runs whose usage is kept, oldest first. */
const KEPT = "usage/kept";
/** The older records, one per calendar day: every agent's usage, and the jobs' counts with their tokens. */
const OLD_DAYS = "usage/days/";
const OLD_JOB_DAYS = "jobs/days/";

/** What a spend counts into: a turn's call (every agent's spend), a job's (the jobs' too), or an older day record of every agent's spend or of the jobs' tokens alone. */
type SpentIn = "turn" | "job" | "day" | "jobs";

interface Spent {
  at: number;
  in: SpentIn;
  usage: Usage;
}

/** What the user's agents spent over the last 24 hours, as it stands each time it is asked. */
export interface DaySpend {
  /** Every agent's, turns and jobs alike. */
  all(): Usage;
  /** His jobs' agents' alone. */
  jobs(): Usage;
}

interface RunBook {
  run: string;
  total: Usage;
  /** The user whose run it is. */
  user?: string;
  agents: Map<string, { agent: AgentRef; usage: Usage }>;
}

/** Jobs started, as the counts of jobs a day keep them: when, how many (one, or an older day record's count at its day's end), and how many of them on each connection's own count, by its settings key. */
interface Started {
  at: number;
  all: number;
  connections: Record<string, number>;
}

/** What would pass a count of jobs a day: the user's count of every job, or of those on a connection's own count (its settings key). */
export interface JobCount {
  max: number;
  connection?: string;
}

/** A user's day as this process holds it: every spend and job started of the last 24 hours, and the hour last written, so older hours are let go once an hour. */
interface Day {
  spends: Spent[];
  starts: Started[];
  hour?: number;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usage as the store keeps it: its counts, each 0 where it holds none. */
function storedUsage(value: JsonValue | undefined): Usage {
  const fields = isObject(value) ? value : {};
  const number = (name: string): number => {
    const n = fields[name];
    return typeof n === "number" ? n : 0;
  };
  const reasoning = fields["reasoning"];
  return { calls: number("calls"), input: number("input"), cacheRead: number("cacheRead"), cacheWrite: number("cacheWrite"), output: number("output"), ...(typeof reasoning === "number" ? { reasoning } : {}) };
}

/**
 * An older day record's tokens for `user`: one number, its tokens, counted in full; its token parts,
 * as a usage or under `tokens`; or, written before the store kept each user apart, a map by user
 * whose entry for him is one of those. A job record that holds only its counts of jobs has none.
 */
function olderTokens(value: JsonValue | undefined, user: string): Usage | undefined {
  if (typeof value === "number") return value > 0 ? { ...emptyUsage(), input: value } : undefined;
  if (!isObject(value)) return undefined;
  const tokens = value["tokens"];
  if (isObject(tokens)) return storedUsage(tokens);
  if (["calls", "input", "cacheRead", "cacheWrite", "output"].some((name) => typeof value[name] === "number")) return storedUsage(value);
  if ("all" in value || "connections" in value) return undefined;
  return Object.hasOwn(value, user) ? olderTokens(value[user], user) : undefined;
}

/** A spend as an hour's document keeps one; none where it is not one. */
function spentOf(value: JsonValue): Spent | undefined {
  if (!isObject(value) || typeof value["at"] !== "number") return undefined;
  const kept = value["in"];
  const at = value["at"];
  return kept === "turn" || kept === "job" || kept === "day" || kept === "jobs" ? { at, in: kept, usage: storedUsage(value) } : undefined;
}

function spentValue(spent: Spent): JsonObject {
  return { at: spent.at, in: spent.in, ...spent.usage };
}

/** The spends an hour's document holds. */
function hourSpends(value: JsonValue | undefined): Spent[] {
  const kept = isObject(value) ? value["spends"] : undefined;
  return Array.isArray(kept) ? kept.flatMap((item) => spentOf(item) ?? []) : [];
}

/** Counts of jobs as a start or an older day record keeps them: all of them, and those on each connection's own count; none where it holds neither. */
function countsOf(value: JsonValue | undefined): Omit<Started, "at"> | undefined {
  if (!isObject(value) || (!("all" in value) && !("connections" in value))) return undefined;
  const connections: Record<string, number> = {};
  const kept = value["connections"];
  if (isObject(kept)) for (const [key, count] of Object.entries(kept)) if (typeof count === "number") connections[key] = count;
  return { all: typeof value["all"] === "number" ? value["all"] : 0, connections };
}

/** The jobs started an hour's document holds. */
function hourStarts(value: JsonValue | undefined): Started[] {
  const kept = isObject(value) ? value["starts"] : undefined;
  if (!Array.isArray(kept)) return [];
  return kept.flatMap((item) => {
    const counts = countsOf(item);
    return isObject(item) && typeof item["at"] === "number" && counts !== undefined ? [{ at: item["at"], ...counts }] : [];
  });
}

function startedValue(started: Started): JsonObject {
  return { at: started.at, all: started.all, connections: started.connections };
}

/** The start of the UTC hour `at` falls in. */
function hourOf(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** Where the spends and job starts of the UTC hour starting at `hour` are kept: `usage/hours/2026-05-01T13`. */
function hourKey(hour: number): string {
  return `${HOURS}${new Date(hour).toISOString().slice(0, 13)}`;
}

/** The last moment of the day an older record names (`2026-05-01`), counted as UTC; none for a key that names no day. */
function dayEnd(day: string): number | undefined {
  const start = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(start) ? undefined : start + DAY_MS - 1;
}

function isAgentRef(value: JsonValue | undefined): value is JsonObject & { id: string; definition: string } {
  return isObject(value) && typeof value["id"] === "string" && typeof value["definition"] === "string";
}

/** A run's usage as the store keeps it; none where it is not one. */
function runUsageOf(value: JsonValue | undefined, run: string): RunUsage | undefined {
  if (!isObject(value) || value["run"] !== run || !Array.isArray(value["agents"])) return undefined;
  const agents = value["agents"].flatMap((item) => {
    if (!isObject(item) || !isAgentRef(item["agent"])) return [];
    const { id, definition, parent, job } = item["agent"];
    const agent: AgentRef = { id, definition, ...(typeof parent === "string" ? { parent } : {}), ...(typeof job === "string" ? { job } : {}) };
    return [{ agent, usage: storedUsage(item["usage"]) }];
  });
  return { run, total: storedUsage(value["total"]), agents };
}

function runUsage(book: RunBook): RunUsage {
  return { run: book.run, total: { ...book.total }, agents: [...book.agents.values()].map(({ agent, usage }) => ({ agent, usage: { ...usage } })) };
}

function sum(spends: readonly Spent[], counted: readonly SpentIn[]): Usage {
  const total = emptyUsage();
  for (const spent of spends) if (counted.includes(spent.in)) addUsage(total, spent.usage);
  return total;
}

function gaugeKey(scope: Scope, agent: string): string {
  return JSON.stringify([scope.user, scope.chat, scope.session, scope.turn ?? null, agent]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the usage book reaches the world through. */
export interface UsageDeps {
  store: StorePort;
  clock: Pick<Clock, "now">;
  log: Log;
  /** For the user's setting of how many finished runs' usage is kept, read at the levels every chat shares. */
  files: FilesPort;
}

export class UsageBook implements UsageApi {
  readonly #d: UsageDeps;
  readonly #runs = new Map<string, RunBook>();
  readonly #gauges = new Map<string, WindowGauge>();
  /** Each run's agents with a gauge, so the gauges go when the run ends. */
  readonly #gauged = new Map<string, string[]>();
  /** Each user's spend, read from the store the first time this process asks. */
  readonly #days = new Map<string, Promise<Day>>();
  /** What each working agent's calls that ended whole have counted, by run and agent: its work's end counts the rest. */
  readonly #ended = new Map<string, Usage>();
  /** Writes not yet kept. */
  readonly #writing = new Set<Promise<unknown>>();

  constructor(deps: UsageDeps) {
    this.#d = deps;
  }

  /** A run begins. */
  begin(run: string): void {
    this.#runs.set(run, { run, total: emptyUsage(), agents: new Map() });
  }

  /** An agent's model and the room it keeps for its answer, for its gauge while the run lasts. */
  gauge(scope: Scope, run: string, agent: string, window: number, reserve: number): void {
    const key = gaugeKey(scope, agent);
    this.#gauges.set(key, { used: 0, window, reserve });
    this.#gauged.set(run, [...(this.#gauged.get(run) ?? []), key]);
  }

  /** Every record of a run, as it happens. */
  record(record: TraceRecord): void {
    const { event, agent } = record;
    // A record of the host's word outside any agent's work (a session opened or closed by a call of the sessions API) spent nothing.
    if (agent === undefined) return;
    // A run is its user's, as its first record names him: the run and its user are the harness's, never the asker's.
    const book = this.#runs.get(record.run);
    if (book !== undefined) book.user ??= record.scope.user;
    const working = JSON.stringify([record.run, agent.id]);
    const kind: SpentIn = agent.job !== undefined ? "job" : "turn";
    if (event.kind === "agent_started") {
      this.#ended.set(working, emptyUsage());
      return;
    }
    if (event.kind === "call_ended") {
      const gauge = this.#gauges.get(gaugeKey(record.scope, agent.id));
      // What the call was sent is what the agent's context held.
      if (gauge !== undefined && event.usage.input > 0) gauge.used = event.usage.input;
      const ended = this.#ended.get(working);
      if (ended !== undefined) addUsage(ended, event.usage);
      this.#spend(record.scope.user, { at: record.at, in: kind, usage: event.usage });
      return;
    }
    if (event.kind !== "agent_ended") return;
    if (book !== undefined) {
      addUsage(book.total, event.usage);
      const entry = book.agents.get(agent.id) ?? { agent, usage: emptyUsage() };
      addUsage(entry.usage, event.usage);
      book.agents.set(agent.id, entry);
    }
    // What its work spent beyond the calls that ended whole: a call a stop or a limit cut off.
    const ended = this.#ended.get(working) ?? emptyUsage();
    this.#ended.delete(working);
    const rest: Usage = {
      calls: Math.max(0, event.usage.calls - ended.calls),
      input: Math.max(0, event.usage.input - ended.input),
      cacheRead: Math.max(0, event.usage.cacheRead - ended.cacheRead),
      cacheWrite: Math.max(0, event.usage.cacheWrite - ended.cacheWrite),
      output: Math.max(0, event.usage.output - ended.output),
    };
    if (rest.calls + rest.input + rest.cacheRead + rest.cacheWrite + rest.output > 0) this.#spend(record.scope.user, { at: record.at, in: kind, usage: rest });
  }

  /** A run ended: its usage is kept in the store, to be asked for after a restart, and its gauges go. */
  end(run: string): void {
    for (const key of this.#gauged.get(run) ?? []) this.#gauges.delete(key);
    this.#gauged.delete(run);
    const book = this.#runs.get(run);
    const user = book?.user;
    if (book === undefined || user === undefined) {
      this.#runs.delete(run);
      return;
    }
    // Asked for while it is being kept, it answers from memory.
    this.#pend(this.#keepRun(user, book).finally(() => this.#runs.delete(run)), "A run's usage could not be kept.", { run });
  }

  /** Waits for what is being kept. */
  async settled(): Promise<void> {
    while (this.#writing.size > 0) await Promise.all([...this.#writing]);
  }

  /** A run's usage, to the user whose run it is: asked with another user, it answers as for a run that is not there. */
  async run(user: string, run: string): Promise<RunUsage | undefined> {
    const book = this.#runs.get(run);
    if (book !== undefined) return book.user === user ? runUsage(book) : undefined;
    return runUsageOf(await this.#d.store.get({ user }, `${RUNS}${run}`), run);
  }

  /** What the user's agents spent over the last 24 hours. */
  async day(user: string): Promise<Usage> {
    return (await this.spend(user)).all();
  }

  /** The user's spend over the last 24 hours, as it stands each time it is asked: what the daily caps hold every turn and job to. */
  async spend(user: string): Promise<DaySpend> {
    const day = await this.#day(user);
    const window = (): Spent[] => {
      const since = this.#d.clock.now() - DAY_MS;
      if (day.spends.some((spent) => spent.at <= since)) day.spends = day.spends.filter((spent) => spent.at > since);
      return day.spends;
    };
    return { all: () => sum(window(), ["turn", "job", "day"]), jobs: () => sum(window(), ["job", "jobs"]) };
  }

  async window(scope: Scope, agent: string): Promise<WindowGauge | undefined> {
    const gauge = this.#gauges.get(gaugeKey(scope, agent));
    return gauge === undefined ? undefined : { ...gauge };
  }

  /**
   * Counts a job started in the user's day, unless one of `counts` is reached already (his count of
   * every job, or of those on a connection's own count): then the limit it would pass, and it is not
   * counted. Checked and counted with nothing awaited between, so jobs started side by side are
   * counted one after another; kept in its hour's document, so the count holds across a restart.
   */
  async countJob(user: string, counts: readonly JobCount[], connections: readonly string[]): Promise<LimitHit | undefined> {
    const day = await this.#day(user);
    const now = this.#d.clock.now();
    const since = now - DAY_MS;
    if (day.starts.some((started) => started.at <= since)) day.starts = day.starts.filter((started) => started.at > since);
    for (const { max, connection } of counts) {
      const value = day.starts.reduce((n, started) => n + (connection === undefined ? started.all : (started.connections[connection] ?? 0)), 0);
      if (value >= max) return { limit: "jobs", per: "day", max, value, ...(connection !== undefined ? { connection } : {}) };
    }
    const started: Started = { at: now, all: 1, connections: Object.fromEntries(connections.map((key) => [key, 1])) };
    day.starts.push(started);
    this.#pend(this.#keepIn(user, day, now, (doc) => ({ ...doc, starts: [...hourStarts(doc).map(startedValue), startedValue(started)] })), "A job's start could not be kept in the day's count of jobs.", { at: now });
    return undefined;
  }

  /** Counts a spend in the user's day at once and keeps it in its hour's document. */
  #spend(user: string, spent: Spent): void {
    const kept = this.#day(user).then(async (day) => {
      day.spends.push(spent);
      await this.#keepIn(user, day, spent.at, (doc) => ({ ...doc, spends: [...hourSpends(doc).map(spentValue), spentValue(spent)] }));
    });
    this.#pend(kept, "A call's usage could not be kept in the day's record.", { at: spent.at });
  }

  /** Changes the user's document of the hour `at` falls in, the rest of it kept; once an hour, lets go of the hours that hold nothing of the last 24. */
  async #keepIn(user: string, day: Day, at: number, change: (doc: JsonObject) => JsonObject): Promise<void> {
    await this.#d.store.update({ user }, hourKey(hourOf(at)), (current) => change(isObject(current) ? current : {}));
    const hour = hourOf(this.#d.clock.now());
    if (day.hour !== hour) {
      day.hour = hour;
      await this.#letGo(user);
    }
  }

  #day(user: string): Promise<Day> {
    const known = this.#days.get(user);
    if (known !== undefined) return known;
    const read = this.#readDay(user);
    this.#days.set(user, read);
    // A read that failed is tried again by the next ask.
    void read.catch(() => {
      if (this.#days.get(user) === read) this.#days.delete(user);
    });
    return read;
  }

  /** The user's spends and jobs started of the last 24 hours from the store, with his older day records read in once. */
  async #readDay(user: string): Promise<Day> {
    const { store } = this.#d;
    const now = this.#d.clock.now();
    const since = now - DAY_MS;
    await this.#readOlder(user, since);
    const hours: number[] = [];
    for (let hour = hourOf(since); hour <= now; hour += HOUR_MS) hours.push(hour);
    const docs = await Promise.all(hours.map((hour) => store.get({ user }, hourKey(hour))));
    const spends = docs.flatMap((doc) => hourSpends(doc)).filter((spent) => spent.at > since);
    const starts = docs.flatMap((doc) => hourStarts(doc)).filter((started) => started.at > since);
    await this.#letGo(user);
    return { spends, starts, hour: hourOf(now) };
  }

  /**
   * The user's older day records: each counts toward the 24 hours it falls in, at the last moment of
   * its day (now, for today's), kept in that hour's document, its usage as a spend and a job
   * record's counts of jobs as jobs started; then it leaves the store.
   */
  async #readOlder(user: string, since: number): Promise<void> {
    const { store } = this.#d;
    const now = this.#d.clock.now();
    const older: [string, SpentIn][] = [...(await store.list({ user }, OLD_DAYS)).map((key): [string, SpentIn] => [key, "day"]), ...(await store.list({ user }, OLD_JOB_DAYS)).map((key): [string, SpentIn] => [key, "jobs"])];
    for (const [key, kind] of older) {
      const value = await store.get({ user }, key);
      const end = dayEnd(key.slice(kind === "day" ? OLD_DAYS.length : OLD_JOB_DAYS.length));
      if (end !== undefined && end > since) {
        const at = Math.min(end, now);
        const usage = olderTokens(value, user);
        const counts = kind === "jobs" ? countsOf(value) : undefined;
        const spent: Spent | undefined = usage === undefined ? undefined : { at, in: kind, usage };
        const started: Started | undefined = counts === undefined || counts.all === 0 ? undefined : { at, ...counts };
        if (spent !== undefined || started !== undefined) {
          await store.update({ user }, hourKey(hourOf(at)), (current) => {
            const doc = isObject(current) ? current : {};
            return { ...doc, ...(spent !== undefined ? { spends: [...hourSpends(doc).map(spentValue), spentValue(spent)] } : {}), ...(started !== undefined ? { starts: [...hourStarts(doc).map(startedValue), startedValue(started)] } : {}) };
          });
        }
      }
      await store.delete({ user }, key);
    }
  }

  /** Lets go of the user's hours that hold nothing of the last 24. */
  async #letGo(user: string): Promise<void> {
    const since = this.#d.clock.now() - DAY_MS;
    const gone = (await this.#d.store.list({ user }, HOURS)).filter((key) => {
      const start = Date.parse(`${key.slice(HOURS.length)}:00:00Z`);
      return !Number.isNaN(start) && start + HOUR_MS <= since;
    });
    await Promise.all(gone.map((key) => this.#d.store.delete({ user }, key)));
  }

  /** Keeps a finished run's usage under its user, and lets the oldest go past the count his setting keeps. */
  async #keepRun(user: string, book: RunBook): Promise<void> {
    const { store, files, log } = this.#d;
    const settings = await readSettingsOf([USAGE] as const, { layers: () => files.layers({ user }) }, files, { user }, log);
    await store.set({ user }, `${RUNS}${book.run}`, runUsage(book) as unknown as JsonObject);
    const gone: string[] = [];
    await store.update({ user }, KEPT, (current) => {
      const kept = (Array.isArray(current) ? current : []).filter((run): run is string => typeof run === "string" && run !== book.run);
      kept.push(book.run);
      gone.push(...kept.splice(0, Math.max(0, kept.length - settings.usage.keptRuns)));
      return kept;
    });
    await Promise.all(gone.map((run) => store.delete({ user }, `${RUNS}${run}`)));
  }

  #pend(work: Promise<unknown>, message: string, fields: Record<string, JsonValue>): void {
    const kept = work.catch((error: unknown) => this.#d.log.error(message, { ...fields, error: errorText(error) }));
    this.#writing.add(kept);
    void kept.finally(() => this.#writing.delete(kept));
  }
}
