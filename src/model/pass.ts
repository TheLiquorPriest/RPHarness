// A request that is no turn (STANDALONE-PLAN §4.2: a title, a summary, a quiet generation, anything
// another extension sends through the connection), passed through to the connection the host names,
// whole, its answer streamed back as it comes. Its body is OpenAI's chat completions, as a chat
// application's custom connection posts it: its messages and tools, its answer room, sampling,
// effort and tool choice are read from it, and every other field of it is sent as it came where the
// call speaks that API. A provider with another API takes what it has a place for.
//
// What has no way to the model refuses the request before anything of it is sent, in words that
// name it and say what to do: a speaker's name, audio and video, media given by address, an image in
// a system message or in a message of the model's own, a tool choice other than letting the model
// choose or not, and a prefix to continue where the call can't continue one. Dropped, any of them
// would change what the model is told and nobody would know. A message is named by its place in the
// body, where each tool's result is a message of its own.
//
// Of the APIs a connection speaks, only Anthropic's continues an assistant's message given last, and
// Anthropic refuses that prefix to Claude 4.6 and later whatever they are asked, and to an earlier
// model while it thinks (its "Thinking" documentation: "Response prefill and forced tool use").
// pi-ai's catalogue marks the models from 4.6 on as thinking adaptively, and sends its own effort
// mark after the last message to those of them that take one, so the prefix wouldn't even be last.
// A prefix is therefore looked at against the call itself: the model it goes to, and how that model
// is asked to think.
//
// A turn of the model's that the body sends back carries its reasoning in the chat application's
// shapes: on a chat-completions call the reasoning text (DeepSeek's `reasoning_content`) and
// OpenRouter's reasoning details go back as that model's own; anything else of it is left out, and
// the turn's text and calls go back as they are. A cache mark (`cache_control`) is let go: the
// provider places its own, and a mark changes nothing of what the model is told.

import type { AssistantMessage, AssistantMessageEventStream, ImageContent, Message, TextContent, ThinkingContent, Tool, ToolCall, ToolChoice } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import type { JsonObject, PassError, PassRequest, PassResult, PassSink } from "../contract";
import type { CallDeps, CallShape } from "./call";
import { keyOf, makeCall, shapeOf } from "./call";
import { isRecord } from "./json";
import type { Sampling } from "./kinds";
import type { ModelEffort } from "./source";
import { compatSays } from "./transcript";
import { errorWords } from "./words";

/** Something of a request that can't be carried: the request is refused with these words. */
class NotCarried extends Error {}

/** A part of a passed message: text, media as its data, a tool call the model made, or a tool's result going back. */
type PassedPart = { type: "text"; text: string } | { type: "media"; media: "image" | "audio" | "video"; data: string; mimeType: string } | { type: "tool_use"; id: string; name: string; input: JsonObject } | { type: "tool_result"; toolUseId: string; content: string };

/**
 * A message of a passed request, as read here: its text as it came, or its parts where the request
 * gave parts, tool calls or tool results. `prefix` marks an assistant message the model is to
 * continue; `reasoning` and `reasoningDetails` are an assistant turn's reasoning as the model gave
 * it (`reasoning_content`, `reasoning_details`).
 */
interface PassedMessage {
  role: "system" | "user" | "assistant";
  content: string | PassedPart[];
  name?: string;
  prefix?: true;
  reasoning?: string;
  reasoningDetails?: JsonObject[];
  /** How many of the body's messages it was: a run of tool results is one here. */
  of: number;
}

interface PassedTool {
  name: string;
  description: string;
  parameters: JsonObject;
  strict?: boolean;
}

/** Whether a field holds nothing: absent, null, or an empty text, list or object. */
function holdsNothing(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
}

/** Refuses every field of `record` but those named, unless it holds nothing. */
function onlyFields(record: Record<string, unknown>, fields: readonly string[], what: string): void {
  for (const [field, value] of Object.entries(record)) {
    if (!fields.includes(field) && !holdsNothing(value)) throw new NotCarried(`${what} has the field \`${field}\`, which can't be passed on`);
  }
}

