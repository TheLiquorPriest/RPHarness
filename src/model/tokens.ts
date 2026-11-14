// Token counts per model call: what a call sent (and how much of it the provider read from its cache,
// and wrote to it), what it wrote (and how much of that was reasoning), and what it cost, read from
// the usage pi-ai reports for the answer. A count the provider never reports is an estimate, from
// the call's text at a number of characters per token, flagged as one. What a call wrote to the
// cache is no estimate: it is there only where the provider reports writes (Anthropic's API always
// does, any other when it wrote some). The cost is the provider's own bill where it sent one
// (OpenRouter's); else what the model's published price in pi's catalogue makes of the counts,
// which is no bill and is flagged as an estimate; else unknown.
//
// pi-ai's `input` leaves out what was read from the cache and written to it, and its `output` holds
// the reasoning; a call's tokens in here are the whole of what was sent.

import type { Api, AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";

/** Characters per token for an estimate made before a provider reports its own count, where the setting gives none. */
export const DEFAULT_CHARS_PER_TOKEN = 3.2;

/** A text's tokens, estimated: whole tokens, rounded up. */
export function tokensOf(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

/** What tools weigh in a call's prompt, as estimated: each one's name, description and schema. */
function toolsText(tools: readonly Tool[] | undefined): string {
  return (tools ?? []).map((t) => `${t.name} ${t.description} ${JSON.stringify(t.parameters)}`).join("\n");
}

/** A message's text as the estimate counts it: its text, its thinking, each call and result, and a system message's tools (an image counts as nothing: its tokens are the provider's to tell). */
export function messageText(m: Message): string {
  switch (m.role) {
    case "system":
      return [contentText(m.content), ...Object.values(m.sections ?? {}).filter((s): s is string => s !== null), toolsText(m.toolsAdded)].join("\n");
    case "user":
    case "toolResult":
      return contentText(m.content);
    case "assistant":
      return m.content.map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : `${b.name} ${JSON.stringify(b.arguments)}`)).join("\n");
  }
}

/** A call's prompt as estimated before it is sent: every message, with the tools its system messages declare. */
export function promptTokens(messages: readonly Message[], charsPerToken: number): number {
  let tokens = 0;
  for (const m of messages) tokens += tokensOf(messageText(m), charsPerToken);
  return tokens;
}

/** A call's own estimate, for whatever its provider doesn't report: the prompt, the answer and its reasoning. */
export interface UsageEstimate {
  in: number;
  out: number;
  reasoningOut: number;
}

/** What a call sent and what came back, estimated. */
export function estimateOf(sent: readonly Message[], answer: AssistantMessage, charsPerToken: number): UsageEstimate {
  let text = "";
  let reasoning = "";
  for (const b of answer.content) {
    if (b.type === "thinking") reasoning += b.thinking;
    else text += b.type === "text" ? b.text : `${b.name} ${JSON.stringify(b.arguments)}`;
  }
  return { in: promptTokens(sent, charsPerToken), out: tokensOf(text, charsPerToken), reasoningOut: tokensOf(reasoning, charsPerToken) };
}

export type UsageField = "in" | "cachedIn" | "out" | "reasoningOut" | "cost";

/** One call's tokens: `in` (of which `cachedIn` read from the cache, `cacheWrite` written to it) and `out` (of which `reasoningOut` reasoning), and its cost in US dollars where the provider said or a published price gives it. */
export interface CallUsage {
  in: number;
  cachedIn: number;
  cacheWrite?: number;
  out: number;
  reasoningOut: number;
  /** The counts the provider didn't report, which hold the estimate. */
  estimated: UsageField[];
  cost?: number;
}

/**
 * A call's usage from pi-ai's report of its answer, by the model it went to (see the head of this
 * file); `estimate` fills each count the provider didn't report, listed in `estimated`. An answer
 * whose usage is all nought had none reported at all (a server that sends no usage): its counts are
 * all the estimate's, and its cost unknown unless billed, since a price makes nothing of no counts.
 */
export function callUsage(answer: AssistantMessage, model: Pick<Model<Api>, "api" | "cost">, estimate: UsageEstimate): CallUsage {
  const { usage } = answer;
  const estimated: UsageField[] = [];
  const guess = (field: UsageField, value: number): number => {
    estimated.push(field);
    return value;
  };
  const billed = usage.cost.totalFromProvider === true;
  if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) {
    const counts = { in: guess("in", estimate.in), cachedIn: guess("cachedIn", 0), out: guess("out", estimate.out + estimate.reasoningOut), reasoningOut: guess("reasoningOut", estimate.reasoningOut) };
    return { ...counts, estimated, ...(billed ? { cost: usage.cost.total } : {}) };
  }
  const counts = {
    in: usage.input + usage.cacheRead + usage.cacheWrite,
    cachedIn: usage.cacheRead,
    ...(model.api === "anthropic-messages" || usage.cacheWrite > 0 ? { cacheWrite: usage.cacheWrite } : {}),
    out: usage.output,
    reasoningOut: usage.reasoning ?? guess("reasoningOut", estimate.reasoningOut),
  };
  if (billed) return { ...counts, estimated, cost: usage.cost.total };
  const { input, output, cacheRead, cacheWrite } = model.cost;
  if (input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0) return { ...counts, estimated: [...estimated, "cost"], cost: usage.cost.total };
  return { ...counts, estimated };
}
