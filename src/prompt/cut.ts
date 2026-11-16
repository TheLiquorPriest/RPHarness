// The prompt cut into pieces by its raw layout alone (§4.8: "Until a map has been learned, the raw
// layout serves as one"). Each chat history message is a piece, addressed by the message; each
// lore part is one; each block the chat application's breakdown found is one, under the block's
// name; and the rest of the text is named by its place: `message[3]` for the whole of the fourth
// message, `message[3].2` for the second such piece in it. Blank text between pieces belongs to
// none. Nothing here judges what a piece is.
import type { PromptRole, RawLayout } from "../contract";
import { type Span, textHash, trimmed } from "./text";

/** How the raw layout knows a piece: a chat history message, a lore part, a block of the breakdown, or text it says nothing more of. */
export type PieceKind = "history" | "lore" | "block" | "loose";

export interface Piece {
  /** Its name until a map names it: the block's name, a history message's `history[#12]`, or its place. */
  name: string;
  kind: PieceKind;
  span: Span;
  /** The role of the message the interceptor saw it in. */
  role: PromptRole;
  /** For a block: its place in `RawLayout.blocks`. */
  block?: number;
  /** For a history message: the chat message, by id and place on the path. */
  source?: { id: string; index: number };
  /** For a history message: a summary the chat application put in place of messages (`RawPart.summarized`). */
  summarized?: true;
}

/** The prompt as its raw layout cuts it. */
export interface Cut {
  /** Every piece, in prompt order. */
  pieces: Piece[];
  /** Whether the layout is of this prompt: one entry per message, each of the length and hash of its text. A layout that is not names every message by its place alone. */
  fits: boolean;
}

/** Names that the `prompt` tool reads in a name of its own (`*`, `layout`, `history`): a piece never takes one. */
const RESERVED = /^(\*|layout|history(\[.*\])?|lore\[.*\]|kind\(.*\)|message\[.*\].*)$/i;

/** Whether a name is one the `prompt` tool gives a meaning of its own. */
export function reserved(name: string): boolean {
  return RESERVED.test(name.trim());
}

/**
 * Names the pieces that are known by their place: within each message, one alone in it is
 * `message[i]`, and each of several (or one beside pieces named otherwise) is `message[i].n`,
 * counted from 1 in order.
 */
export function namePlaces<T extends { span: Span; name: string }>(placed: readonly T[], othersIn: (message: number) => number): void {
  const byMessage = new Map<number, T[]>();
  for (const item of placed) {
    const list = byMessage.get(item.span.message) ?? [];
    list.push(item);
    byMessage.set(item.span.message, list);
  }
  for (const [message, list] of byMessage) {
    list.sort((a, b) => a.span.start - b.span.start);
    const alone = list.length === 1 && othersIn(message) === 0;
    list.forEach((item, at) => {
      item.name = alone ? `message[${message}]` : `message[${message}].${at + 1}`;
    });
  }
}

/** Gives each name once: a second of the same name (or one the tool reads itself) is `name (2)`, and so on. */
function uniqueNames<T extends { name: string }>(items: readonly T[]): void {
  const taken = new Set<string>();
  for (const item of items) {
    let name = item.name;
    for (let n = 2; taken.has(name.toLowerCase()) || reserved(name); n++) name = `${item.name} (${n})`;
    taken.add(name.toLowerCase());
    item.name = name;
  }
}

/** Whether the layout is of this prompt. */
function fitsPrompt(layout: RawLayout, texts: readonly string[]): boolean {
  if (layout.messages.length !== texts.length) return false;
  return layout.messages.every((message, at) => {
    const text = texts[at] ?? "";
    return message.length === text.length && message.hash === textHash(text) && message.parts.every((part) => part.start >= 0 && part.start <= part.end && part.end <= text.length);
  });
}

/** Cuts the prompt by its layout. `layout` undefined: the host gave none, and every message is named by its place. */
export function cut(texts: readonly string[], roles: readonly PromptRole[], layout: RawLayout | undefined): Cut {
  const fits = layout !== undefined && fitsPrompt(layout, texts);
  const named: Piece[] = [];
  const placed: Piece[] = [];
  const loose = (span: Span, role: PromptRole, kind: "loose" | "lore" = "loose") => {
    const kept = trimmed(texts, span);
    if (kept !== undefined) placed.push({ name: "", kind, span: kept, role });
  };
  if (!fits) {
    texts.forEach((text, message) => loose({ message, start: 0, end: text.length }, roles[message] ?? "system"));
  } else {
    layout.messages.forEach((raw, message) => {
      for (const part of raw.parts) {
        const span = { message, start: part.start, end: part.end };
        if (part.kind === "history" && part.source !== undefined) {
          named.push({ name: `history[#${part.source.index}]`, kind: "history", span, role: part.role, source: { id: part.source.id, index: part.source.index }, ...(part.summarized === true ? { summarized: true as const } : {}) });
          continue;
        }
        if (part.kind === "lore") {
          loose(span, part.role, "lore");
          continue;
        }
        // The blocks found in it, in order, each once; text outside them is known by its place.
        let at = part.start;
        const blocks = [...part.blocks].filter((b) => layout.blocks[b.block] !== undefined && b.start >= part.start && b.end <= part.end && b.start < b.end).sort((a, b) => a.start - b.start);
        for (const found of blocks) {
          if (found.start < at) continue;
          loose({ message, start: at, end: found.start }, part.role);
          named.push({ name: layout.blocks[found.block]?.name ?? "", kind: "block", span: { message, start: found.start, end: found.end }, role: part.role, block: found.block });
          at = found.end;
        }
        loose({ message, start: at, end: part.end }, part.role);
      }
    });
  }
  const counts = new Map<number, number>();
  for (const piece of named) counts.set(piece.span.message, (counts.get(piece.span.message) ?? 0) + 1);
  namePlaces(placed, (message) => counts.get(message) ?? 0);
  const pieces = [...named, ...placed].sort((a, b) => a.span.message - b.span.message || a.span.start - b.span.start);
  uniqueNames(pieces.filter((piece) => piece.kind === "block"));
  return { pieces, fits };
}
