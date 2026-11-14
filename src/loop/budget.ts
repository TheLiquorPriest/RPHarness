// Counts model calls and tokens against the limits the user set (§10.11): one agent's, or a whole
// turn's or job's shared by all its agents, and for a job another job's agents started, the starter's
// too. Limits are the only thing code holds an agent to.
import type { AgentRef, LimitHit, Usage } from "../contract";

type Counted = "calls" | "tokensIn" | "tokensOut";

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
  readonly used: Usage = emptyUsage();
  readonly #max: Readonly<Partial<Record<Counted, number>>>;
  /** The budget whatever is counted here counts against too, and whose limits hold here as well. */
  readonly #over: Budget | undefined;

  /** Each limit absent is no limit. */
  constructor(per: LimitHit["per"], max: Readonly<Partial<Record<Counted, number>>>, over?: Budget) {
    this.per = per;
    this.#max = max;
    this.#over = over;
  }

  /** The limit a further call would pass, if one has been reached: this budget's own, or one it counts against. */
  reached(agent: AgentRef): LimitHit | undefined {
    const counts: [Counted, number][] = [
      ["calls", this.used.calls],
      ["tokensIn", this.used.input],
      ["tokensOut", this.used.output],
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
