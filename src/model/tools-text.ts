// Tools as text (§13.2, "moved as it is" from Build 1): for an agent whose model's connection
// refused native tools, and for one whose definition says `tools_as: text`, a call carries no native
// tools. Its tools are offered in its transcript in the words of `.prompts/tools-as-text.md`, where
// they were declared, so the front of the request stays the same from call to call; its own earlier
// calls are shown back in that file's form, and what they answered goes back as a user's message in
// its words. The calls a model writes are read back from its answer's text, in the form the file asks
// for and in the forms models write by themselves, and the answer then holds them as calls, which
// pi's loop runs as the agent's calls of those tools.
//
// A provider's refusal of native tools is read from its words (`refusesTools`): the words providers
// use for it are theirs, not RPH's, and a new one is a fix here.

import type { AssistantMessage, Message, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { contentText, getCurrentTools } from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "../contract";
import type { Fields } from "../files/api";
import { isRecord } from "./json";

/** The tools-as-text file filled in with one use's fields; undefined where it is switched off. */
type Render = ((fields: Fields) => string) | undefined;

/**
 * How providers say a model or endpoint takes no tools: OpenAI-compatible servers ("does not support
 * tools", "function calling is not supported", "tools unsupported", "Unsupported parameter: 'tools'",
 * "Unrecognized request argument supplied: tools"), OpenRouter's routing ("No endpoints found that
 * support tool use"), vLLM's (`"auto" tool choice requires --enable-auto-tool-choice`), llama.cpp's
 * ("tools param requires --jinja flag") and Gemini's ("Function calling is not enabled").
 */
const TOOL_REFUSALS: readonly RegExp[] = [
  /\b(?:does|do)(?: not|n't) support (?:native )?(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling)|functions)\b/i,
  /\b(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling))\b[^.\n]{0,40}\b(?:is|are) not (?:supported|enabled|available)\b/i,
  /\b(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling))(?: are| is)? unsupported\b/i,
  /\bno endpoints found that support tool use\b/i,
  /\bunsupported (?:parameter|argument|field)\b[^.\n]{0,8}\btools?\b/i,
  /\bunrecognized request arguments? supplied\b[^.\n]{0,8}\btools?\b/i,
  /--enable-auto-tool-choice\b/i,
  /\btools? param(?:eter)? requires --jinja\b/i,
  /\bfunction calling is not enabled\b/i,
];

/** Whether a failed call's words are its provider refusing native tools. */
export function refusesTools(words: string | undefined): boolean {
  return words !== undefined && TOOL_REFUSALS.some((pattern) => pattern.test(words));
}

// ---------------------------------------------------------------- the transcript, as text

/** A tool as the file lays it out. */
function toolFields(tool: Tool): JsonObject {
  return { name: tool.name, description: tool.description, parameters: JSON.stringify(tool.parameters) };
}

/** What a run of tool answers says, as one user's message: the file's words around each answer's own text, its pictures after it. */
function answersMessage(results: readonly ToolResultMessage[], render: Render): Message {
  const each = results.map((r) => ({ name: r.toolName, text: contentText(r.content.filter((part) => part.type === "text")), error: r.isError }));
  // With the file switched off, the answers' own texts alone.
  const text = render?.({ answers: { results: each } }) ?? each.map((r) => r.text).join("\n\n");
  const pictures = results.flatMap((r) => r.content.filter((part) => part.type === "image"));
  return { role: "user", content: pictures.length > 0 ? [{ type: "text", text }, ...pictures] : text, timestamp: results[0]?.timestamp ?? 0 };
}

/** An assistant's turn with its calls shown as text in the file's form, each in its place among its text; its thinking kept. */
function callsShown(m: AssistantMessage, render: Render): AssistantMessage {
  if (!m.content.some((part) => part.type === "toolCall")) return m;
  const content: AssistantMessage["content"] = [];
  for (const part of m.content) {
    const text = part.type === "toolCall" ? (render?.({ call: { name: part.name, arguments: JSON.stringify(part.arguments), json: JSON.stringify({ name: part.name, arguments: part.arguments }) } }) ?? "") : part.type === "text" ? part.text : undefined;
    if (text === undefined) {
      content.push(part);
      continue;
    }
    const last = content.at(-1);
    if (last?.type === "text") content[content.length - 1] = { ...last, text: [last.text, text].filter((t) => t !== "").join("\n") };
    else if (text !== "") content.push({ type: "text", text });
  }
  return { ...m, content };
}

/**
 * A call's transcript with its tools as text (see the head of this file): each system message that
 * declared tools, or took some away, followed in its place by the file's words for that, and no
 * native tool left in it; each earlier call shown in the file's form; each run of tool answers one
 * user's message in the file's words.
 */
