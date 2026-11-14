// Counts model calls and tokens against the limits the user set (§10.11): one agent's, or a whole
// turn's or job's shared by all its agents; for a job another job's agents started, the starter's
// too; and for every job, what all of the user's jobs spent in the user's day. Limits are the only
// thing code holds an agent to.
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

export class Budget {
  readonly per: LimitHit["per"];
  readonly used: Usage;
  readonly #max: Readonly<Partial<Record<Counted, number>>>;
  /** The budget whatever is counted here counts against too, and whose limits hold here as well. */
  readonly #over: Budget | undefined;

  /**
   * Each limit absent is no limit. `used` is what it counts into: its own, unless it is given one
   * that budgets of the same spend share (each of the user's jobs holds the day's to its own setting).
   */
  constructor(per: LimitHit["per"], max: Readonly<Partial<Record<Counted, number>>>, over?: Budget, used: Usage = emptyUsage()) {
    this.per = per;
    this.#max = max;
    this.#over = over;
    this.used = used;
  }

  /** The limit a further call would pass, if one has been reached: this budget's own, or one it counts against. */
  reached(agent: AgentRef): LimitHit | undefined {
    const counts: [Counted, number][] = [
      ["calls", this.used.calls],
      ["tokensIn", this.used.input],
      ["tokensOut", this.used.output],
      ["tokens", this.used.input + this.used.output],
    ];
    for (const [limit, value] of counts) {
      const max = this.#max[limit];
      if (max !== undefined && value >= max) return { limit, per: this.per, max, value, ...(this.per === "agent" ? { agent } : {}) };
    }
    return this.#over?.reached(agent);
  }

  count(usage: Usage): void {
    addUsage(this.used, usage);
    this.#over?.count(usage);
  }
}
