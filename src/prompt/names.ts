// The one way a name of the prompt becomes its text (§4.8 "Tools and names"), used alike by the
// `prompt` tool, by what `delegate` attaches (`prompt:persona`) and by what a definition's `given:`
// names. A name is:
//   *                     the whole prompt, in order, each message with its role
//   layout                the raw layout: each message and the pieces it was cut into
//   kind(style)           every slice of that kind, in order
//   history               every chat message in the prompt; history[-30:] the last thirty of them;
//                         history[#120..#130] those of the chat's messages 120 to 130 it holds
//   lore[e-112]           a lore entry that activated for this prompt, as the reader may read it
//   message[3]            the fourth message, whole
//   anything else         a slice by its marker, or a piece of the raw layout by its name
// A name the prompt does not have finds nothing. Lore goes through the host's lore, which leaves out
// what a character the reader plays may not know (§9.4).
import type { AgentRef, LoreEntry, PromptRole, SliceKind } from "../contract";
import type { Piece } from "./cut";
import type { Slice, TurnPrompt } from "./prompt";

/** One thing a name found, in the order it is laid out. */
export type Item =
  /** The head of a message: in the whole prompt and the raw layout. */
  | { type: "message"; index: number; role: PromptRole; length: number; images?: number }
  /** A slice, or the part of it in one message; its text exactly as it stands in the prompt. */
  | { type: "slice"; slice: Slice; text: string }
  /** A lore entry, as the reader may read it. */
  | { type: "entry"; entry: LoreEntry }
  /** A piece of the raw layout: a free piece (a block of the breakdown, a loose stretch) with its whole text (§4.8 L363), history and lore by name and length alone. */
  | { type: "piece"; piece: Piece; length: number; block?: { name: string; type: string }; text?: string };

/** The kinds a slice can have (§4.8 "Kinds"). */
export const SLICE_KINDS: readonly SliceKind[] = ["instructions", "style", "character", "persona", "world", "note", "lore", "history", "other"];

const KIND = /^kind\(\s*([a-z]+)\s*\)$/i;
const HISTORY = /^history(?:\[(.*)\])?$/i;
const LAST = /^-(\d+):$/;
const BETWEEN = /^#(\d+)\s*\.\.\s*#(\d+)$/;
const ONE = /^#(\d+)$/;
const LORE = /^lore\[\s*(.+?)\s*\]$/i;
const MESSAGE = /^message\[(\d+)\]$/i;

/** The prompt's text for a name, as items; none when the prompt has nothing of that name. */
export async function findName(prompt: TurnPrompt, name: string, reader: AgentRef): Promise<Item[] | undefined> {
  const wanted = name.trim();
  const found = await find(prompt, wanted, reader);
  return found === undefined || found.length === 0 ? undefined : found;
}

/** A `prompt:` name as `delegate` and a definition's `given:` write it: the name after `prompt:`, or undefined for any other. */
export function promptName(ref: string): string | undefined {
  return ref.startsWith("prompt:") ? ref.slice("prompt:".length) : undefined;
}

async function find(prompt: TurnPrompt, name: string, reader: AgentRef): Promise<Item[] | undefined> {
  // `*(as sent, …)`: what follows the star is a note for whoever reads the definition.
  if (name.startsWith("*")) return whole(prompt);
  if (name.toLowerCase() === "layout") return layout(prompt);
  const kind = KIND.exec(name)?.[1]?.toLowerCase();
  if (kind !== undefined) {
    if (!(SLICE_KINDS as readonly string[]).includes(kind)) return undefined;
    // Lore that activated is given entry by entry, as the reader may read it; a slice of kind lore the preset itself holds is given as it stands.
    const own = prompt.slices.filter((slice) => slice.kind === kind && slice.from !== "lore").map((slice) => sliceItem(prompt, slice));
    return kind === "lore" ? [...own, ...(await entries(prompt, prompt.facts.activated.map((entry) => entry.id), reader))] : own;
  }
  const history = HISTORY.exec(name);
  if (history !== null) return historyItems(prompt, history[1]?.trim());
  const lore = LORE.exec(name)?.[1];
  if (lore !== undefined) return prompt.facts.activated.some((entry) => entry.id === lore) ? entries(prompt, [lore], reader) : undefined;
  const marked = byMarker(prompt.slices, name);
  if (marked !== undefined) return [sliceItem(prompt, marked)];
  const message = MESSAGE.exec(name)?.[1];
  if (message !== undefined) {
    const index = Number(message);
    const text = prompt.texts[index];
    if (text === undefined || text.trim() === "") return undefined;
    const slice: Slice = { marker: `message[${index}]`, kind: "other", spans: [{ message: index, start: 0, end: text.length }], role: prompt.roles[index] ?? "system", from: "place" };
    return [{ type: "slice", slice, text }];
  }
  // A piece of the raw layout by its name, where a learned map names it otherwise.
  const piece = prompt.cut.pieces.find((p) => same(p.name, name));
  if (piece === undefined) return undefined;
  const slice: Slice = { marker: piece.name, kind: "other", spans: [piece.span], role: piece.role, from: piece.kind === "block" ? "block" : "place" };
  return [sliceItem(prompt, slice)];
}