export function asText(messages: readonly Message[], render: Render): Message[] {
  const out: Message[] = [];
  let offered = false;
  let answers: ToolResultMessage[] = [];
  const flush = (): void => {
    if (answers.length > 0) out.push(answersMessage(answers, render));
    answers = [];
  };
  for (const m of messages) {
    if (m.role === "toolResult") {
      answers.push(m);
      continue;
    }
    flush();
    if (m.role === "assistant") {
      out.push(callsShown(m, render));
      continue;
    }
    if (m.role !== "system" || (m.toolsAdded === undefined && m.toolsRemoved === undefined)) {
      out.push(m);
      continue;
    }
    const { toolsAdded, toolsRemoved, ...rest } = m;
    if (contentText(rest.content) !== "" || rest.sections !== undefined) out.push(rest);
    const said: string[] = [];
    if (toolsAdded !== undefined && toolsAdded.length > 0) {
      said.push(render?.(offered ? { added: { tools: toolsAdded.map(toolFields) } } : { offered: { tools: toolsAdded.map(toolFields) } }) ?? "");
      offered = true;
    }
    if (toolsRemoved !== undefined && toolsRemoved.length > 0) said.push(render?.({ removed: { names: toolsRemoved.map((ref) => ref.name) } }) ?? "");
    const text = said.filter((s) => s !== "").join("\n\n");
    if (text !== "") out.push({ role: "system", content: text, timestamp: m.timestamp });
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- calls read back from text

/** A call a model wrote as text instead of making it. */
interface WrittenCall {
  name: string;
  args: JsonObject;
}

/** JSON text read as a value; undefined where it isn't JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A written call's arguments as an object: an object, JSON text of one, or nothing for none; null when they're neither. */
function writtenArgs(v: unknown): JsonObject | null {
  if (v === undefined || v === null) return {};
  const value = typeof v === "string" ? parsed(v) : v;
  return isRecord(value) ? (value as JsonObject) : null;
}

/**
 * A JSON value as written calls: one call or a list of them, each naming a tool the agent has, its
 * arguments under any of the names models use; null when it isn't that (a tool's description is no
 * call, so an object that has one isn't read as one).
 */
function callsFromJson(value: unknown, names: ReadonlySet<string>): WrittenCall[] | null {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return null;
  const out: WrittenCall[] = [];
  for (const item of list) {
    if (!isRecord(item) || item.description !== undefined) return null;
    const fn = isRecord(item.function) ? item.function : null;
    const named = [item.name, item.tool, item.tool_name, item.function, fn?.name].find((n): n is string => typeof n === "string");
    if (named === undefined || !names.has(named)) return null;
    const args = writtenArgs(item.arguments ?? item.args ?? item.parameters ?? item.input ?? fn?.arguments);
    if (args === null) return null;
    out.push({ name: named, args });
  }
  return out;
}

/** A written argument's value: JSON where it parses (a number, a list), else its text. */
function writtenValue(text: string): JsonValue {
  const trimmed = text.trim();
  const value = parsed(trimmed);
  return value === undefined ? trimmed : (value as JsonValue);
}

// A model's answer is read here as it came, and it may be anything: a tag opened and never closed,
// with a page of blank lines after it, is an answer a model has written. A pattern that takes
// "anything up to the closing tag" reads the rest of such an answer once for every way of splitting
// what it has read, and again for every opening tag after it. So a form's blocks are found a tag at a
// time: an opening tag, then the first closing tag after it by `indexOf`, and a form whose opening
// tag has no closing tag is done with, since no tag after it has one either. Every search starts
// where the one before it ended, so an answer is read in time in line with its length.

/** A block one of the forms encloses: where it stands in the text, the name its opening tag carries (`""` for a form whose tag has none), and what stands between its tags. */
interface Block {
  start: number;
  end: number;
  name: string;
  body: string;
}

/** An opening tag: where its block starts, where the block's body starts, and the name it carries. */
interface OpeningTag {
  at: number;
  body: number;
  name: string;
}

/** A form's opening tags in one text: the first at or after `from`, or null when the text has no more. Asked from places that only move forward. */
type OpeningTags = (from: number) => OpeningTag | null;

/** A form calls are written in: how its blocks open, and the tags that close them. */
interface Form {
  open: (text: string) => OpeningTags;
  close: readonly string[];
}

/** Where the first of `tags` next stands in `text`, for searches that only move forward: each tag's last find answers every search before it. */
function seeker(text: string, tags: readonly string[]): (from: number) => { at: number; end: number } | null {
  const next = tags.map((tag) => text.indexOf(tag));
  return (from) => {
    let first: { at: number; end: number } | null = null;
    for (const [i, tag] of tags.entries()) {
      let at = next[i] ?? -1;
      if (at >= 0 && at < from) next[i] = at = text.indexOf(tag, from);
      if (at >= 0 && (first === null || at < first.at)) first = { at, end: at + tag.length };
    }
    return first;
  };
}

/** Opening tags that start with one of `tags` and go on as `head` reads (a sticky pattern: the rest of the tag, its first group the name the tag carries); with no `head`, each of `tags` is a whole tag. */
function tagged(tags: readonly string[], head?: RegExp): (text: string) => OpeningTags {
  return (text) => {
    const seek = seeker(text, tags);
    return (from) => {
      for (let tag = seek(from); tag; tag = seek(tag.at + 1)) {
        if (!head) return { at: tag.at, body: tag.end, name: "" };
        head.lastIndex = tag.end;
        const rest = head.exec(text);
        if (rest) return { at: tag.at, body: head.lastIndex, name: rest[1] ?? "" };
      }
      return null;
    };
  };
}

/** What ends the name a Llama tag carries: the `>` that closes the tag, or a space, which no name holds. */
const NAME_END = /[>\s]/g;

/** Llama's opening tags: `<function=name>`, the name anything but a space, up to the `>`. */
function llamaTags(text: string): OpeningTags {
  const seek = seeker(text, ["<function="]);
  return (from) => {
    for (let tag = seek(from); tag; ) {
      NAME_END.lastIndex = tag.end;
      const stop = NAME_END.exec(text);
      // No name ends from here on, so no tag does.
      if (!stop) return null;
      if (stop[0] === ">" && stop.index > tag.end) return { at: tag.at, body: stop.index + 1, name: text.slice(tag.end, stop.index) };
      // A tag that starts inside this name would end where it does, on what closes no tag: the search goes on from there.
      tag = seek(stop.index);
    }
    return null;
  };
}

/** The name an XML tag of Claude's carries, and the tag's end. */
const NAME_ATTRIBUTE = /\s+name="([^"]+)"\s*>/y;
/** A DeepSeek call's head: the tool's name, after `function` and a separator (V3) or alone (V3.1), up to a separator or the line's end. */
const DEEPSEEK_NAME = /(?:function<｜tool▁sep｜>)?([^\n<]+?)(?:<｜tool▁sep｜>|\n)/y;
/** The rest of the line a code fence opens on: its language, where it names one. */
const FENCE_LINE = /[A-Za-z_]*[ \t]*\n/y;

