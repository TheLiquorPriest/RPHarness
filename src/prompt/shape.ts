// What code does with the prompt every turn (§4.8 "What code does every turn"): it finds every
// slice, records where each one is, and compares with the turn before. What is expected to change
// is not reported (the history grew, other lore activated, a slice that changes with the scene or
// every turn changed); what is reported is a fact each: a fixed slice whose text changed, a slice
// that is gone, text that belongs to no slice, slices in another order, another preset or a new
// revision of it. Nothing is held back. It also measures how much of the prompt's front was the
// same as the turn before, and which slice broke it (§4.8 "The foundation for caching").
import type { LocatedSlices, PresetRef, PromptNotice, PromptRole, SliceBehaviour, SliceKind } from "../contract";
import type { Slice, SliceFrom, TurnPrompt } from "./prompt";
import { mergedSpans, textHash } from "./text";

/** What one turn's prompt held, as the next turn compares with it. */
export interface PromptRecord {
  preset: PresetRef | null;
  /** Each message's role, length and hash. */
  messages: { role: PromptRole; length: number; hash: string }[];
  /** Each named part in prompt order, with its text's hash, and each stretch of it with its own. */
  slices: { marker: string; kind: SliceKind; from: SliceFrom; behaviour?: SliceBehaviour; hash: string; spans: { message: number; start: number; end: number; hash: string }[] }[];
}

/** What this turn's prompt holds, to be compared with by the next. */
export function recordOf(prompt: TurnPrompt): PromptRecord {
  const preset = prompt.preset;
  return {
    preset: preset === null ? null : { id: preset.id, ...(preset.name !== undefined ? { name: preset.name } : {}), ...(preset.revision !== undefined ? { revision: preset.revision } : {}) },
    messages: prompt.texts.map((text, at) => ({ role: prompt.roles[at] ?? "system", length: text.length, hash: textHash(text) })),
    slices: prompt.slices.map((slice) => ({
      marker: slice.marker,
      kind: slice.kind,
      from: slice.from,
      ...(slice.behaviour !== undefined ? { behaviour: slice.behaviour } : {}),
      hash: textHash(prompt.text(slice)),
      spans: mergedSpans(prompt.texts, slice.spans).map((span) => ({ ...span, hash: textHash((prompt.texts[span.message] ?? "").slice(span.start, span.end)) })),
    })),
  };
}

function samePreset(a: PresetRef | null, b: PresetRef | null): boolean {
  return a?.id === b?.id && a?.revision === b?.revision;
}