/**
 * Media given as a base64 `data:` URL, which is how the layer's calls take it: its type (with
 * whatever parameters the type has) and its data. Media named by an address can't be handed on,
 * since nothing here downloads; a refusal quotes `quoted` characters of the address (`calls.quoted`).
 */
function dataOf(url: unknown, what: string, quoted: number): { mimeType: string; data: string } {
  if (typeof url !== "string" || url === "") throw new NotCarried(`${what} has no data`);
  const found = /^data:([^,]+);base64,(.*)$/s.exec(url);
  if (found) return { mimeType: found[1] ?? "", data: found[2] ?? "" };
  if (url.startsWith("data:")) throw new NotCarried(`${what} is a \`data:\` URL of another form than \`data:<type>;base64,<data>\``);
  throw new NotCarried(`${what} is given by its address (${url.length > quoted ? `${url.slice(0, quoted)}…` : url}), and model calls take media only as its data: send it as a base64 \`data:\` URL (nothing is downloaded)`);
}

/** One part of a message's content list. */
function partOf(raw: unknown, what: string, quoted: number): PassedPart {
  if (!isRecord(raw) || typeof raw.type !== "string") throw new NotCarried(`${what} isn't a content part`);
  /** The object a part of this kind keeps its media in, with no field but those named. */
  const held = (field: string, fields: readonly string[]): Record<string, unknown> => {
    onlyFields(raw, ["type", field, "cache_control"], what);
    const inner = raw[field];
    if (!isRecord(inner)) throw new NotCarried(`${what} has no \`${field}\``);
    onlyFields(inner, fields, what);
    return inner;
  };
  switch (raw.type) {
    case "text":
    case "input_text":
      onlyFields(raw, ["type", "text", "cache_control"], what);
      if (typeof raw.text !== "string") throw new NotCarried(`${what} has no text`);
      return { type: "text", text: raw.text };
    case "image_url": {
      const image = held("image_url", ["url", "detail"]);
      // `auto` is what a provider does when nothing is said.
      if (!holdsNothing(image.detail) && image.detail !== "auto") throw new NotCarried(`${what} asks for its image at \`detail: ${String(image.detail)}\`, which model calls have no place for: leave \`detail\` out`);
      return { type: "media", media: "image", ...dataOf(image.url, what, quoted) };
    }
    case "video_url":
      return { type: "media", media: "video", ...dataOf(held("video_url", ["url"]).url, what, quoted) };
    case "input_audio": {
      const audio = held("input_audio", ["data", "format"]);
      if (typeof audio.data !== "string" || audio.data === "" || typeof audio.format !== "string" || audio.format === "") throw new NotCarried(`${what} is audio without its data or its format`);
      return { type: "media", media: "audio", mimeType: `audio/${audio.format}`, data: audio.data };
    }
    default:
      throw new NotCarried(`${what} is a part of the kind \`${raw.type}\`, which can't be passed on`);
  }
}

/** A message's content: text as it came, or its list of parts as parts. */
function contentOf(raw: unknown, what: string, quoted: number): string | PassedPart[] {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) throw new NotCarried(`${what}'s content is neither text nor a list of parts`);
  return raw.map((part, i) => partOf(part, `${what}'s part ${i + 1}`, quoted));
}

