// What a model call was sent, kept for the floor test and the Turn page (§17.1, `trace.requests`):
// the call's messages in the order sent, each as its role and its text, in a file of the turn's
// folder beside the transcripts. The trace's `call_started` names the file and holds none of it.
//
// The file is JSON: `{"messages":[{"role":"system","text":"…","block":"opening"},{"role":"user","text":"…"},…]}`.
// A system message's text is its content and its sections; any other message's is its text parts,
// joined by a line break. Thinking, tool calls, a tool's declaration and pictures are not text: the
// tools are counted on `call_started` instead.
//
// A message RPH placed in the request carries `block`, the block it is part of:
//   - `opening`: the agent's opening block, the leading system message (for the reply's writer,
//     which is given the prompt first, its instructions after the prompt);
//   - `frame`: the line that introduces the assembled prompt;
//   - `prompt`: each message of the assembled prompt (a writer's prefilled start among them);
//   - after the prompt, the name the lead's definition is given the block by: `session:carry`,
//     `briefing`, or a given part's own names (`file:…`, a view's name), joined by `, ` where one
//     message holds several;
//   - `brief`: a sub-agent's, a job's or the writer's brief.
// A message of the run's own conversation (what the model and its tools said, a rule's text, a
// reminder) carries no `block`. Nothing of the request itself changes for it, and the trace not at all.
import { contentText, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import type { AgentRef } from "../contract";

/** The folder of the turn's folder the transcripts and the requests are kept in (§5.3). */
export const TRANSCRIPTS = "transcripts/";

/** An agent's name in the transcripts folder, `<definition>-<handle>`, one that reaches no other folder. */
export function agentFileName(agent: AgentRef): string {
  return `${agent.definition}-${agent.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** One message as the file keeps it. */
export interface SentMessage {
  role: Message["role"];
  text: string;
  /** The block RPH placed it in (the names in this file's header); none for the run's own conversation. */
  block?: string;
}

/** Each message RPH placed in a request, by the block it is part of: the message itself, as the request carries it, names it. */
const blocks = new WeakMap<object, string>();

/** Names the block a message RPH places in a request is part of, for the kept request; gives the message. */
export function placed<M extends object>(message: M, block: string): M {
  blocks.set(message, block);
  return message;
}

/** A call's messages, in order, as role and text, each RPH placed with its block; `opening` is the agent's opening block as the runner made it. */
export function sentMessages(messages: readonly Message[], opening?: Message): SentMessage[] {
  return messages.map((message) => {
    const block = message === opening ? "opening" : blocks.get(message);
    return { role: message.role, text: message.role === "system" ? getSystemMessageText(message) : contentText(message.content), ...(block !== undefined ? { block } : {}) };
  });
}

/** Where one call's request is kept: `transcripts/<definition>-<handle>.call-<n>.json`, beside that agent's transcript. */
export function requestPath(turn: string, agent: AgentRef, call: number): string {
  return `${turn}${TRANSCRIPTS}${agentFileName(agent)}.call-${call}.json`;
}
