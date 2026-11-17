// The pure rule check (§5.4): given a rule and what it would look at (written text, thinking or the
// reply; a tool's call; a tool's result; the facts of a moment), whether its condition holds and what
// matched, through the same pattern facility and fact test the engine uses, with no memory and no
// `repeat:`. A question rule gives the question and the text it would be asked about. The Rules
// page's "try this rule" (`rules.test`) stands on it.
import type { FactValue, JsonValue, ToolResult } from "../contract/index";
import { matchIn, resultText } from "./engine";
import { holds } from "./facts";
import type { Rule } from "./rules";

/** What a rule is checked against. */
export type Looked =
  | { watch: "text" | "thinking" | "reply"; text: string }
  | { watch: "arguments"; tool: string; args: JsonValue }
  | { watch: "result"; tool: string; result: ToolResult }
  | { facts: Readonly<Record<string, FactValue>> };

/** Whether the rule's condition holds on it, and what its pattern matched; that its pattern ran out of time; or, for a question rule, what it would ask about. */
export type Checked = { holds: boolean; matched?: string; timedOut?: true } | { question: string; text: string };

/** Checks `rule` against `looked` under the user's `rules.patternMs` and `rules.windowChars`. */
export function checkRule(rule: Rule, looked: Looked, terms: { patternTime: number; window?: number }): Checked {
  const when = rule.when;
  if (when.trigger === "always") return { holds: true };
  if (when.trigger === "moment" || when.trigger === "interval") {
    if (when.fact === undefined) return { holds: true };
    const value = "facts" in looked ? looked.facts[when.fact.name] : undefined;
    return { holds: value !== undefined && holds(when.fact, value) };
  }
  if ("facts" in looked) return { holds: false };
  const watched = when.scope.find((s) => s.watch === looked.watch && (!("tool" in s) || ("tool" in looked && s.tool.match(looked.tool))));
  if (watched === undefined) return { holds: false };
  if (when.trigger === "question") return "text" in looked ? { question: when.question, text: looked.text } : { holds: false };
  // What was written is looked at by its newest stretch, as the stream's check does; a tool's call or result in stretches over the whole.
  const run =
    "text" in looked
      ? matchIn(when.pattern, terms.window === undefined ? looked.text : looked.text.slice(-terms.window), undefined, terms.patternTime)
      : matchIn(when.pattern, "args" in looked ? (JSON.stringify(looked.args) ?? "") : resultText(looked.result), terms.window, terms.patternTime);
  if (run.timedOut === true) return { holds: false, timedOut: true };
  return run.matched === undefined ? { holds: false } : { holds: true, matched: run.matched };
}