/** One of an assistant message's tool calls (`tool_calls[]`). */
function toolUseOf(raw: unknown, what: string): PassedPart {
  if (!isRecord(raw)) throw new NotCarried(`${what} isn't a tool call`);
  onlyFields(raw, ["id", "type", "function"], what);
  const fn = raw.function;
  if (!(raw.type === undefined || raw.type === "function") || !isRecord(fn)) throw new NotCarried(`${what} isn't a function call, the one kind of tool call that is passed on`);
  onlyFields(fn, ["name", "arguments"], what);
  if (typeof raw.id !== "string" || raw.id === "" || typeof fn.name !== "string" || fn.name === "") throw new NotCarried(`${what} has no id, or names no function`);
  // OpenAI writes the arguments as JSON text; a call that gives none takes none.
  let input: unknown = fn.arguments ?? {};
  if (typeof input === "string") {
    try {
      input = input.trim() === "" ? {} : JSON.parse(input);
    } catch {
      input = null;
    }
  }
  if (!isRecord(input)) throw new NotCarried(`${what}'s arguments aren't a JSON object`);
  return { type: "tool_use", id: raw.id, name: fn.name, input: input as JsonObject };
}

const MESSAGE_FIELDS = ["role", "content", "name", "cache_control"];
const ASSISTANT_FIELDS = [...MESSAGE_FIELDS, "prefix", "partial", "tool_calls", "reasoning_content", "reasoning", "reasoning_details"];
const TOOL_FIELDS = [...MESSAGE_FIELDS, "tool_call_id"];

/**
 * The body's messages as read here. `developer` messages are system messages; an assistant's tool
 * calls follow its content as `tool_use` parts; each run of `tool` messages is one user message of
 * `tool_result` parts; `prefix: true` (or `partial: true`) on an assistant message is its mark as a
 * prefix.
 */
function passedMessages(raw: unknown, quoted: number): PassedMessage[] {
  if (!Array.isArray(raw)) throw new NotCarried("it has no list of messages");
  const out: PassedMessage[] = [];
  // The user message a run of tool results goes into, while the run lasts.
  let results: PassedMessage | null = null;
  raw.forEach((m: unknown, i) => {
    const what = `message ${i + 1}`;
    if (!isRecord(m)) throw new NotCarried(`${what} isn't a message`);
    const content = contentOf(m.content, what, quoted);
    if (m.role === "tool") {
      // A result's `name` repeats its call's, which is sent: nothing is lost with it.
      onlyFields(m, TOOL_FIELDS, what);
      if (typeof m.tool_call_id !== "string" || m.tool_call_id === "") throw new NotCarried(`${what}, a tool's result, names no tool call`);
      if (typeof content !== "string" && content.some((p) => p.type !== "text")) throw new NotCarried(`${what}, a tool's result, holds more than text, and a result is passed on as one text`);
      const part: PassedPart = { type: "tool_result", toolUseId: m.tool_call_id, content: typeof content === "string" ? content : content.map((p) => (p.type === "text" ? p.text : "")).join("") };
      if (results === null || !Array.isArray(results.content)) {
        results = { role: "user", content: [part], of: 1 };
        out.push(results);
      } else {
        results.content.push(part);
        results.of += 1;
      }
      return;
    }
    results = null;
    const role = m.role === "developer" ? "system" : m.role;
    if (role !== "system" && role !== "user" && role !== "assistant") throw new NotCarried(`${what} has the role \`${String(m.role)}\`, and system, developer, user, assistant and tool messages are passed on`);
    onlyFields(m, role === "assistant" ? ASSISTANT_FIELDS : MESSAGE_FIELDS, what);
    if (!holdsNothing(m.name) && typeof m.name !== "string") throw new NotCarried(`${what} has a name that isn't text`);
    const message: PassedMessage = { role, content, ...(typeof m.name === "string" && m.name !== "" ? { name: m.name } : {}), of: 1 };
    if (role === "assistant") {
      if (!holdsNothing(m.tool_calls)) {
        if (!Array.isArray(m.tool_calls)) throw new NotCarried(`${what}'s tool calls aren't a list`);
        const said: PassedPart[] = typeof content !== "string" ? content : content === "" ? [] : [{ type: "text", text: content }];
        message.content = [...said, ...m.tool_calls.map((call, n) => toolUseOf(call, `${what}'s tool call ${n + 1}`))];
      }
      for (const mark of [m.prefix, m.partial]) if (!holdsNothing(mark) && typeof mark !== "boolean") throw new NotCarried(`${what}'s mark as a prefix isn't true or false`);
      if (m.prefix === true || m.partial === true) message.prefix = true;
      // The model's reasoning text goes by either name; two that differ can't both be it.
      const reasoning = [m.reasoning_content, m.reasoning].filter((r) => !holdsNothing(r));
      if (reasoning.some((r) => typeof r !== "string") || (reasoning.length === 2 && reasoning[0] !== reasoning[1])) throw new NotCarried(`${what}'s reasoning isn't one text (\`reasoning_content\`, or \`reasoning\`)`);
      if (typeof reasoning[0] === "string") message.reasoning = reasoning[0];
      if (!holdsNothing(m.reasoning_details)) {
        if (!Array.isArray(m.reasoning_details) || !m.reasoning_details.every(isRecord)) throw new NotCarried(`${what}'s reasoning details aren't a list of objects`);
        message.reasoningDetails = m.reasoning_details as JsonObject[];
      }
    }
    out.push(message);
  });
  return out;
}

