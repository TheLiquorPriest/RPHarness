// Named facts of the moment (§5.4 "Facts"): neutral counts drawn from the host's records, which a
// rule's condition may test and the briefing's template may show. A fact takes no side: it counts,
// and the rule that names it says what matters. RPH has facts of its own (`todo.open`,
// `reply.released`, `prompt.notices`); these are the host's.

import type { AgentRef, RunScope } from "./common";
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
   * fact's full name and the field's (`{{history.leaving.uncovered.range}}`). A dotted one says what
   * each item of a list field carries (or a field's object): `held.name` is the `name` of each item
   * of `held`, and `missing.turns.message` that of each item of the list `turns` in each item of
   * `missing`. A rule's text shows those inside a block over the list, by the item's name alone
   * (`{{#stage.untaken.held}}{{name}}{{/stage.untaken.held}}`). Absent: it has none.
   */
  fields?: string[];
}

/**
 * A fact as the Rules page lists it (`RulesApi.facts`): RPH's own or the host's. Each fact has one
 * writer: a host fact named like one of RPH's own is listed marked `clash`, and rules read RPH's.
 */
export interface ListedFact extends FactDef {
  from: "rph" | "host";
  clash?: true;
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
  /** The value of each field `FactDef.fields` declares, by its name; what a dotted one names is carried in the items of its field. */
  fields?: Record<string, JsonValue>;
}

export interface FactsPort {
  /** Every fact the host can count. The same list for the life of the host. */
  defs(): FactDef[];
  /**
   * The facts' values for this scope, by name: those named in `names`, or all of them. Every name
   * is one `defs()` declares. A scope whose `turn` is a past turn reads them as they stood at that
   * turn (C-10), so `rules.test` judges a past turn by its own facts; a fact the host cannot give as
   * of then is left out, and the rule that tests it does not fire. `agent` is the agent they are
   * read for, where there is one (a rule due for it, the lead's briefing): a fact of what an agent
   * can put right counts that agent's own (its writes, by its handle); absent, every agent's.
   */
  read(scope: RunScope, names?: string[], agent?: AgentRef): Promise<Record<string, FactValue>>;
}
