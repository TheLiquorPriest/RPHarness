// How a search orders the tools it covers (§6.8: plain and stable). `Rank` is the whole of it, so
// another can take its place.
//
// The plain one: the words asked are cut into terms (runs of letters and digits, in lower case),
// and so are each tool's name, family and description. For each term a tool scores 3 when a part of
// its name starts with the term, else 2 when a part of its family does, else 1 when a word of its
// description does; that score is divided by the number of tools the term scores for, so a term
// most tools share counts for little. A tool whose whole name is one of the words asked comes
// first; then the higher total; then the name, in code-point order, so the same words over the same
// tools always give the same list. A tool no term scores is not found.
import type { ReachableTool } from "./reach";

/** Orders the tools a search covers for the words asked, leaving out those the words do not find. */
export type Rank = (tools: readonly ReachableTool[], words: string) => ReachableTool[];

/** What a part of a tool's name, its family and a word of its description are each worth to a term that starts them. */
const NAME = 3;
const FAMILY = 2;
const DESCRIPTION = 1;

/** Runs of letters and digits, in lower case. */
function cut(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function worth(term: string, name: readonly string[], family: readonly string[], description: readonly string[]): number {
  if (name.some((part) => part.startsWith(term))) return NAME;
  if (family.some((part) => part.startsWith(term))) return FAMILY;
  if (description.some((word) => word.startsWith(term))) return DESCRIPTION;
  return 0;
}

export const plainRank: Rank = (tools, words) => {
  const terms = [...new Set(cut(words))];
  const whole = new Set(words.toLowerCase().split(/[\s,;]+/));
  const scored = tools.map((tool) => {
    const name = cut(tool.name);
    const family = cut(tool.family);
    const description = cut(tool.description);
    return { tool, exact: whole.has(tool.name.toLowerCase()), each: terms.map((term) => worth(term, name, family, description)) };
  });
  const sharing = terms.map((_, at) => scored.filter((s) => (s.each[at] ?? 0) > 0).length);
  return scored
    .map((s) => ({ ...s, total: s.each.reduce((sum, worth, at) => (worth > 0 ? sum + worth / (sharing[at] ?? 1) : sum), 0) }))
    .filter((s) => s.exact || s.total > 0)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.total - a.total || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
    .map((s) => s.tool);
};
