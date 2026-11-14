// Facts a rule can test (§5.4 "Facts"): RPH's own and the host's, each a neutral count with fields;
// the small expression a rule's `fact:` line holds; and the facts laid out as a rule text's fields.

import type { FactDef, FactValue, JsonObject, JsonValue } from "../contract/index";
import type { CreateFacts, Fields, OwnFactName } from "./api";

/** RPH's own facts, as the Rules page lists them. Their values come from whoever keeps them, at each moment. */
export const OWN_FACTS: readonly (FactDef & { name: OwnFactName })[] = [
  { name: "todo.open", counts: "Items the agent's todo list holds open." },
  { name: "reply.released", counts: "Whether this turn's reply has been released: 1 once it has, 0 until then." },
  { name: "prompt.notices", counts: "Notices this turn about the prompt's shape." },
  { name: "session.turns", counts: "Turns the open session holds, the one being played among them." },
];

const OWN_NAMES: ReadonlySet<string> = new Set(OWN_FACTS.map((d) => d.name));

export const createFacts: CreateFacts = (host, own) => {
  const hostDefs = (): FactDef[] => host.defs().filter((d) => !OWN_NAMES.has(d.name));
  return {
    defs: () => [...OWN_FACTS.map((d) => ({ ...d })), ...hostDefs()],
    async read(scope, agent, names) {
      const wanted = [...new Set(names)];
      const mine = wanted.filter((n) => OWN_NAMES.has(n));
      const declared = new Set(hostDefs().map((d) => d.name));
      const theirs = wanted.filter((n) => declared.has(n));
      const empty: Record<string, FactValue | undefined> = {};
      const [ownValues, hostValues] = await Promise.all([mine.length > 0 ? own(scope, agent) : empty, theirs.length > 0 ? host.read(scope, theirs) : empty]);
      const out: Record<string, FactValue> = {};
      for (const n of mine) {
        const v = (ownValues as Record<string, FactValue | undefined>)[n];
        if (v !== undefined) out[n] = v;
      }
      for (const n of theirs) {
        const v = (hostValues as Record<string, FactValue | undefined>)[n];
        if (v !== undefined) out[n] = v;
      }
      return out;
    },
  };
};

// ---------------------------------------------------------------- `fact:`

/**
 * A rule's `fact:` (`api.ts`, `FactTest`): a fact's name, the groups of it to count, and a
 * comparison with a number, `true` (the count is not 0) or `false` (it is 0). A name alone holds
 * when its count is not 0.
 */
export interface FactTest {
  text: string;
  name: string;
  groups?: string[];
  op?: ">" | ">=" | "<" | "<=" | "==" | "!=";
  value?: number | boolean;
}

const TEST = /^([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*(?:\(([^()]*)\))?\s*(?:(>=|<=|==|!=|>|<)\s*(\S+))?$/;

/** How `fact:` is written, for a problem's words. */
export const FACT_FORM = "`fact:` is a fact's name, the groups to count in brackets if you pick some, and a comparison with a number, true or false: `stage.unperceived(principal, supporting) > 0`.";

/** A `fact:` line read: the test, or what is wrong with it. */
export function parseFactTest(text: string): FactTest | { error: string } {
  const m = TEST.exec(text.trim());
  if (m === null) return { error: `\`${text}\` cannot be read. ${FACT_FORM}` };
  const test: FactTest = { text: text.trim(), name: m[1] ?? "" };
  if (m[2] !== undefined) {
    const groups = m[2].split(",").map((g) => g.trim());
    if (groups.some((g) => g === "")) return { error: `The brackets in \`${text}\` name an empty group. ${FACT_FORM}` };
    test.groups = groups;
  }
  if (m[3] !== undefined) {
    const raw = m[4] ?? "";
    const value = raw === "true" ? true : raw === "false" ? false : Number(raw);
    if (typeof value === "number" && !Number.isFinite(value)) return { error: `\`${raw}\` in \`${text}\` is not a number, true or false. ${FACT_FORM}` };
    if (typeof value === "boolean" && m[3] !== "==" && m[3] !== "!=") return { error: `\`${text}\` compares with ${raw} by ${m[3]}; true and false take == or != only.` };
    test.op = m[3] as NonNullable<FactTest["op"]>;
    test.value = value;
  }
  return test;
}

/** The count a test looks at: the fact's, or the sum of the groups it picks. */
export function testedCount(test: FactTest, value: FactValue): number {
  return test.groups === undefined ? value.count : test.groups.reduce((sum, g) => sum + (value.by?.[g] ?? 0), 0);
}

/** Whether the fact holds. */
export function holds(test: FactTest, value: FactValue): boolean {
  const n = testedCount(test, value);
  const v = test.value;
  if (test.op === undefined || v === undefined) return n !== 0;
  if (typeof v === "boolean") return test.op === "==" ? (n !== 0) === v : (n !== 0) !== v;
  switch (test.op) {
    case ">":
      return n > v;
    case ">=":
      return n >= v;
    case "<":
      return n < v;
    case "<=":
      return n <= v;
    case "==":
      return n === v;
    case "!=":
      return n !== v;
  }
}

// ---------------------------------------------------------------- facts as fields

/**
 * The facts as a rule text's fields: each placed by its dotted name as an object whose own value
 * (".") is its count, with `names`, `by` and its declared fields. The fact a rule tests by groups
 * counts and names only those groups (names where the source gives them by group).
 */
export function factFields(values: Readonly<Record<string, FactValue>>, test?: FactTest): Fields {
  const root: JsonObject = {};
  // Shorter names first, so a fact named under another's name lands inside it.
  const names = Object.keys(values).sort((a, b) => a.split(".").length - b.split(".").length);
  for (const name of names) {
    const v = values[name];
    if (v === undefined) continue;
    const picked = test !== undefined && test.name === name ? test.groups : undefined;
    const node: JsonObject = { ...(v.fields ?? {}) };
    node["."] = picked === undefined ? v.count : testedCount({ text: "", name, groups: picked }, v);
    const named = picked !== undefined && v.namesBy !== undefined ? picked.flatMap((g) => v.namesBy?.[g] ?? []) : v.names;
    if (named !== undefined) node.names = [...named];
    if (v.by !== undefined) node.by = { ...v.by };
    let at: JsonObject = root;
    const parts = name.split(".");
    for (const part of parts.slice(0, -1)) {
      const next = at[part];
      if (typeof next === "object" && next !== null && !Array.isArray(next)) at = next;
      else {
        const made: JsonObject = next === undefined ? {} : { ".": next as JsonValue };
        at[part] = made;
        at = made;
      }
    }
    const last = parts[parts.length - 1] ?? name;
    const there = at[last];
    at[last] = typeof there === "object" && there !== null && !Array.isArray(there) ? { ...there, ...node } : node;
  }
  return root;
}

/** The facts a template's fields name: for each path, the longest leading run of its names that is a fact. */
export function factsNamed(paths: readonly string[], facts: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const path of paths) {
    const parts = path.split(".");
    for (let k = parts.length; k >= 1; k--) {
      const name = parts.slice(0, k).join(".");
      if (facts.has(name)) {
        found.add(name);
        break;
      }
    }
  }
  return [...found];
}
