// Counts model calls, tool rounds and tokens against the limits the user set (§10.11): one agent's,
// or a whole turn's or job's shared by all its agents; for a job another job's agents started, the
// starter's too; and for every job, what all of the user's jobs spent in the user's day. A turn's
// counts run across its runs (its first, a continue, a run that settles: READINGS N-22) where its
// maker hands the new run's budget what the earlier ones spent (`BudgetCount.used`, `rounds`).
// Limits are the only thing code holds an agent to: a budget says which limits are reached and how
// much room the next answer has left, and the runner holds the work to that.
import type { AgentRef, FactValue, LimitHit, Usage } from "../contract";

/** What a budget may hold to a limit: calls, answers that call tools, tokens sent, tokens written, and tokens sent and written together. */
type Counted = "calls" | "toolRounds" | "tokensIn" | "tokensOut" | "tokens";

/** What is left under each limit a budget holds, of those an agent can be told: absent, no such limit here. */
export type Left = Partial<Record<"calls" | "toolRounds" | "tokensIn" | "tokensOut", number>>;

export function emptyUsage(): Usage {
  return { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/** Adds `usage` into `into`. */
export function addUsage(into: Usage, usage: Usage): void {
  into.calls += usage.calls;
  into.input += usage.input;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
  into.output += usage.output;
  if (usage.reasoning !== undefined) into.reasoning = (into.reasoning ?? 0) + usage.reasoning;
}

/**
 * How a budget counts, where not as its own: `used` and `rounds`, counts that budgets of the same
 * spend share (a turn's later run, what its earlier runs spent and their answers that called
 * tools); `spent`, a count kept elsewhere that the budget reads as it stands and never counts into
 * (the user's spend over the last 24 hours, which the usage book counts as each call ends); and
 * `cachedWeight`, the share of a token that a token read again from a provider's cache counts as
 * against every limit on tokens sent (`limits.cachedWeight`; 1 when absent).
 */
export interface BudgetCount {
  used?: Usage;
  rounds?: number;
  spent?: () => Usage;
  cachedWeight?: number;
}

/** What the next call is asked about its answer's room. */
export interface RoomAsk {
  /** The least room an answer is given (`limits.answerFloor`): with less left under a limit, no call is made. */
  floor: number;
  /** The other bounds on the answer, each absent where there is none: the model's longest reply (or the connection's entry), the call's own, the agent's answer per call. */
  bounds: readonly (number | undefined)[];
  /**
   * The call's prompt, as estimated: its tokens, and of them those its provider will likely read
   * again from its cache (what it held of the last request). A limit on tokens sent and written
   * together counts it before the answer's room, the cached part at the weight that limit counts a
   * cached token at, so the room is what the answer can take and the call is never refused where
   * that weighting allows it. Absent: counted as nothing.
   */
  prompt?: { tokens: number; cached: number };
}

/**
 * The next answer's room: the least of every bound on it and of the tokens left under every limit on
 * what it writes (absent: nothing bounds it); or, where a limit has less than the floor left, that
 * limit, the tightest, and no call.
 */
export type Room = { room: number | undefined } | { hit: LimitHit };

export class Budget {
  readonly per: LimitHit["per"];
  readonly used: Usage;
  readonly #max: Readonly<Partial<Record<Counted, number>>>;
  /** The budget whatever is counted here counts against too, and whose limits hold here as well. */
  readonly #over: Budget | undefined;
  readonly #cachedWeight: number;
  readonly #spent: (() => Usage) | undefined;
  #rounds: number;

  /** Each limit absent is no limit. */
  constructor(per: LimitHit["per"], max: Readonly<Partial<Record<Counted, number>>>, over?: Budget, count: BudgetCount = {}) {
    this.per = per;
    this.#max = max;
    this.#over = over;
    this.used = count.used ?? emptyUsage();
    this.#rounds = count.rounds ?? 0;
    this.#spent = count.spent;
    this.#cachedWeight = count.cachedWeight ?? 1;
  }

  /** The answers that called tools counted here. */
  get rounds(): number {
    return this.#rounds;
  }

  /**
   * Every limit reached, this budget's own and those of every budget it counts against, so that no
   * limit hides another. A limit spent (tokens) comes before a count of calls or of tool rounds,
   * nearest budget first: a count is reached by the very call (or answer) that was within it, and
   * holds only the next model call (R-194), while a spent limit holds that call's tools too.
   */
  reached(agent: AgentRef): LimitHit[] {
    const hits: LimitHit[] = [];
    for (let budget: Budget | undefined = this; budget !== undefined; budget = budget.#over) hits.push(...budget.#reachedHere(agent));
    return [...hits.filter((hit) => !countLimit(hit)), ...hits.filter(countLimit)];
  }

  /** What is left under this budget's own limits on calls, tool rounds, and tokens sent and written; none where it sets none. */
  left(): Left {
    const used = this.#counted();
    const counts: [keyof Left, number][] = [
      ["calls", used.calls],
      ["toolRounds", this.#rounds],
      ["tokensIn", this.#sent(used)],
      ["tokensOut", used.output],
    ];
    const left: Left = {};
    for (const [limit, value] of counts) {
      const max = this.#max[limit];
      if (max !== undefined) left[limit] = Math.max(0, max - value);
    }
    return left;
  }

  /**
   * The room of the next call's answer (§10.11; AuHarness-R43): the least of `ask.bounds` and of the
   * tokens left under every limit on what is written, here and in every budget above (`tokensOut`,
   * and `tokens`, sent and written together, as it counts now with the call's own prompt counted in
   * at its weight). Under the floor, the tightest such limit.
   */
  room(agent: AgentRef, ask: RoomAsk): Room {
    let tightest: { left: number; hit: LimitHit } | undefined;
    for (let budget: Budget | undefined = this; budget !== undefined; budget = budget.#over) {
      const used = budget.#counted();
      const prompt = ask.prompt === undefined ? 0 : budget.#sent({ ...emptyUsage(), input: ask.prompt.tokens, cacheRead: Math.min(ask.prompt.cached, ask.prompt.tokens) });
      const written: [Counted, number, number][] = [
        ["tokensOut", used.output, 0],
        ["tokens", budget.#tokens(used), prompt],
      ];
      for (const [limit, value, coming] of written) {
        const max = budget.#max[limit];
        if (max === undefined) continue;
        const left = max - value - coming;
        if (tightest === undefined || left < tightest.left) tightest = { left, hit: budget.#hit(limit, max, value + coming, agent) };
      }
    }
    if (tightest !== undefined && tightest.left < ask.floor) return { hit: tightest.hit };
    const bounds = [...ask.bounds, tightest?.left].filter((bound): bound is number => bound !== undefined);
    return { room: bounds.length > 0 ? Math.min(...bounds) : undefined };
  }

  /** Counts a call's usage here, where this budget keeps its own count, and in every budget above. */
  count(usage: Usage): void {
    if (this.#spent === undefined) addUsage(this.used, usage);
    this.#over?.count(usage);
  }

  /** Counts an answer that called tools, here and in every budget above. */
  round(): void {
    this.#rounds += 1;
    this.#over?.round();
  }

  /** What this budget holds to its limits: its own count, or the one kept elsewhere as it stands. */
  #counted(): Usage {
    return this.#spent?.() ?? this.used;
  }

  /** This budget's own limits reached, in the order they are counted. */
  #reachedHere(agent: AgentRef): LimitHit[] {
    const used = this.#counted();
    const counts: [Counted, number][] = [
      ["calls", used.calls],
      ["toolRounds", this.#rounds],
      ["tokensIn", this.#sent(used)],
      ["tokensOut", used.output],
      ["tokens", this.#tokens(used)],
    ];
    return counts.flatMap(([limit, value]) => {
      const max = this.#max[limit];
      return max !== undefined && value >= max ? [this.#hit(limit, max, value, agent)] : [];
    });
  }

  /** Tokens sent without the cache in full, a token read again from the cache at its weight; in whole tokens. */
  #sent({ input, cacheRead }: Usage): number {
    return Math.round(input - cacheRead + cacheRead * this.#cachedWeight);
  }

  /** Tokens sent, at the cache's weight, and written; in whole tokens. */
  #tokens(used: Usage): number {
    return this.#sent(used) + used.output;
  }

  #hit(limit: Counted, max: number, value: number, agent: AgentRef): LimitHit {
    return { limit, per: this.per, max, value, ...(this.per === "agent" ? { agent } : {}) };
  }
}

/** A count of calls or of tool rounds: reached by the call (or answer) within it, it holds the next model call and not that call's tools. */
export function countLimit(hit: LimitHit): boolean {
  return hit.limit === "calls" || hit.limit === "toolRounds";
}

/**
 * The fact `limits.left` (§5.4 "Facts"): what is left to an agent under its own limits and its run's
 * (a turn's or a job's), each group the fewest left of that limit where either sets it, the count
 * the fewest of all; none where neither sets any.
 */
export function leftFact(agent: Left, run: Left): FactValue | undefined {
  const by: Record<string, number> = {};
  for (const limit of ["calls", "toolRounds", "tokensIn", "tokensOut"] as const) {
    const left = [agent[limit], run[limit]].filter((value): value is number => value !== undefined);
    if (left.length > 0) by[limit] = Math.min(...left);
  }
  const counts = Object.values(by);
  if (counts.length === 0) return undefined;
  return { count: Math.min(...counts), by, fields: { agent: { ...agent }, run: { ...run } } };
}