/** The namespace a tag of Claude's XML form may carry before its name. */
const NAMESPACE = "antml:";

/** A tag pair of Claude's XML form, each tag written with or without its namespace; `head` reads the rest of an opening tag that carries a name. */
function xml(name: string, head?: RegExp): Form {
  const opens = head ? name : `${name}>`;
  return { open: tagged([`<${opens}`, `<${NAMESPACE}${opens}`], head), close: [`</${name}>`, `</${NAMESPACE}${name}>`] };
}

/** DeepSeek's own call tokens, leaked into text: `function<｜tool▁sep｜>name` and a fenced JSON (V3), or `name<｜tool▁sep｜>JSON` (V3.1). */
const DEEPSEEK_CALL: Form = { open: tagged(["<｜tool▁call▁begin｜>"], DEEPSEEK_NAME), close: ["<｜tool▁call▁end｜>"] };
/** Hermes and Qwen's form, and the one the shipped tools-as-text file asks for. */
const TAGGED_CALL: Form = { open: tagged(["<tool_call>"]), close: ["</tool_call>"] };
/** Claude's XML form: the calls of one answer, each an `invoke` that names its tool and holds a `parameter` per argument. */
const FUNCTION_CALLS = xml("function_calls");
const INVOKE = xml("invoke", NAME_ATTRIBUTE);
const PARAMETER = xml("parameter", NAME_ATTRIBUTE);
/** Llama's `<function=name>{…}</function>`. */
const LLAMA_CALL: Form = { open: llamaTags, close: ["</function>"] };
/** A code fence that holds a call as JSON. */
const FENCED: Form = { open: tagged(["```"], FENCE_LINE), close: ["```"] };
/** What's left of a wrapper once the calls in it are taken out. */
const LEFTOVERS = /<｜tool▁calls▁begin｜>|<｜tool▁calls▁end｜>|<(?:antml:)?function_calls>\s*<\/(?:antml:)?function_calls>/g;

/** Every block of `form` in `text`, in order, none inside another: each is looked for from where the one before it ended. */
function blocksOf(text: string, form: Form): Block[] {
  const open = form.open(text);
  const close = seeker(text, form.close);
  const out: Block[] = [];
  for (let opened = open(0); opened; ) {
    const closed = close(opened.body);
    // No closing tag from here on, so none for any opening tag after this one: the form is done with.
    if (!closed) break;
    out.push({ start: opened.at, end: closed.end, name: opened.name, body: text.slice(opened.body, closed.at) });
    opened = open(closed.end);
  }
  return out;
}