/** Whether two names are the same name: case and the space around them aside. */
export function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The slice a marker names, where one does. */
export function byMarker(slices: readonly Slice[], marker: string): Slice | undefined {
  return slices.find((slice) => same(slice.marker, marker));
}

function sliceItem(prompt: TurnPrompt, slice: Slice): Item {
  return { type: "slice", slice, text: prompt.text(slice) };
}

/** Every message in order, its head and then each slice's part in it. */
function whole(prompt: TurnPrompt): Item[] {
  const items: Item[] = [];
  prompt.texts.forEach((text, index) => {
    items.push({ type: "message", index, role: prompt.roles[index] ?? "system", length: text.length, ...images(prompt, index) });
    for (const slice of prompt.slices)
      for (const span of slice.spans) if (span.message === index) items.push({ type: "slice", slice, text: text.slice(span.start, span.end) });
  });
  return items;
}

function images(prompt: TurnPrompt, index: number): { images?: number } {
  const count = prompt.facts.layout?.messages[index]?.images;
  return count !== undefined && count > 0 ? { images: count } : {};
}

/** Each message's head, then the pieces the raw layout cut it into: each free piece with its text whole, so a mapper maps the prompt from it in one call; history and lore, addressed by message and entry and never mapped, by name and length. */
function layout(prompt: TurnPrompt): Item[] {
  const items: Item[] = [];
  prompt.texts.forEach((text, index) => {
    items.push({ type: "message", index, role: prompt.roles[index] ?? "system", length: text.length, ...images(prompt, index) });
    for (const piece of prompt.cut.pieces) {
      if (piece.span.message !== index) continue;
      const block = piece.block === undefined ? undefined : prompt.facts.layout?.blocks[piece.block];
      const free = piece.kind === "block" || piece.kind === "loose";
      items.push({ type: "piece", piece, length: piece.span.end - piece.span.start, ...(block !== undefined ? { block: { name: block.name, type: block.type } } : {}), ...(free ? { text: text.slice(piece.span.start, piece.span.end) } : {}) });
    }
  });
  return items;
}

/** The chat messages in the prompt a history name asks for: all, the last few, one, or those in a stretch of the chat. */
function historyItems(prompt: TurnPrompt, range: string | undefined): Item[] | undefined {
  const messages = prompt.slices.filter((slice) => slice.kind === "history" && slice.source !== undefined);
  let chosen: Slice[];
  if (range === undefined) chosen = messages;
  else {
    const last = LAST.exec(range)?.[1];
    const between = BETWEEN.exec(range);
    const one = ONE.exec(range)?.[1];
    if (last !== undefined) chosen = Number(last) === 0 ? [] : messages.slice(-Number(last));
    else if (between?.[1] !== undefined && between[2] !== undefined) {
      const from = Number(between[1]);
      const to = Number(between[2]);
      chosen = messages.filter((slice) => (slice.source?.index ?? -1) >= from && (slice.source?.index ?? -1) <= to);
    } else if (one !== undefined) chosen = messages.filter((slice) => slice.source?.index === Number(one));
    else return undefined;
  }
  return chosen.map((slice) => sliceItem(prompt, slice));
}

/** Entries that activated for this prompt, in the order named, as the reader may read them. */
async function entries(prompt: TurnPrompt, ids: readonly string[], reader: AgentRef): Promise<Item[]> {
  if (ids.length === 0) return [];
  const { env, scope } = prompt.sources;
  const read = await env.lore.read(scope, [...ids], reader);
  const byId = new Map(read.map((entry) => [entry.id, entry]));
  return ids.flatMap((id) => {
    const entry = byId.get(id);
    return entry === undefined ? [] : [{ type: "entry" as const, entry }];
  });
}
