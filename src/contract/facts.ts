// Named facts of the moment (§5.4 "Facts"): neutral counts drawn from the host's records, which a
// rule's condition may test and the briefing's template may show. A fact takes no side: it counts,
// and the rule that names it says what matters. RPH has facts of its own (`todo.open`,
// `reply.released`, `prompt.notices`); these are the host's.

import type { Scope } from "./common";

/** A fact the host can count, as the Rules page lists it. */
export interface FactDef {
  /** Its name, dotted (`stage.unperceived`). Unique among the host's facts. */
  name: string;
  /** One line on what it counts, from the host's own text. */
  counts: string;
  /**
   * The groups its count breaks down into, which a rule can pick from
   * (`stage.unperceived(principal, supporting) > 0` sums those two). Absent: it has none.
   */
  by?: string[];
}

/** A fact's value now: its count, who or what it counts by name, and the count of each group of `FactDef.by`. */
export interface FactValue {
  count: number;
  names?: string[];
  by?: Record<string, number>;
}

export interface FactsPort {
  /** Every fact the host can count. The same list for the life of the host. */
  defs(): FactDef[];
  /**
   * The facts' values for this scope, by name: those named in `names`, or all of them. Every name
   * is one `defs()` declares.
   */
  read(scope: Scope, names?: string[]): Promise<Record<string, FactValue>>;
}