/** The body's tools (`[{type: "function", function: {name, description, parameters, strict}}]`): functions, the one kind model calls offer. */
function passedTools(raw: unknown): PassedTool[] {
  if (holdsNothing(raw)) return [];
  if (!Array.isArray(raw)) throw new NotCarried("its tools aren't a list");
  return raw.map((tool: unknown, i): PassedTool => {
    const what = `tool ${i + 1}`;
    if (!isRecord(tool)) throw new NotCarried(`${what} isn't a tool`);
    onlyFields(tool, ["type", "function"], what);
    const fn = tool.function;
    if (!(tool.type === undefined || tool.type === "function") || !isRecord(fn)) throw new NotCarried(`${what} isn't a function, the one kind of tool model calls offer a model`);
    onlyFields(fn, ["name", "description", "parameters", "strict"], what);
    const { name, description, parameters, strict } = fn;
    if (typeof name !== "string" || name === "") throw new NotCarried(`${what} names no function`);
    if ((!holdsNothing(description) && typeof description !== "string") || (!holdsNothing(parameters) && !isRecord(parameters)) || (strict !== undefined && strict !== null && typeof strict !== "boolean")) throw new NotCarried(`${what} isn't a function as OpenAI writes one (a description, its parameters as a JSON Schema, \`strict\` as true or false)`);
    // A function given no parameters takes none, which a schema says as an object without properties.
    return { name, description: typeof description === "string" ? description : "", parameters: isRecord(parameters) ? (parameters as JsonObject) : { type: "object", properties: {} }, ...(typeof strict === "boolean" ? { strict } : {}) };
  });
}

/** The fields of a body that say what to send and how to answer, which a passthrough sets itself. */
const OWN_FIELDS: Readonly<Record<string, true>> = { messages: true, tools: true, model: true, stream: true, stream_options: true };

/** The fields of a body read here; every other one is sent as it came, where it can be. */
const READ: Readonly<Record<string, true>> = {
  max_tokens: true,
  max_completion_tokens: true,
  temperature: true,
  top_p: true,
  top_k: true,
  min_p: true,
  frequency_penalty: true,
  presence_penalty: true,
  repetition_penalty: true,
  seed: true,
  stop: true,
  reasoning_effort: true,
  reasoning: true,
  parallel_tool_calls: true,
  tool_choice: true,
};

const EFFORTS: readonly ModelEffort[] = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The effort the body names, with the field it names it in (OpenAI's `reasoning_effort`, or OpenRouter's `reasoning.effort`); null where it names none. */
function askedEffort(body: JsonObject): { field: string; value: string } | null {
  if (typeof body.reasoning_effort === "string") return { field: "reasoning_effort", value: body.reasoning_effort };
  if (isRecord(body.reasoning) && typeof body.reasoning.effort === "string") return { field: "reasoning.effort", value: body.reasoning.effort };
  return null;
}

