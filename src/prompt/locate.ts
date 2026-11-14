// Finding the slices of a learned map in a new prompt (§4.8 "What makes a marker evergreen"). No
// message carries its block's name, so a slice is found by what it is:
//   1. by its signature, where its text is as it was when it was mapped: the text's hash, its
//      length and its first words, looked for in the prompt's free text (text that is neither
//      chat history nor lore);
//   2. by the chat application's block name, where its breakdown (stored after the chat's last
//      reply) found a block of that name in this prompt: the hint confirms or corrects a name;
//   3. by its place between the slices found around it: the free text between them is its own
//      when it is the only slice missing there, or each takes one stretch when as many are missing
//      as there are stretches. Anything else is not found, and its text belongs to no slice.
// The finder is RPH's own; the host keeps it and never reads it.
import type { PromptMap, PromptSlice } from "../contract";
import type { Piece } from "./cut";
import { inOrder, isBefore, mergedSpans, type Span, textHash, trimmed } from "./text";

/** How many characters of a slice's text its signature keeps, to look for the text again. */
const SIGNATURE_HEAD = 64;

/** The neighbour a slice's finder names when the chat history is next to it: `after: history` sits after a chat message, `before: history` before one. */
export const HISTORY_ANCHOR = "history";

/** One stretch of a slice's text, as its signature keeps it: the hash, the length and the first words. */
interface Signed {
  h: string;
  n: number;
  a: string;
}

/** A slice's signature: each stretch of its text, in order. */
export function signatureOf(texts: readonly string[], spans: readonly Span[]): string {
  const signed: Signed[] = mergedSpans(texts, spans).map((span) => {
    const text = (texts[span.message] ?? "").slice(span.start, span.end);
    return { h: textHash(text), n: text.length, a: text.slice(0, SIGNATURE_HEAD) };
  });
  return JSON.stringify(signed);
}

function signedOf(signature: string | undefined): Signed[] | undefined {
  if (signature === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(signature);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const signed = parsed.filter((s): s is Signed => typeof s === "object" && s !== null && typeof s.h === "string" && typeof s.n === "number" && typeof s.a === "string" && s.a !== "");
    return signed.length === parsed.length ? signed : undefined;
  } catch {
    return undefined;
  }
}

/** Where each slice of the map was found (by its place in `map.slices`), and the free text no slice claims. */
export interface Found {
  spans: Map<number, Span[]>;
  /** Free text no slice claims, trimmed, in prompt order. */
  unclaimed: Span[];
}

/** The free text of the prompt: per message, stretches that run across free pieces and the blank text between them. */
function freeRegions(texts: readonly string[], pieces: readonly Piece[]): Span[] {
  const free = pieces.filter((piece) => piece.kind === "block" || piece.kind === "loose").map((piece) => piece.span);
  return mergedSpans(texts, free);
}

function overlaps(a: Span, b: Span): boolean {
  return a.message === b.message && a.start < b.end && b.start < a.end;
}

/** `span` with every stretch of `taken` cut out of it, the blank edges of what is left trimmed. */
export function without(texts: readonly string[], span: Span, taken: readonly Span[]): Span[] {
  let left: Span[] = [span];
  for (const cut of taken) {
    if (cut.message !== span.message) continue;
    left = left.flatMap((s) => (overlaps(s, cut) ? [{ ...s, end: cut.start }, { ...s, start: cut.end }].filter((part) => part.start < part.end) : [s]));
  }
  return left.flatMap((s) => trimmed(texts, s) ?? []);
}

/** Finds the map's slices in the prompt cut into `pieces`. `blockName` is the chat application's name for a block piece. */
export function locate(texts: readonly string[], pieces: readonly Piece[], map: PromptMap, blockName: (piece: Piece) => string | undefined): Found {
  const regions = freeRegions(texts, pieces);
  const claimed: Span[] = [];
  const found = new Map<number, Span[]>();
  const isFree = (span: Span) => regions.some((r) => r.message === span.message && r.start <= span.start && span.end <= r.end) && !claimed.some((c) => overlaps(c, span));
  const claim = (at: number, spans: Span[]) => {
    found.set(at, spans);
    claimed.push(...spans);
  };

  // 1. By signature: each stretch in order, the first place its first words begin where the rest of it matches.
  map.slices.forEach((slice, at) => {
    const signed = signedOf(slice.find.signature);
    if (signed === undefined) return;
    const spans: Span[] = [];
    let after: Span = { message: 0, start: -1, end: 0 };
    for (const sign of signed) {
      const hit = search(texts, regions, sign, after, isFree);
      if (hit === undefined) return;
      spans.push(hit);
      after = hit;
    }
    claim(at, spans);
  });

  // 2. By the chat application's name for its block, where the block is in this prompt and free.
  map.slices.forEach((slice, at) => {
    if (found.has(at) || slice.find.block === undefined) return;
    const piece = pieces.find((p) => p.kind === "block" && blockName(p) === slice.find.block && isFree(p.span));
    if (piece !== undefined) claim(at, [piece.span]);
  });

  // 3. By place: the free text between the slices found on either side of those still missing, on
  // the side of the chat history the slice was on when it was mapped (`after` or `before` it).
  const unclaimedNow = () => inOrder(regions.flatMap((region) => without(texts, region, claimed)));
  const fits = (slice: PromptSlice, span: Span) => {
    const previous = pieces.findLast((piece) => isBefore(piece.span, span));
    const following = pieces.find((piece) => isBefore(span, piece.span));
    return (slice.find.after !== HISTORY_ANCHOR || previous?.kind === "history") && (slice.find.before !== HISTORY_ANCHOR || following?.kind === "history");
  };
  let at = 0;
  while (at < map.slices.length) {
    if (found.has(at)) {
      at++;
      continue;
    }
    let end = at;
    while (end < map.slices.length && !found.has(end)) end++;
    const before = found.get(at - 1)?.at(-1);
    const next = found.get(end)?.[0];
    const between = unclaimedNow().filter((span) => (before === undefined || !isBefore(span, before)) && (next === undefined || isBefore(span, next)));
    const group = map.slices.slice(at, end);
    const only = group.length === 1 && group[0] !== undefined ? between.filter((span) => fits(group[0] as PromptSlice, span)) : [];
    if (only.length > 0) claim(at, only);
    else if (group.length === between.length && group.every((slice, n) => between[n] !== undefined && fits(slice, between[n] as Span))) between.forEach((span, n) => claim(at + n, [span]));
    at = end;
  }
  return { spans: found, unclaimed: unclaimedNow() };
}

/** The first free place after `after` where a stretch's first words begin and its whole text has its hash. */
function search(texts: readonly string[], regions: readonly Span[], sign: Signed, after: Span, isFree: (span: Span) => boolean): Span | undefined {
  for (const region of regions) {
    if (region.message < after.message || (region.message === after.message && region.end <= after.end && after.start >= 0)) continue;
    const text = texts[region.message] ?? "";
    let from = region.message === after.message && after.start >= 0 ? Math.max(region.start, after.end) : region.start;
    for (;;) {
      const start = text.indexOf(sign.a, from);
      if (start < 0 || start + sign.n > region.end) break;
      const span = { message: region.message, start, end: start + sign.n };
      if (isFree(span) && textHash(text.slice(span.start, span.end)) === sign.h) return span;
      from = start + 1;
    }
  }
  return undefined;
}