/** Space, read from where a search stands. */
const SPACE = /\s*/y;

/** Mistral's `[TOOL_CALLS]` and the JSON after it: a list or an object, taken to the last bracket of its kind in the text, since a JSON value that holds others ends on its outermost one. */
function mistralBlocks(text: string): Block[] {
  const seek = seeker(text, ["[TOOL_CALLS]"]);
  const closes = { "[": text.lastIndexOf("]"), "{": text.lastIndexOf("}") };
  const out: Block[] = [];
  for (let tag = seek(0); tag; ) {
    SPACE.lastIndex = tag.end;
    SPACE.exec(text);
    const at = SPACE.lastIndex;
    const opens = text[at];
    const close = opens === "[" || opens === "{" ? closes[opens] : -1;
    // No value here (no bracket, or one that nothing closes): a later `[TOOL_CALLS]` may still hold one.
    if (close <= at) {
      tag = seek(tag.end);
      continue;
    }
    out.push({ start: tag.at, end: close + 1, name: "", body: text.slice(at, close + 1) });
    tag = seek(close + 1);
  }
  return out;
}

/** What may stand before a DeepSeek call's arguments: space, and the opening of a code fence. */
const FENCE_OPENS = /^\s*(?:```(?:json)?\s*)?/;

/** A DeepSeek call's arguments, without the space and the code fence V3 wraps them in. */
function unfenced(body: string): string {
  const args = body.replace(FENCE_OPENS, "").trimEnd();
  return args.endsWith("```") ? args.slice(0, -3).trimEnd() : args;
}

/**
 * The calls a model wrote as text, in the forms models write them, each naming a tool the agent has;
 * and its text without them. A block that names another tool or doesn't parse stays in the text, and
 * a whole answer that is one JSON call counts only when nothing else did.
 */
export function writtenCalls(text: string, names: ReadonlySet<string>): { calls: WrittenCall[]; rest: string } {
  const calls: WrittenCall[] = [];
  let rest = text;
  // Each form's blocks that read as calls are taken out of the text, in turn; the rest stay.
  const take = (blocks: readonly Block[], read: (block: Block) => WrittenCall[] | null): void => {
    let kept = "";
    let from = 0;
    for (const block of blocks) {
      const found = read(block);
      if (!found) continue;
      calls.push(...found);
      kept += rest.slice(from, block.start);
      from = block.end;
    }
    if (from > 0) rest = kept + rest.slice(from);
  };
  const named = (name: string, args: string): WrittenCall[] | null => {
    const read = writtenArgs(args);
    return names.has(name) && read ? [{ name, args: read }] : null;
  };
  const json = ({ body }: Block): WrittenCall[] | null => callsFromJson(parsed(body.trim()), names);
  take(blocksOf(rest, DEEPSEEK_CALL), ({ name, body }) => named(name.trim(), unfenced(body)));
  take(blocksOf(rest, TAGGED_CALL), json);
  take(blocksOf(rest, FUNCTION_CALLS), ({ body }) => {
    const invoked = blocksOf(body, INVOKE).map(({ name, body: inner }) => ({ name, args: Object.fromEntries(blocksOf(inner, PARAMETER).map(({ name: key, body: value }) => [key, writtenValue(value)])) as JsonObject }));
    return invoked.length > 0 && invoked.every((c) => names.has(c.name)) ? invoked : null;
  });
  take(blocksOf(rest, LLAMA_CALL), ({ name, body }) => named(name, body.trim()));
  take(mistralBlocks(rest), json);
  take(blocksOf(rest, FENCED), json);
  if (calls.length === 0) {
    const whole = callsFromJson(parsed(rest.trim()), names);
    if (whole) return { calls: whole, rest: "" };
  }
  return { calls, rest: calls.length > 0 ? rest.replace(LEFTOVERS, "").trim() : text };
}

/**
 * An answer of a call whose tools went as text, with the calls its text holds made its calls: its
 * thinking, the rest of its text, then each call, ids from `id`, and its stop a tool call's. An
 * answer whose text holds none is itself.
 */
export function withWrittenCalls(answer: AssistantMessage, tools: readonly Message[], id: () => string): AssistantMessage {
  if (answer.stopReason !== "stop" && answer.stopReason !== "length") return answer;
  const names = new Set(getCurrentTools(tools).map((tool) => tool.name));
  const text = contentText(answer.content.filter((part) => part.type === "text"));
  const { calls, rest } = writtenCalls(text, names);
  if (calls.length === 0) return answer;
  const made: ToolCall[] = calls.map((call) => ({ type: "toolCall", id: id(), name: call.name, arguments: call.args }));
  const kept = answer.content.filter((part) => part.type !== "text");
  return { ...answer, content: [...kept, ...(rest !== "" ? [{ type: "text" as const, text: rest }] : []), ...made], stopReason: "toolUse" };
}
