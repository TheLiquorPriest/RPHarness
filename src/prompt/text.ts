// The small facts every part of the prompt map works with: a message's text, a text's hash as the
// layout gives it, and the stretches of message text a part of the prompt is found at.
import { createHash } from "node:crypto";
import type { PromptMessage, TextHash } from "../contract";

/** A stretch of one message's text, as offsets in UTF-16 code units (`LocatedSlice.at`). */
export interface Span {
  message: number;
  start: number;
  end: number;
}

/** A text's hash in a prompt's layout (`TextHash`): the first 32 hex digits of the SHA-256 of its UTF-8. */
export function textHash(text: string): TextHash {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/** A message's text: its content, or its text parts joined with nothing between them (`PromptMessage`). */
export function messageText(message: PromptMessage): string {
  return typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The stretch narrowed to where its text is not blank; none when it is all blank. */
export function trimmed(texts: readonly string[], span: Span): Span | undefined {
  const text = texts[span.message] ?? "";
  let start = span.start;
  let end = span.end;
  while (start < end && /\s/.test(text[start] ?? "")) start++;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
  return start < end ? { message: span.message, start, end } : undefined;
}

/** Whether `a` lies wholly before `b` starts. */
export function isBefore(a: Span, b: Span): boolean {
  return a.message < b.message || (a.message === b.message && a.end <= b.start);
}

/** Spans in prompt order. */
export function inOrder(spans: readonly Span[]): Span[] {
  return [...spans].sort((a, b) => a.message - b.message || a.start - b.start);
}

/** The text of a part of the prompt: each span's text, a blank line between spans of different messages, and the text between spans of one message kept. */
export function spannedText(texts: readonly string[], spans: readonly Span[]): string {
  const merged = mergedSpans(texts, spans);
  return merged.map((span) => (texts[span.message] ?? "").slice(span.start, span.end)).join("\n\n");
}

/** Spans in order, those of one message with nothing but blank text between them joined into one. */
export function mergedSpans(texts: readonly string[], spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of inOrder(spans)) {
    const last = out.at(-1);
    if (last !== undefined && last.message === span.message && span.start >= last.end && (texts[span.message] ?? "").slice(last.end, span.start).trim() === "") {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    out.push({ ...span });
  }
  return out;
}
