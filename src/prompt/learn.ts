// A map learned from a prompt (§4.8 steps 2 and 3): the slices a mapper names, each made of parts of
// this prompt by the names `prompt` gives them, cut where a slice begins partway through a part,
// with a finder RPH writes from the slice's text as it stands. A slice the player changed on the
// Prompt page (`edited`) is kept as the player left it when the map is learned again: its text is
// taken out of the mapper's slices and stays under the player's marker, kind, line and behaviour.
import type { PromptMap, PromptSlice, SliceBehaviour, SliceKind } from "../contract";
import type { Fields } from "../files/api";
import { reserved } from "./cut";
import { HISTORY_ANCHOR, signatureOf, without } from "./locate";
import { byMarker, SLICE_KINDS, same } from "./names";
import type { Slice, TurnPrompt } from "./prompt";
import { inOrder, isBefore, mergedSpans, type Span } from "./text";

/** How a slice can behave from turn to turn. */
export const BEHAVIOURS: readonly SliceBehaviour[] = ["fixed", "scene", "turn"];

/** A slice as a mapper writes it. */
export interface WrittenSlice {
  marker: string;
  kind: SliceKind;
  line: string;
  behaviour: SliceBehaviour;
  /** The parts of this prompt it is made of, by the names `prompt` gives them. */
  parts: string[];
  /** Its first words, where it begins partway through its first part. */
  starts?: string;
}

/** Why a map was not learned: a line of the prompt map's words, and its fields. */
export interface Problem {
  line: string;
  fields: Fields;
}

/** A map learned, with the markers of the player's slices kept from the map before it; or why none was. */
export type Learned = { map: PromptMap; kept: string[] } | { problems: Problem[] };

/** Where a part named in a written slice is: its stretches of free text, or why it is not a part a slice can be made of. */
function partSpans(prompt: TurnPrompt, name: string): Span[] | "history" | "unknown" {
  const slice = byMarker(prompt.slices, name);
  if (slice !== undefined) return slice.kind === "history" || slice.from === "lore" || slice.from === "history" ? "history" : slice.spans;
  if (reserved(name)) {
    const message = /^message\[(\d+)\]$/i.exec(name.trim())?.[1];
    if (message === undefined) return "history";
    const spans = prompt.cut.pieces.filter((piece) => piece.span.message === Number(message) && (piece.kind === "block" || piece.kind === "loose")).map((piece) => piece.span);
    return spans.length > 0 ? spans : "unknown";
  }
  const piece = prompt.cut.pieces.find((p) => same(p.name, name));
  if (piece === undefined) return "unknown";
  return piece.kind === "history" || piece.kind === "lore" ? "history" : [piece.span];
}

/** What a slice of the map is given to be found again: the signature of its text, its block's name, its role, and its neighbours. */
function finderOf(prompt: TurnPrompt, spans: readonly Span[]): PromptSlice["find"] {
  const blocks = prompt.facts.layout?.blocks ?? [];
  const block = prompt.cut.pieces.find((piece) => piece.kind === "block" && spans.some((span) => span.message === piece.span.message && span.start <= piece.span.start && piece.span.end <= span.end));
  const name = block?.block === undefined ? undefined : blocks[block.block]?.name;
  const first = spans[0];
  const role = first === undefined ? undefined : prompt.cut.pieces.find((piece) => piece.span.message === first.message && piece.span.start <= first.start && first.start < piece.span.end)?.role;
  return { signature: signatureOf(prompt.texts, spans), ...(name !== undefined ? { block: name } : {}), ...(role !== undefined ? { role } : {}) };
}

