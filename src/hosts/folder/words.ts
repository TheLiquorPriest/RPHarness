// How the folder host searches by words (chat, lore): the names and words given, matched without
// regard to case, a text ranked by how many of them it holds. It has no search by meaning.

/** The words of a query: runs of letters and digits, in lower case, each once. */
export function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== ""))];
}

/** How many of the words a text holds, and where the first one held starts. */
export function match(text: string, terms: readonly string[]): { score: number; at: number; length: number } {
  const lower = text.toLowerCase();
  let score = 0;
  let at = -1;
  let length = 0;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i === -1) continue;
    score++;
    if (at === -1 || i < at) {
      at = i;
      length = term.length;
    }
  }
  return { score, at, length };
}

/** The text around a match: `radius` code units on each side of it (`search.snippetChars` in the host's config). */
export function snippetOf(text: string, at: number, length: number, radius: number): string {
  return text.slice(Math.max(0, at - radius), at + length + radius);
}
