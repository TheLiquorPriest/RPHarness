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

/** The neighbour a slice's finder names when the chat history is next to it: `after: history` sits after a chat message, `before: history` before one. */
export const HISTORY_ANCHOR = "history";

/** One stretch of a slice's text, as its signature keeps it: the hash, the length and the first words, as many characters as the setting gave when it was made. */
interface Signed {
  h: string;
  n: number;
  a: string;
}

/** A slice's signature: each stretch of its text, in order, with `head` characters of its start (`prompt.signatureChars`). A signature keeps its own start, so it is found whatever the setting is later. */
export function signatureOf(texts: readonly string[], spans: readonly Span[], head: number): string {
  const signed: Signed[] = mergedSpans(texts, spans).map((span) => {
    const text = (texts[span.message] ?? "").slice(span.start, span.end);
    return { h: textHash(text), n: text.length, a: text.slice(0, head) };
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

/** How a slice of the map was found, what the breakdown names its text, and whether its finder's block name was wrong for it. */
export interface How {
  found: "signature" | "block" | "place";
  hint?: string;
  corrected?: true;
}

/** Where each slice of the map was found (by its place in `map.slices`), how, and the free text no slice claims. */
export interface Found {
  spans: Map<number, Span[]>;
  how: Map<number, How>;
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
  const ways = new Map<number, How["found"]>();
  const isFree = (span: Span) => regions.some((r) => r.message === span.message && r.start <= span.start && span.end <= r.end) && !claimed.some((c) => overlaps(c, span));
  const claim = (at: number, spans: Span[], way: How["found"]) => {
    found.set(at, spans);
    ways.set(at, way);
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
    claim(at, spans, "signature");
  });

  // 2. By the chat application's name for its block, where the block is in this prompt and free.
  map.slices.forEach((slice, at) => {
    if (found.has(at) || slice.find.block === undefined) return;
    const piece = pieces.find((p) => p.kind === "block" && blockName(p) === slice.find.block && isFree(p.span));
    if (piece !== undefined) claim(at, [piece.span], "block");
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
    if (only.length > 0) claim(at, only, "place");
    else if (group.length === between.length && group.every((slice, n) => between[n] !== undefined && fits(slice, between[n] as Span))) between.forEach((span, n) => claim(at + n, [span], "place"));
    at = end;
  }
  // The breakdown beside the result: the block the chat application names at the text found confirms the finder's block name, or corrects it.
  const how = new Map<number, How>();
  for (const [at, way] of ways) {
    const spans = found.get(at) ?? [];
    const piece = pieces.find((p) => p.kind === "block" && spans.some((span) => overlaps(span, p.span)));
    const hint = piece === undefined ? undefined : blockName(piece);
    const named = map.slices[at]?.find.block;
    how.set(at, { found: way, ...(hint !== undefined ? { hint } : {}), ...(hint !== undefined && hint !== named ? { corrected: true as const } : {}) });
  }
  return { spans: found, how, unclaimed: unclaimedNow() };
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
