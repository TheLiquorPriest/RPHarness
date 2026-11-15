// The assembled prompt as pi's loop takes it (§10.2 block 2): every message the chat application
// sent, in its order and with its role, its text and pictures as they were. Nothing in it is
// stripped, moved or rewritten; system messages stay where they stand, and the model layer keeps
// them there on the way out.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, SystemMessage, UserMessage } from "@earendil-works/pi-ai";
import type { PromptMessage } from "../contract";

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

/**
 * The prompt's messages for pi's loop, in order. A system or assistant message carries text only: a
 * picture in one has no place to go, and each such message is named, by its place in the prompt,
 * with how many pictures it held, for the host to hear.
 */
export function promptMessages(prompt: readonly PromptMessage[], model: Model<Api>, at: number): { messages: AgentMessage[]; pictures: { message: number; count: number }[] } {
  const pictures: { message: number; count: number }[] = [];
  const messages = prompt.map((message, index): AgentMessage => {
    if (message.role === "user") {
      return { role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image" as const, data: part.data, mimeType: part.mimeType })), timestamp: at };
    }
    const count = typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length;
    if (count > 0) pictures.push({ message: index, count });
    return message.role === "system" ? systemMessage(promptText(message), at) : assistantMessage(promptText(message), model, at);
  });
  return { messages, pictures };
}
