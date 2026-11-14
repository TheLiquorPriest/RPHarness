// Named facts of the moment (§5.4 "Facts"): neutral counts drawn from the host's records, which a
// rule's condition may test and the briefing's template may show. A fact takes no side: it counts,
// and the rule that names it says what matters. RPH has facts of its own (`todo.open`,
// `reply.released`, `prompt.notices`); these are the host's.

import type { Scope } from "./common";
import type { JsonValue } from "./json";

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
  /**
   * The fields its value may carry beyond its count and names, which a rule's text shows by the
   * fact's full name and the field's (`{{history.leaving.uncovered.range}}`). Absent: it has none.
   */
  fields?: string[];
}

/** A fact's value now. */
export interface FactValue {
  count: number;
  /** Who or what it counts, by name. */
  names?: string[];
  /** The count of each group of `FactDef.by`. */
  by?: Record<string, number>;
  /**
   * The names in each group of `FactDef.by`, each one among `names`, so a rule that picks groups
   * (`stage.unperceived(principal, supporting)`) can name only theirs.
   */
  namesBy?: Record<string, string[]>;
  /** The value of each field `FactDef.fields` declares. */
  fields?: Record<string, JsonValue>;
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