/** The effort the body asks for; `auto` (the connection's own) where it asks none, or one there is no such effort as. OpenAI's `none` is off. */
function effortOf(body: JsonObject): ModelEffort {
  const asked = askedEffort(body)?.value;
  if (asked === "none") return "off";
  return EFFORTS.find((e) => e === asked) ?? "auto";
}

/** The body's tool choice, as model calls can make it: the model chooses, or calls none. */
function toolChoiceOf(raw: unknown): ToolChoice | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "auto" || raw === "none") return raw;
  throw new NotCarried(`it asks the model to call a tool (\`tool_choice\`: ${JSON.stringify(raw)}), and model calls let the model choose a tool or call none: set \`tool_choice\` to "auto" or "none", or leave it out`);
}

const NUMBERS = ["temperature", "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed"] as const;

/** The body's sampling parameters, as the preset set them. */
function samplingOf(body: JsonObject): Sampling {
  const out: Sampling = {};
  for (const key of NUMBERS) {
    const v = body[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((s): s is string => typeof s === "string") : [];
  if (stop.length > 0) out.stop = stop;
  return out;
}

/** The answer room the body asks for; undefined when it names none. */
function maxTokensOf(body: JsonObject): number | undefined {
  const v = body.max_tokens ?? body.max_completion_tokens;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

/** Why a call of this shape can't continue the prefix the request ends in (see the head of this file); null where it can. */
function prefixRefusal(shape: CallShape, body: JsonObject): string | null {
  const { connection, kind, model } = shape;
  const prefix = `the last message is a prefix to continue (\`prefix\`), and the connection "${connection.name}" (${kind.name}, ${model.id})`;
  if (model.api !== "anthropic-messages") return `${prefix} can't continue one: only Anthropic's API continues a message given to it. Take the mark off to send the message as one the model wrote before, or use a connection to an earlier Claude model than 4.6`;
  if (compatSays(model, "forceAdaptiveThinking")) return `${prefix} can't continue one: Anthropic refuses a prefix to Claude 4.6 and later. Leave the message out, or use a connection to an earlier Claude model`;
  if (shape.reasoning === undefined) return null;
  const asked = askedEffort(body);
  // The effort that has the model think: the request's own, or the connection's where the request leaves it to the connection.
  return effortOf(body) !== "auto" && asked !== null
    ? `${prefix} can't continue one while its model thinks, as the request asks it to (\`${asked.field}\`: ${JSON.stringify(asked.value)}): send "none" there instead`
    : `${prefix} can't continue one while its model thinks, as the connection's effort (${connection.effort ?? "its provider's"}) has it do: send \`reasoning_effort\`: "none" with the request, or set the connection's effort to off`;
}

/** A message's text, its text parts together. */
function textOf(m: PassedMessage): string {
  return typeof m.content === "string" ? m.content : m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
}

/** Thinking a turn carries in the chat application's shapes that maps to a call on `api`, as that model's own; none for any other API. */
function carriedThinking(m: PassedMessage, api: string): ThinkingContent[] {
  if (api !== "openai-completions") return [];
  if (m.reasoningDetails !== undefined && m.reasoningDetails.length > 0) return [{ type: "thinking", thinking: m.reasoning ?? "", thinkingSignature: JSON.stringify(m.reasoningDetails) }];
  // A chat application sends the reasoning text back as `reasoning_content`, the field DeepSeek reads.
  if (m.reasoning) return [{ type: "thinking", thinking: m.reasoning, thinkingSignature: "reasoning_content" }];
  return [];
}

const NO_USAGE: AssistantMessage["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Refuses what of the body's messages no call carries (see the head of this file), each named by its place in the body. */
function refuseUncarried(passed: readonly PassedMessage[]): void {
  let read = 0;
  passed.forEach((m, i) => {
    const what = `message ${read + 1}`;
    read += m.of;
    if (m.name !== undefined) throw new NotCarried(`${what} names its speaker (\`name\`), which model calls have no place for: put the name in the message's text, or leave it out`);
    if (m.prefix === true && !(m.role === "assistant" && i === passed.length - 1)) throw new NotCarried(`${what} is marked as a prefix to continue (\`prefix\`), and only the last message, the model's own, can be one: take the mark off`);
    if (typeof m.content === "string") return;
    m.content.forEach((p, j) => {
      const part = `${what}'s part ${j + 1}`;
      if (p.type === "tool_use" && m.role !== "assistant") throw new NotCarried(`${what} holds a call to the tool "${p.name}", which only the model's own turn can hold`);
      if (p.type !== "media") return;
      if (p.media !== "image") throw new NotCarried(`${part} is ${p.media === "audio" ? "audio" : "a video"}, and model calls carry text and images only: leave it out, or give what it holds as text`);
      if (m.role === "system") throw new NotCarried(`${part} is an image in a system message, and model calls carry a system message's text only: put the image in a user's message, or leave it out`);
      if (m.role === "assistant") throw new NotCarried(`${part} is an image in a message of the model's own, and model calls carry only the text, reasoning and tool calls of one: put the image in a user's message, or leave it out`);
    });
  });
}

/** The body's messages as pi-ai's, for a call of this shape, once `refuseUncarried` let them through: each tool's result a result of its own, named after the call it answers. */
function messagesFor(passed: readonly PassedMessage[], shape: CallShape): Message[] {
  const out: Message[] = [];
  const callNames = new Map<string, string>();
  for (const m of passed) {
    const parts = typeof m.content === "string" ? [] : m.content;
    if (m.role === "system") {
      out.push({ role: "system", content: textOf(m), timestamp: 0 });
    } else if (m.role === "assistant") {
      const text = textOf(m);
      const calls: ToolCall[] = parts.flatMap((p) => (p.type === "tool_use" ? [{ type: "toolCall" as const, id: p.id, name: p.name, arguments: p.input }] : []));
      for (const c of calls) callNames.set(c.id, c.name);
      const content: AssistantMessage["content"] = [...carriedThinking(m, shape.model.api), ...(text !== "" ? [{ type: "text" as const, text }] : []), ...calls];
      // Said to be the call's own model's, so pi-ai sends its reasoning back as that model's.
      out.push({ role: "assistant", content, api: shape.model.api, provider: shape.model.provider, model: shape.model.id, usage: NO_USAGE, stopReason: calls.length > 0 ? "toolUse" : "stop", timestamp: 0 });
    } else if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content, timestamp: 0 });
    } else {
      const blocks: (TextContent | ImageContent)[] = [];
      for (const p of m.content) {
        if (p.type === "tool_result") out.push({ role: "toolResult", toolCallId: p.toolUseId, toolName: callNames.get(p.toolUseId) ?? "", content: [{ type: "text", text: p.content }], isError: false, timestamp: 0 });
        else if (p.type === "text") blocks.push({ type: "text", text: p.text });
        else if (p.type === "media") blocks.push({ type: "image", data: p.data, mimeType: p.mimeType });
      }
      if (blocks.length > 0) out.push({ role: "user", content: blocks, timestamp: 0 });
    }
  }
  return out;
}

function toolOf(t: PassedTool): Tool {
  return { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { constrainedSampling: t.strict ? { type: "json_schema", strict: "require" } : false } : {}) };
}

