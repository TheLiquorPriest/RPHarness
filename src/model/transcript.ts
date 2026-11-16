// A call's transcript with every system message kept where it stands (STANDALONE-PLAN §10.2, "Keeps
// the order"). A prompt a chat application assembled has system messages at its start, in its
// middle (a note at depth) and at its end (an instruction after the history), and each one goes to
// the model in its place.
//
// pi-ai doesn't do this by itself: on an API whose model it doesn't mark as taking system messages
// mid-conversation, it folds every later system message into the leading one, at the top
// (`collapseSystemMessages`); and where Anthropic's API takes them it holds each one back until just
// before the next answer, past any user message that followed it. So:
//
// - The leading run of system messages (what an agent is told first, then the prompt's own leading
//   ones) becomes one system prompt, their texts in order, as pi-ai joins them.
// - On OpenAI's two APIs, and any other but Anthropic's whose model takes them, every later system
//   message stays a system message where it stands (call.ts marks OpenAI's models so).
// - Elsewhere each later one is a user message where it stands, as a chat application's Anthropic
//   provider sends one. What it holds besides its text (sections, tool changes) stays a system
//   message, which pi-ai folds into the system prompt as it always does.

import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { contentText, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { isRecord } from "../contract/json";

/** Whether a model's compatibility flags say `name`: they differ in shape by API, so they are read as a record. */
export function compatSays(model: Model<Api>, name: string): boolean {
  const compat: unknown = model.compat;
  return isRecord(compat) && compat[name] === true;
}

/** Whether a call to `model` sends a later system message in its place as a system message (see the head of this file). */
export function keepsSystemInPlace(model: Model<Api>): boolean {
  if (model.api === "openai-completions" || model.api === "openai-responses") return true;
  if (model.api === "anthropic-messages") return false;
  return compatSays(model, "supportsMidConvoSystemMessages");
}

/** A call's messages with each system message kept where it stands (see the head of this file); `mark` makes the text a later one is sent as a user's message with, where it gives one. */
export function inPlace(messages: readonly Message[], systemInPlace: boolean, mark?: (text: string) => string): Message[] {
  let lead = 0;
  while (messages[lead]?.role === "system") lead += 1;
  const head = lead > 1 ? getCurrentSystemMessage(messages.slice(0, lead)) : undefined;
  const out: Message[] = head !== undefined ? [head] : messages.slice(0, lead);
  for (const m of messages.slice(lead)) {
    if (m.role !== "system" || systemInPlace) {
      out.push(m);
      continue;
    }
    const text = contentText(m.content);
    if (text !== "") out.push({ role: "user", content: mark?.(text) ?? text, timestamp: m.timestamp });
    const { sections, toolsAdded, toolsRemoved } = m;
    if (sections !== undefined || toolsAdded !== undefined || toolsRemoved !== undefined) out.push({ ...m, content: "" });
  }
  return out;
}

/**
 * A call's messages with each tool answer that holds no text given words for it (texts.ts): one with
 * nothing in it `empty`'s, one of pictures alone `pictures`' before them, each by the tool's name. So
 * pi-ai's own "(no tool output)" and "(see attached image)" never stand in for them. Where no words
 * are given for the case, the answer goes as it is.
 */
export function answered(messages: readonly Message[], empty: ((tool: string) => string) | undefined, pictures: ((tool: string) => string) | undefined): Message[] {
  return messages.map((m) => {
    if (m.role !== "toolResult" || m.content.some((part) => part.type === "text" && part.text !== "")) return m;
    const images = m.content.filter((part) => part.type === "image");
    const words = images.length === 0 ? empty?.(m.toolName) : pictures?.(m.toolName);
    return words === undefined ? m : { ...m, content: [{ type: "text" as const, text: words }, ...images] };
  });
}

/**
 * The type a picture given by its web address goes to pi-ai under, its address standing as its data:
 * pi-ai carries a picture by its data alone, and `addressed` puts the address back in the request.
 */
export const PICTURE_ADDRESS = "x-rph/address";
const ADDRESS_DATA = `data:${PICTURE_ADDRESS};base64,`;

/** Whether a call's messages hold a picture given by its web address. */
export function holdsAddress(messages: readonly Message[]): boolean {
  return messages.some((m) => (m.role === "user" || m.role === "toolResult") && Array.isArray(m.content) && m.content.some((part) => part.type === "image" && part.mimeType === PICTURE_ADDRESS));
}

/**
 * The request pi-ai built, each picture given by its web address sent by that address as its API
 * takes one: a data address (OpenAI's two APIs, Mistral's) becomes the address itself, Anthropic's
 * base64 source its `url` source, Gemini's inline data its file data by address. Changed in place.
 */
export function addressed(value: unknown): unknown {
  if (typeof value === "string") return value.startsWith(ADDRESS_DATA) ? value.slice(ADDRESS_DATA.length) : value;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) value[i] = addressed(item);
    return value;
  }
  if (!isRecord(value)) return value;
  if (value.type === "base64" && value.media_type === PICTURE_ADDRESS && typeof value.data === "string") return { type: "url", url: value.data };
  const inline = value.inlineData;
  if (isRecord(inline) && inline.mimeType === PICTURE_ADDRESS && typeof inline.data === "string") {
    const { inlineData: _, ...rest } = value;
    return { ...rest, fileData: { fileUri: inline.data } };
  }
  for (const [key, item] of Object.entries(value)) value[key] = addressed(item);
  return value;
}