/** The markers of `now` that are not in the longest run they share in order with `was`: the slices that moved. */
function moved(was: readonly string[], now: readonly string[]): string[] {
  const common = now.filter((marker) => was.includes(marker));
  const order = was.filter((marker) => common.includes(marker));
  // The longest common subsequence of the two orders; what is outside it moved.
  const table = Array.from({ length: order.length + 1 }, () => new Array<number>(common.length + 1).fill(0));
  for (let i = order.length - 1; i >= 0; i--)
    for (let j = common.length - 1; j >= 0; j--) {
      const row = table[i] ?? [];
      row[j] = order[i] === common[j] ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < order.length && j < common.length) {
    if (order[i] === common[j]) {
      kept.add(common[j] ?? "");
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return common.filter((marker) => !kept.has(marker));
}

/** The notices for this turn's prompt, compared with what the turn before held (none: with the map itself). */
export function noticesOf(prompt: TurnPrompt, before: PromptRecord | undefined): PromptNotice[] {
  const notices: PromptNotice[] = [];
  const map = prompt.facts.map;
  if (map === undefined) notices.push({ kind: "unmapped" });
  if (prompt.facts.layout?.complete === false || !prompt.cut.fits) notices.push({ kind: "incomplete" });
  const was = before?.preset ?? (map !== undefined && map.preset.id === prompt.preset?.id ? map.preset : undefined);
  if (was !== undefined && !samePreset(was, prompt.preset)) notices.push({ kind: "preset", was, now: prompt.preset });
  if (map === undefined || !prompt.mapped) return notices;

  const learned = prompt.slices.filter((slice) => slice.from === "map");
  const markers = learned.map((slice) => slice.marker);
  // The turn before's learned slices; where it had none (it was not mapped yet), the map's own.
  const earlier = before?.slices.filter((slice) => slice.from === "map") ?? [];
  const baseline = earlier.length > 0 ? earlier.map((slice) => slice.marker) : map.slices.map((slice) => slice.marker);
  for (const slice of learned) {
    if (slice.behaviour !== "fixed") continue;
    const old = earlier.find((s) => s.marker === slice.marker);
    if (old !== undefined && old.hash !== textHash(prompt.text(slice))) notices.push({ kind: "changed", marker: slice.marker });
  }
  for (const marker of baseline) if (!markers.includes(marker)) notices.push({ kind: "gone", marker });
  // Text of no slice is a notice on the turn it first appears (R-17): a stretch whose text the turn before held anywhere is no change, so a map saved with text left unclaimed brings no notice on every turn.
  const held = new Set(before?.slices.flatMap((slice) => slice.spans.map((span) => span.hash)) ?? []);
  for (const slice of prompt.slices) {
    const span = slice.spans[0];
    if (slice.from !== "unclaimed" || span === undefined) continue;
    if (held.has(textHash((prompt.texts[span.message] ?? "").slice(span.start, span.end)))) continue;
    notices.push({ kind: "unclaimed", message: span.message, start: span.start, end: span.end });
  }
  const shifted = moved(baseline, markers);
  if (shifted.length > 0) notices.push({ kind: "order", markers: shifted });
  return notices;
}

/**
 * How much of the prompt's front, in characters of its messages one after another, is the same as
 * the turn before's, and the slice where it stopped being so. With no turn before, nothing of it is
 * known to be the same, and the first slice is where that begins; when the whole prompt held,
 * `brokenBy` is absent.
 */
function frontOf(prompt: TurnPrompt, before: PromptRecord | undefined): LocatedSlices["front"] {
  const now = recordOf(prompt);
  const units = (record: PromptRecord, message: number) =>
    record.slices
      .flatMap((slice) => slice.spans.filter((span) => span.message === message).map((span) => ({ marker: slice.marker, ...span })))
      .sort((a, b) => a.start - b.start);
  const first = (from: number) => {
    for (let message = from; message < now.messages.length; message++) {
      const unit = units(now, message)[0];
      if (unit !== undefined) return unit.marker;
    }
    return undefined;
  };
  const broken = (length: number, marker: string | undefined) => (marker === undefined ? { length } : { length, brokenBy: marker });
  if (before === undefined) return broken(0, first(0));
  let offset = 0;
  for (const [message, mine] of now.messages.entries()) {
    const theirs = before.messages[message];
    if (theirs === undefined) return broken(offset, first(message));
    if (theirs.role === mine.role && theirs.hash === mine.hash) {
      offset += mine.length;
      continue;
    }
    // The message differs: what held is its slices from the start that are the same, in the same place.
    const ours = units(now, message);
    const was = units(before, message);
    let held = 0;
    let at = 0;
    while (at < ours.length) {
      const a = ours[at];
      const b = was[at];
      if (a === undefined || b === undefined || a.marker !== b.marker || a.start !== b.start || a.end !== b.end || a.hash !== b.hash) break;
      held = a.end;
      at++;
    }
    return broken(offset + held, ours[at]?.marker ?? first(message + 1));
  }
  return { length: offset };
}

/** Where RPH found each slice in this turn's prompt, the notices and the front, for the host's Turn and Prompt pages. */
export function locatedOf(prompt: TurnPrompt, before: PromptRecord | undefined): LocatedSlices {
  const named = (slice: Slice) => slice.from !== "unclaimed";
  return {
    preset: prompt.preset,
    slices: prompt.slices.filter(named).map((slice) => {
      const text = prompt.text(slice);
      const how = slice.how;
      return { marker: slice.marker, kind: slice.kind, at: slice.spans.map((span) => ({ ...span })), length: text.length, hash: textHash(text), ...(how !== undefined ? { found: how.found, ...(how.hint !== undefined ? { hint: how.hint } : {}), ...(how.corrected === true ? { corrected: true as const } : {}) } : {}) };
    }),
    unclaimed: prompt.slices.filter((slice) => !named(slice)).flatMap((slice) => slice.spans.map((span) => ({ ...span }))),
    notices: noticesOf(prompt, before),
    front: frontOf(prompt, before),
  };
}