/** Learns a map from the slices written for this prompt, keeping the player's own slices of the map before it. */
export function learn(prompt: TurnPrompt, written: readonly WrittenSlice[]): Learned {
  const problems: Problem[] = [];
  const preset = prompt.preset;
  if (preset === null) return { problems: [{ line: "write_no_preset", fields: {} }] };
  if (written.length === 0) return { problems: [{ line: "write_none", fields: {} }] };

  // Each slice's stretches, as its parts name them.
  const wanted = new Map<WrittenSlice, Span[]>();
  const seen = new Set<string>();
  for (const slice of written) {
    const marker = slice.marker.trim();
    if (marker === "" || reserved(marker)) problems.push({ line: "write_reserved", fields: { marker } });
    else if (seen.has(marker.toLowerCase())) problems.push({ line: "write_twice", fields: { marker } });
    seen.add(marker.toLowerCase());
    if (!SLICE_KINDS.includes(slice.kind)) problems.push({ line: "write_kind", fields: { marker, kind: slice.kind, kinds: [...SLICE_KINDS] } });
    if (!BEHAVIOURS.includes(slice.behaviour)) problems.push({ line: "write_behaviour", fields: { marker, behaviour: slice.behaviour, behaviours: [...BEHAVIOURS] } });
    const spans: Span[] = [];
    for (const part of slice.parts) {
      const found = partSpans(prompt, part);
      if (found === "unknown") problems.push({ line: "write_unknown", fields: { marker, part } });
      else if (found === "history") problems.push({ line: "write_not_part", fields: { marker, part } });
      else spans.push(...found);
    }
    if (slice.parts.length === 0) problems.push({ line: "write_no_parts", fields: { marker } });
    const ordered = inOrder(spans);
    const first = ordered[0];
    if (slice.starts !== undefined && slice.starts !== "" && first !== undefined) {
      const at = (prompt.texts[first.message] ?? "").indexOf(slice.starts, first.start);
      if (at < 0 || at + slice.starts.length > first.end) problems.push({ line: "write_starts", fields: { marker, starts: slice.starts, part: slice.parts[0] ?? "" } });
      else ordered[0] = { ...first, start: at };
    }
    wanted.set(slice, ordered);
  }
  if (problems.length > 0) return { problems };

  // Where two slices share text, the one that begins later takes its text out of the other; two that begin at the same place cannot both have it.
  const cut = new Map<WrittenSlice, Span[]>();
  for (const [slice, spans] of wanted) {
    const later: Span[] = [];
    for (const [other, theirs] of wanted) {
      if (other === slice) continue;
      for (const t of theirs)
        for (const s of spans) {
          if (t.message !== s.message || !(t.start < s.end && s.start < t.end)) continue;
          if (t.start === s.start) problems.push({ line: "write_same_start", fields: { marker: slice.marker.trim(), other: other.marker.trim() } });
          else if (t.start > s.start) later.push(t);
        }
    }
    cut.set(slice, spans.flatMap((span) => without(prompt.texts, span, later)));
  }

  // The player's own slices of the map before this one, where this prompt has them: their text is theirs.
  const before = prompt.facts.map?.slices.filter((slice) => slice.edited === true) ?? [];
  const kept: { slice: PromptSlice; spans: Span[] }[] = [];
  for (const slice of before) {
    const found: Slice | undefined = prompt.mapped ? prompt.slices.find((s) => s.from === "map" && s.marker === slice.marker) : undefined;
    kept.push({ slice, spans: found?.spans ?? [] });
  }
  const players = kept.flatMap((k) => k.spans);
  const made: { slice: PromptSlice; spans: Span[] }[] = [];
  for (const [slice, spans] of cut) {
    const own = mergedSpans(
      prompt.texts,
      spans.flatMap((span) => without(prompt.texts, span, players)),
    );
    // A slice the player's own slices cover wholly is theirs already.
    if (own.length === 0 && spans.length > 0 && players.length > 0) continue;
    const marker = slice.marker.trim();
    if (own.length === 0) problems.push({ line: "write_left_empty", fields: { marker } });
    if (kept.some((k) => same(k.slice.marker, marker))) problems.push({ line: "write_players", fields: { marker } });
    made.push({ slice: { marker, kind: slice.kind, line: slice.line, behaviour: slice.behaviour, find: {} }, spans: own });
  }
  if (problems.length > 0) return { problems };

  // In prompt order, each with its finder from the text as it stands: its neighbours are the slices beside it, or the chat history where a chat message is next to it. The player's slices this prompt does not have keep theirs.
  const placed = [...made, ...kept.filter((k) => k.spans.length > 0)].sort((a, b) => order(a.spans[0], b.spans[0]));
  const besideHistory = (span: Span | undefined, side: "after" | "before") => {
    if (span === undefined) return false;
    const piece = side === "after" ? prompt.cut.pieces.findLast((p) => isBefore(p.span, span)) : prompt.cut.pieces.find((p) => isBefore(span, p.span));
    return piece?.kind === "history";
  };
  const slices: PromptSlice[] = placed.map(({ slice, spans }, at) => {
    const after = besideHistory(spans[0], "after") ? HISTORY_ANCHOR : placed[at - 1]?.slice.marker;
    const next = besideHistory(spans.at(-1), "before") ? HISTORY_ANCHOR : placed[at + 1]?.slice.marker;
    return { ...slice, find: { ...finderOf(prompt, spans), ...(after !== undefined ? { after } : {}), ...(next !== undefined ? { before: next } : {}) } };
  });
  for (const k of kept) if (k.spans.length === 0) slices.push(k.slice);
  return { map: { format: 1, preset, slices }, kept: kept.map((k) => k.slice.marker) };
}

function order(a: Span | undefined, b: Span | undefined): number {
  return (a?.message ?? 0) - (b?.message ?? 0) || (a?.start ?? 0) - (b?.start ?? 0);
}
