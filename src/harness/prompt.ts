// The assembled prompt as pi's loop takes it (§10.2 block 2): every message the chat application
// sent, in its order and with its role, its text and pictures as they were, by data or by web
// address. Nothing in it is stripped, moved or rewritten; system messages stay where they stand, and
// the model layer keeps them there on the way out. A role no model's API places (a tool's answer)
// stays in its place as a note marked as that role's (`.prompts/role-note.md`), never relabelled.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, SystemMessage, UserMessage } from "@earendil-works/pi-ai";
import type { PromptMessage, PromptPart } from "../contract";
import type { PromptPart as GuidancePart } from "../files/api";
import { PICTURE_ADDRESS } from "../model/transcript";

/** What a message whose role no model's API places is sent as, from its role and text. */
export type RoleMark = (role: string, text: string) => string;

/** The mark `.prompts/role-note.md` gives such a message; undefined where the file is not there or is no template: its own text goes, unmarked. */
export function roleMark(part: GuidancePart | undefined): RoleMark | undefined {
  return part?.format === "template" ? (role, text) => part.render({ role, text }).text.trimEnd() : undefined;
}

/** A message's text: its content when that is a string, else its text parts joined with nothing between them (Appendix A `PromptMessage`). */
export function promptText(message: PromptMessage): string {
  return typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

export function systemMessage(text: string, at: number): SystemMessage {
  return { role: "system", content: text, timestamp: at };
}

export function userMessage(text: string, at: number): UserMessage {
  return { role: "user", content: text, timestamp: at };
}

/** An assistant message of the prompt (an earlier reply, a prefilled start), in the shape pi's loop keeps one of its model's own answers. */
export function assistantMessage(text: string, model: Model<Api>, at: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: at,
  };
}

/** A picture as pi-ai carries one: by its data, or by its web address standing as its data, which the model layer sends by that address. */
function picture(part: Extract<PromptPart, { type: "image" }>): ImageContent {
  return "url" in part ? { type: "image", data: part.url, mimeType: PICTURE_ADDRESS } : { type: "image", data: part.data, mimeType: part.mimeType };
}

/**
 * The prompt's messages for pi's loop, in order. A user's message carries every part as it came. A
 * message whose role no model's API places goes in its place as the note `mark` makes of its text,
 * with its pictures after it. A system or assistant message carries text only: a picture in one has
 * no place to go, and each such message is named, by its place in the prompt, with how many
 * pictures it held, for the host to hear.
 */
export function promptMessages(prompt: readonly PromptMessage[], model: Model<Api>, at: number, mark?: RoleMark): { messages: AgentMessage[]; pictures: { message: number; count: number }[] } {
  const pictures: { message: number; count: number }[] = [];
  const messages = prompt.map((message, index): AgentMessage => {
    const { role, content } = message;
    if (role === "user") return { role: "user", content: typeof content === "string" ? content : content.map((part) => (part.type === "text" ? { type: "text" as const, text: part.text } : picture(part))), timestamp: at };
    if (role === "tool") {
      const text = promptText(message);
      const marked = mark?.(role, text) ?? text;
      const images = typeof content === "string" ? [] : content.flatMap((part) => (part.type === "image" ? [picture(part)] : []));
      return { role: "user", content: images.length === 0 ? marked : [{ type: "text", text: marked }, ...images], timestamp: at };
    }
    const count = typeof content === "string" ? 0 : content.filter((part) => part.type === "image").length;
    if (count > 0) pictures.push({ message: index, count });
    return role === "system" ? systemMessage(promptText(message), at) : assistantMessage(promptText(message), model, at);
  });
  return { messages, pictures };
}