/** How the call ended, in the words a chat application reads (OpenAI's). */
function finishOf(reason: AssistantMessage["stopReason"]): string {
  return reason === "toolUse" ? "tool_calls" : reason === "length" ? "length" : "stop";
}

/** A finished answer as the host takes it back: its text, reasoning and calls, the model that answered, and its tokens. */
function resultOf(message: AssistantMessage): PassResult {
  const text: string[] = [];
  const reasoning: string[] = [];
  const calls: PassResult["toolCalls"] = [];
  for (const b of message.content) {
    if (b.type === "text") text.push(b.text);
    else if (b.type === "thinking") {
      if (b.redacted !== true && b.thinking !== "") reasoning.push(b.thinking);
    } else calls.push({ id: b.id, name: b.name, args: JSON.parse(JSON.stringify(b.arguments)) });
  }
  const { usage } = message;
  return {
    content: text.join(""),
    ...(reasoning.length > 0 ? { reasoning: reasoning.join("\n\n") } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    finishReason: finishOf(message.stopReason),
    model: message.responseModel ?? message.model,
    usage: { calls: 1, input: usage.input + usage.cacheRead + usage.cacheWrite, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}) },
  };
}

/** The words a refused request goes back with, `what` saying what of it can't be carried and what to do. */
function notPassedWords(what: string): string {
  return `This request wasn't passed on: ${what}. A request that is no turn goes to its connection whole or not at all, so that nothing of a prompt is dropped on the way.`;
}

