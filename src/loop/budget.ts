// Counts model calls and tokens against the limits the user set (§10.11): one agent's, or a whole
// turn's or job's shared by all its agents; for a job another job's agents started, the starter's
// too; and for every job, what all of the user's jobs spent in the user's day. A turn's counts run
// across its runs (its first, a continue, a run that settles: READINGS N-22) where its maker hands
// the new run's budget what the earlier ones spent (`BudgetCount.used`). Limits are the only thing
// code holds an agent to: a budget says which limits are reached and how much room the next answer
// has left, and the runner holds the work to that.
import type { AgentRef, LimitHit, Usage } from "../contract";

/** What a budget may hold to a limit: calls, tokens sent, tokens written, and tokens sent and written together. */
type Counted = "calls" | "tokensIn" | "tokensOut" | "tokens";

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
 * How a budget counts, where not as its own: `used`, a count that budgets of the same spend share
 * (each of the user's jobs holds the day's to its own setting; a turn's later run, what its earlier
 * runs spent); and `cachedWeight`, the share of a token that a token read again from a provider's
 * cache counts as against `tokens` (1 when absent).
 */
export interface BudgetCount {
  used?: Usage;
  cachedWeight?: number;
}

/** What the next call is asked about its answer's room. */
export interface RoomAsk {
  /** The call's prompt, as estimated before it is sent: what the call spends of a limit on tokens sent and written together. */
  prompt: number;
  /** The least room an answer is given (`limits.answerFloor`): with less left under a limit, no call is made. */
  floor: number;
  /** The other bounds on the answer, each absent where there is none: the model's longest reply (or the connection's entry), the call's own, the agent's answer per call. */
  bounds: readonly (number | undefined)[];
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

  /** Each limit absent is no limit. */
  constructor(per: LimitHit["per"], max: Readonly<Partial<Record<Counted, number>>>, over?: Budget, count: BudgetCount = {}) {
    this.per = per;
    this.#max = max;
    this.#over = over;
    this.used = count.used ?? emptyUsage();
    this.#cachedWeight = count.cachedWeight ?? 1;
  }

  /**
   * Every limit reached, this budget's own and those of every budget it counts against, so that no
   * limit hides another. A limit spent (tokens) comes before a calls limit, nearest budget first: a
   * calls limit is reached by the very call that was within it, and holds only the next model call
   * (R-194), while a spent limit holds that call's tools too.
   */
  reached(agent: AgentRef): LimitHit[] {
    const hits: LimitHit[] = [];
    for (let budget: Budget | undefined = this; budget !== undefined; budget = budget.#over) hits.push(...budget.#reachedHere(agent));
    return [...hits.filter((hit) => hit.limit !== "calls"), ...hits.filter((hit) => hit.limit === "calls")];
  }

  /**
   * The room of the next call's answer (§10.11; AuHarness-R43): the least of `ask.bounds` and of the
   * tokens left under every limit on what is written, here and in every budget above (`tokensOut`;
   * and `tokens`, once the call's prompt is counted in it). Under the floor, the tightest such limit.
   */
  room(agent: AgentRef, ask: RoomAsk): Room {
    let tightest: { left: number; hit: LimitHit } | undefined;
    for (let budget: Budget | undefined = this; budget !== undefined; budget = budget.#over) {
      const written: [Counted, number][] = [
        ["tokensOut", budget.used.output],
        ["tokens", budget.#tokens() + ask.prompt],
      ];
      for (const [limit, value] of written) {
        const max = budget.#max[limit];
        if (max === undefined) continue;
        const left = max - value;
        if (tightest === undefined || left < tightest.left) tightest = { left, hit: budget.#hit(limit, max, value, agent) };
      }
    }
    if (tightest !== undefined && tightest.left < ask.floor) return { hit: tightest.hit };
    const bounds = [...ask.bounds, tightest?.left].filter((bound): bound is number => bound !== undefined);
    return { room: bounds.length > 0 ? Math.min(...bounds) : undefined };
  }

  count(usage: Usage): void {
    addUsage(this.used, usage);
    this.#over?.count(usage);
  }

  /** This budget's own limits reached, in the order they are counted. */
  #reachedHere(agent: AgentRef): LimitHit[] {
    const counts: [Counted, number][] = [
      ["calls", this.used.calls],
      ["tokensIn", this.used.input],
      ["tokensOut", this.used.output],
      ["tokens", this.#tokens()],
    ];
    return counts.flatMap(([limit, value]) => {
      const max = this.#max[limit];
      return max !== undefined && value >= max ? [this.#hit(limit, max, value, agent)] : [];
    });
  }

  /** Tokens written, and sent without the cache, in full; a token read again from the cache at its weight; in whole tokens. */
  #tokens(): number {
    const { input, cacheRead, output } = this.used;
    return Math.round(input - cacheRead + cacheRead * this.#cachedWeight + output);
  }

  #hit(limit: Counted, max: number, value: number, agent: AgentRef): LimitHit {
    return { limit, per: this.per, max, value, ...(this.per === "agent" ? { agent } : {}) };
  }
}
