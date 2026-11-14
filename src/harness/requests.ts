// What a model call was sent, kept for the floor test and the Turn page (§17.1, `trace.requests`):
// the call's messages in the order sent, each as its role and its text, in a file of the turn's
// folder beside the transcripts. The trace's `call_started` names the file and holds none of it.
//
// The file is JSON: `{"messages":[{"role":"system","text":"…"},{"role":"user","text":"…"},…]}`.
// A system message's text is its content and its sections; any other message's is its text parts,
// joined by a line break. Thinking, tool calls, a tool's declaration and pictures are not text: the
// tools are counted on `call_started` instead.
import { contentText, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import type { AgentRef } from "../contract";

/** The folder of the turn's folder the requests are kept in: the transcripts' (§5.3). */
const FOLDER = "transcripts/";

/** One message as the file keeps it. */
export interface SentMessage {
  role: Message["role"];
  text: string;
}

/** A call's messages, in order, as role and text. */
export function sentMessages(messages: readonly Message[]): SentMessage[] {
  return messages.map((message) => ({ role: message.role, text: message.role === "system" ? getSystemMessageText(message) : contentText(message.content) }));
}

/** Where one call's request is kept: `transcripts/<definition>-<handle>.call-<n>.json`, beside that agent's transcript, a name that reaches no other folder. */
export function requestPath(turn: string, agent: AgentRef, call: number): string {
  return `${turn}${FOLDER}${`${agent.definition}-${agent.id}`.replace(/[^A-Za-z0-9_-]/g, "-")}.call-${call}.json`;
}