/**
 * Passes a request through (see the head of this file), its answer streamed to `sink`, which hears
 * exactly one `finish` or one `error`. Nothing of the request is sent when it is refused. Its
 * settings are read at the levels every chat shares: a request passed through has no chat in view.
 */
export async function passRequest(deps: CallDeps, request: PassRequest, sink: PassSink, signal: AbortSignal): Promise<void> {
  const fail = (code: PassError["code"], detail: string): void => sink.error({ code, detail });
  const body = request.body;
  const settings = await deps.settings({ user: deps.user });
  let out: AssistantMessageEventStream;
  try {
    const messages = passedMessages(body.messages, settings.quoted);
    const tools = passedTools(body.tools);
    refuseUncarried(messages);
    const toolChoice = tools.length > 0 ? toolChoiceOf(body.tool_choice) : undefined;
    let shape: CallShape;
    try {
      shape = await shapeOf(deps, { connectionId: request.connection, model: null, effort: effortOf(body) });
      await keyOf(deps.book, shape.connection, shape.kind);
    } catch (error) {
      return fail("no-connection", errorWords(error));
    }
    if (messages.at(-1)?.prefix === true) {
      const refused = prefixRefusal(shape, body);
      if (refused !== null) throw new NotCarried(refused);
    }
    const context = normalizeContext({ messages: messagesFor(messages, shape), ...(tools.length > 0 ? { tools: tools.map(toolOf) } : {}) });
    const extras: JsonObject = {};
    for (const [key, value] of Object.entries(body)) if (!Object.hasOwn(READ, key) && !Object.hasOwn(OWN_FIELDS, key)) extras[key] = value;
    const maxTokens = maxTokensOf(body);
    out = createAssistantMessageEventStream();
    // A request passed through goes as it came: a system message in its middle goes in place unmarked.
    const { markNote: _unmarked, ...asItCame } = deps;
    void makeCall(
      asItCame,
      shape,
      context,
      {
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(shape.reasoning !== undefined ? { reasoning: shape.reasoning } : {}),
        sampling: samplingOf(body),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        serialTools: body.parallel_tool_calls === false || shape.connection.serialTools === true,
        // A request passed through belongs to no session; it keeps a prompt as `calls.cacheRetention` says.
        cacheRetention: settings.cacheRetention,
        ...(Object.keys(extras).length > 0 ? { extras } : {}),
        carried: {},
      },
      settings,
      signal,
      out,
    );
  } catch (error) {
    if (error instanceof NotCarried) return fail("not-carried", notPassedWords(error.message));
    throw error;
  }
  for await (const event of out) {
    if (event.type === "text_delta") sink.content(event.delta);
    else if (event.type === "thinking_delta") sink.reasoning(event.delta);
    else if (event.type === "done") return sink.finish(resultOf(event.message));
    else if (event.type === "error") return fail(event.reason === "aborted" ? "stopped" : "provider", event.error.errorMessage ?? "");
  }
  const result = await out.result();
  if (result.stopReason === "error" || result.stopReason === "aborted") return fail(result.stopReason === "aborted" ? "stopped" : "provider", result.errorMessage ?? "");
  sink.finish(resultOf(result));
}
