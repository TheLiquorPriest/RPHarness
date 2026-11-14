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
