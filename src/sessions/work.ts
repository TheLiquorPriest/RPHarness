// An agent's own work as its session's file keeps it (§11, §13.4), read back as pi's transcript, so
// a job carried on or resumed goes on from where it stood (§13.5): each message its model wrote,
// with the calls it made, then what came back to each. Where a summary of its own older calls
// stands, its work starts from that summary. A call the file holds no answer to (the run was cut off
// while it ran) is answered with the runner's text for a call left unfinished: it may have done its
// work, or not. Its thinking is never kept, so none comes back; a tool found through `tool_use` comes
// back as the call of that tool the file names.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import type { JsonObject } from "../contract";
import { assistantMessage, userMessage } from "../harness/prompt";
import { CLOSING } from "../loop";
import type { CallEntry, ResultEntry, SessionLog } from "./file";

/** A call's arguments as the model wrote them: closing among them where it marked the call so. */
function argumentsOf(entry: CallEntry): JsonObject {
  const args = typeof entry.args === "object" && entry.args !== null && !Array.isArray(entry.args) ? { ...entry.args } : {};
  return entry.closing === true ? { ...args, [CLOSING]: true } : args;
}

/** What came back to a call, as the model read it: its text, then each report. */
function resultOf(entry: ResultEntry): ToolResultMessage {
  return { role: "toolResult", toolCallId: entry.callId, toolName: entry.tool, content: [entry.text, ...(entry.reports ?? [])].map((text) => ({ type: "text" as const, text })), isError: entry.error === true, timestamp: entry.at };
}

/** The agent's work in `turn` of its session's file (a job's turn is its id), on the model it runs on; `unfinished` words the answer to a call nothing came back to. */
export function keptWork(log: SessionLog, turn: string, model: Model<Api>, unfinished: (tool: string) => string | undefined): AgentMessage[] {
  const tip = log.tip(turn);
  if (tip === undefined) return [];
  const entries = log.path(tip).filter((entry) => "turn" in entry && entry.turn === turn);
  const summary = entries.findLast((entry) => entry.type === "compacted" && entry.of === "run");
  const messages: AgentMessage[] = summary?.type === "compacted" ? [userMessage(summary.summary, summary.at)] : [];
  let open: { message: AssistantMessage; results: Map<string, ToolResultMessage> } | undefined;
  const close = (): void => {
    if (open === undefined) return;
    messages.push(open.message);
    for (const part of open.message.content) {
      if (part.type !== "toolCall") continue;
      const line = unfinished(part.name);
      messages.push(open.results.get(part.id) ?? { role: "toolResult", toolCallId: part.id, toolName: part.name, content: line === undefined ? [] : [{ type: "text", text: line }], isError: true, timestamp: open.message.timestamp });
    }
    open = undefined;
  };
  for (const entry of entries.slice(summary === undefined ? 0 : entries.indexOf(summary) + 1)) {
    if (entry.type === "message") {
      close();
      // A message cut short or failed left the transcript as it ran (the runner's settle); so here.
      if (entry.stop === "error" || entry.stop === "aborted") continue;
      const message = assistantMessage(entry.text, model, entry.at);
      open = { message: { ...message, content: entry.text === "" ? [] : message.content }, results: new Map() };
    } else if (entry.type === "call" && open !== undefined) {
      open.message.content.push({ type: "toolCall", id: entry.callId, name: entry.tool, arguments: argumentsOf(entry) });
      open.message.stopReason = "toolUse";
    } else if (entry.type === "result" && open !== undefined) open.results.set(entry.callId, resultOf(entry));
  }
  close();
  return messages;
}
