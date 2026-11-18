// Where sentences end in a reply's text, so a reply can be held back by whole sentences (§5.4: a
// reply that a rule which interrupts covers is released one sentence behind the model).
//
// A sentence ends after a stop mark (. ! ? …) and any closing quotes, brackets or emphasis marks
// right after it, once whitespace follows; after a full-width stop (。！？), which needs no space;
// or at a line break. The end is placed after the whitespace, so text released up to it joins
// cleanly to whatever is written next. A stop with nothing after it yet is not an end: "3." may
// still become "3.5".
const ENDS = /[.!?…]+["'”’»)\]*_]*\s+|[。！？]+["'”’」』)\]]*\s*|\n+/g;

/** Every place in `text` where a sentence ends, in order, as the index just after it. */
export function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(ENDS)) ends.push(match.index + match[0].length);
  return ends;
}

/** The last `count` whole sentences of `text`, with any sentence still in progress after them. */
export function lastSentences(text: string, count: number): string {
  if (count <= 0) return "";
  const ends = sentenceEnds(text);
  // Sentence k (from 1) starts at the end of sentence k-1; the tail starts `count` sentences back
  // from the last whole one, or at the start when there are fewer.
  const from = ends.length - count - 1;
  return from < 0 ? text : text.slice(ends[from]);
}

/**
 * How much of the head of `text` repeats the end of `shown` from the start of one of its sentences
 * (the whole of it, or its last sentences): the length to take off `text`, 0 when it repeats none.
 * A run of whitespace matches any other. Undefined while `text`, as far as it goes, may still be such
 * a repeat: more of it must come before it can be told.
 */
export function repeatOf(shown: string, text: string): number | undefined {
  let longest = 0;
  for (const start of [0, ...sentenceEnds(shown)]) {
    const said = shown.slice(start).trim();
    if (said === "") continue;
    const matched = headMatch(said, text);
    if (matched === undefined) return undefined;
    longest = Math.max(longest, matched);
  }
  return longest;
}

/** Where in `text` a head that says `said` ends (whitespace before it skipped), 0 when it does not; undefined when `text` ends while still saying it. */
function headMatch(said: string, text: string): number | undefined {
  let i = 0;
  let j = skipSpace(text, 0);
  while (i < said.length) {
    if (j >= text.length) return undefined;
    if (/\s/.test(said[i] ?? "")) {
      if (!/\s/.test(text[j] ?? "")) return 0;
      i = skipSpace(said, i);
      j = skipSpace(text, j);
      continue;
    }
    if (said[i] !== text[j]) return 0;
    i += 1;
    j += 1;
  }
  return j;
}

function skipSpace(text: string, at: number): number {
  let to = at;
  while (to < text.length && /\s/.test(text[to] ?? "")) to += 1;
  return to;
}
