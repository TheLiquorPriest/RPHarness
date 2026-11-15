// What a model call was sent, kept for the floor test and the Turn page (§5.3 l.495, §17.1 l.1764,
// `trace.requests`): the call's messages in the order sent, each as its role and its text, in a file
// of the turn's folder beside the transcripts, as pointers into the turn's own files wherever a
// message's text is in one, so the folder holds no second copy of the prompt; and rebuilt exactly
// from them. The trace's `call_started` names the file and holds none of it.
//
// The file is JSON: `{"sent":"<sha256>","messages":[…],"tools":[…]}`. Each message is
// `{"role","block"?,"text"}` for text that is in no file of the turn's folder (the opening block, a
// frame, the run's own work), or `{"role","block"?,"from":{"file","at","length"}}`: the text that
// many characters long at that place of that file of the turn's folder (`assembled-preset-prompt.md`
// and the other views, `briefing.md`). `sent` is the SHA-256 of the messages as sent (the JSON of
// their roles, texts and blocks), so a rebuild that differs says so. `tools` names each tool the call
// declared with the file its description came from (none for a host's tool).
//
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
import { createHash } from "node:crypto";
import { contentText, getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import type { AgentRef, FilesPort, KeptMessage, RebuiltRequest, Scope } from "../contract";

/** The folder of the turn's folder the transcripts and the requests are kept in (§5.3). */
export const TRANSCRIPTS = "transcripts/";

/** An agent's name in the transcripts folder, `<definition>-<handle>`, one that reaches no other folder. */
export function agentFileName(agent: AgentRef): string {
  return `${agent.definition}-${agent.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Each message RPH placed in a request, by the block it is part of: the message itself, as the request carries it, names it. */
const blocks = new WeakMap<object, string>();

/** Names the block a message RPH places in a request is part of, for the kept request; gives the message. */
export function placed<M extends object>(message: M, block: string): M {
  blocks.set(message, block);
  return message;
}

/** A call's messages, in order, as role and text, each RPH placed with its block; `opening` is the agent's opening block as the runner made it. */
export function sentMessages(messages: readonly Message[], opening?: Message): KeptMessage[] {
  return messages.map((message) => {
    const block = message === opening ? "opening" : blocks.get(message);
    return { role: message.role, text: message.role === "system" ? getSystemMessageText(message) : contentText(message.content), ...(block !== undefined ? { block } : {}) };
  });
}

/**
 * Where one call's request is kept: `transcripts/<definition>-<handle>.call-<n>.json`, beside that
 * agent's transcript; a lead's call before a compaction (§11), a run of its own, as `.save-<n>.json`.
 */
export function requestPath(turn: string, agent: AgentRef, call: number, kind: "call" | "save" = "call"): string {
  return `${turn}${TRANSCRIPTS}${agentFileName(agent)}.${kind}-${call}.json`;
}

/** A file of the turn's folder a kept request may point into: its name there, and its text as written. */
export interface PointedFile {
  file: string;
  text: string;
}

type KeptLine = { role: string; block?: string; text: string } | { role: string; block?: string; from: { file: string; at: number; length: number } };

interface KeptFile {
  sent: string;
  messages: KeptLine[];
  tools: { name: string; file?: string }[];
}

function hashOf(messages: readonly KeptMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map(({ role, text, block }) => ({ role, text, ...(block !== undefined ? { block } : {}) })))).digest("hex");
}

/** Whether a block's text is the briefing file's (what the session carried, the briefing) rather than a view's. */
function briefed(block: string | undefined): boolean {
  return block === "briefing" || block === "session:carry";
}

/** A request in the pointer form: each message whose text is in a file of the turn's folder, as where it is there; every other, as its text. */
export function pointerForm(messages: readonly KeptMessage[], files: readonly PointedFile[], tools: readonly { name: string; file?: string }[]): string {
  const lines = messages.map((message): KeptLine => {
    const { role, text, block } = message;
    const head = { role, ...(block !== undefined ? { block } : {}) };
    if (text === "") return { ...head, text };
    const order = [...files].sort((a, b) => Number(a.file.startsWith("briefing") !== briefed(block)) - Number(b.file.startsWith("briefing") !== briefed(block)));
    for (const file of order) {
      const at = file.text.indexOf(text);
      if (at >= 0) return { ...head, from: { file: file.file, at, length: text.length } };
    }
    return { ...head, text };
  });
  const kept: KeptFile = { sent: hashOf(messages), messages: lines, tools: [...tools] };
  return JSON.stringify(kept);
}

function isKeptFile(value: unknown): value is KeptFile {
  return typeof value === "object" && value !== null && "sent" in value && typeof value.sent === "string" && "messages" in value && Array.isArray(value.messages) && "tools" in value && Array.isArray(value.tools);
}

/** A kept request rebuilt from the turn's folder, exactly as it was sent; undefined when the file is not there or not a kept request. */
export async function rebuildRequest(files: FilesPort, scope: Scope, path: string): Promise<RebuiltRequest | undefined> {
  const read = await files.read(scope, path);
  if (read.status !== "read") return undefined;
  let kept: unknown;
  try {
    kept = JSON.parse(read.text);
  } catch {
    return undefined;
  }
  if (!isKeptFile(kept)) return undefined;
  const at = path.lastIndexOf(TRANSCRIPTS);
  const turn = at < 0 ? "" : path.slice(0, at);
  const texts = new Map<string, string | undefined>();
  const textOf = async (file: string): Promise<string | undefined> => {
    if (!texts.has(file)) {
      const got = await files.read(scope, `${turn}${file}`);
      texts.set(file, got.status === "read" ? got.text : undefined);
    }
    return texts.get(file);
  };
  const messages: KeptMessage[] = [];
  for (const line of kept.messages) {
    const text = "text" in line ? line.text : (await textOf(line.from.file))?.slice(line.from.at, line.from.at + line.from.length);
    messages.push({ role: line.role, text: text ?? "", ...(line.block !== undefined ? { block: line.block } : {}) });
  }
  return { messages, tools: kept.tools, same: hashOf(messages) === kept.sent };
}
