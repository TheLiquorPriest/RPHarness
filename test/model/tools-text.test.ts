// Tools as text (tools-text.ts): a provider that refuses native tools is sent the same call at once
// with them as text, in the words of RPH's shipped `.prompts/tools-as-text.md`, and its model is
// offered them so until `calls.toolRefusalMinutes` has passed; an agent set to text is offered them
// as text from its first call; the calls a model writes, in the file's form and the forms models
// write by themselves, are its calls; and its earlier calls and their answers go back in the file's
// words.

import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import type { Fields } from "../../src/files/api";
import type { ToolsAs } from "../../src/contract";
import { writtenCalls } from "../../src/model/tools-text";
import { shippedParts } from "../prompt/support";
import type { Rig, Script } from "./support";
import { bodyOf, call, chatStream, chunk, eventStream, failed, rig, USER } from "./support";

const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";
const LOOKUP: Tool = { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: { what: { type: "string" } } } };
const ASK: Message[] = [
  { role: "system", content: "You keep the harbour's records.", toolsAdded: [LOOKUP], timestamp: 1 },
  { role: "user", content: "Where is the bell?", timestamp: 1 },
];
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The words a server says when its model takes no tools. */
const REFUSAL = () => failed(400, { error: { message: "This model does not support tools.", type: "invalid_request_error" } });
/** An answer whose text holds a call written in the file's form. */
const WRITES_A_CALL = () => eventStream(chatStream([chunk({ role: "assistant", content: 'The records say:\n<tool_call>{"name": "lookup", "arguments": {"what": "the bell"}}</tool_call>' }), chunk({}, "stop")]));

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** RPH's shipped tools-as-text file, as the layer fills it in. */
async function shippedWords(): Promise<(fields: Fields) => string> {
  const part = await shippedParts().part("tools-as-text");
  if (part?.format !== "template") throw new Error(".prompts/tools-as-text.md is not a template");
  return (fields) => part.render(fields).text.trim();
}

/** A layer over a compatible server that answers as `script` does, the shipped words for tools as text, and an agent on it whose tools go as `toolsAs` says. */
async function agentOn(script: Script, toolsAs?: ToolsAs) {
  const made = rig({ script });
  r = made;
  made.texts.toolsText = await shippedWords();
  const saved = await made.layer.api.save(USER, { name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" }, SERVER_KEY);
  return { made, agent: await made.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off", ...(toolsAs !== undefined ? { toolsAs } : {}) }) };
}

/** What a request sent: whether it offered native tools, and its messages' texts. */
function sentOf(made: Rig, n: number): { tools: boolean; texts: string[] } {
  const body = bodyOf(made.sent[n]);
  return { tools: Array.isArray(body.tools), texts: (body.messages as { content: unknown }[]).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))) };
}

/** The calls an answer holds, by name and arguments. */
function callsOf(answer: AssistantMessage): [string, unknown][] {
  return answer.content.flatMap((part) => (part.type === "toolCall" ? [[part.name, part.arguments] as [string, unknown]] : []));
}

describe("tools as text", () => {
  test("a provider that refuses tools gets the same call with tools as text; native tools are tried again after the set time", async () => {
    const { made, agent } = await agentOn((sent) => (Array.isArray(bodyOf(sent).tools) ? REFUSAL() : WRITES_A_CALL()));
    const answer = await call(agent, ASK);
    expect([answer.stopReason, callsOf(answer)]).toEqual(["toolUse", [["lookup", { what: "the bell" }]]]);
    expect(answer.content.find((part) => part.type === "text")).toEqual({ type: "text", text: "The records say:" });
    expect(made.sent.map((_, n) => sentOf(made, n).tools)).toEqual([true, false]);
    expect(sentOf(made, 1).texts[0]).toContain("You can use tools. To call one, write a block like this and stop there:");
    expect(sentOf(made, 1).texts[0]).toContain("lookup: Looks a thing up.");
    // Within the set time, straight away as text; once it has passed, natively again.
    await call(agent, ASK);
    expect(sentOf(made, 2).tools).toBe(false);
    made.clock.advance(60 * 60_000);
    await call(agent, ASK);
    expect([sentOf(made, 3).tools, sentOf(made, 4).tools]).toEqual([true, false]);
  });

  test("the tools as text are the file's words; an edited file changes the next request; earlier calls and their answers go back in its words", async () => {
    const { made, agent } = await agentOn(WRITES_A_CALL, "text");
    const earlier: Message[] = [
      ...ASK,
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { what: "the tide" } }], api: "openai-completions", provider: "openai-compatible", model: "served-model", usage: USAGE, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "lookup", content: [{ type: "text", text: "High water at six." }], isError: false, timestamp: 2 },
    ];
    await call(agent, earlier);
    const first = sentOf(made, 0);
    expect(first.texts).toContain('<tool_call>{"name":"lookup","arguments":{"what":"the tide"}}</tool_call>');
    expect(first.texts).toContain('What your tool calls answered:\n\n<tool_result name="lookup">\nHigh water at six.\n</tool_result>');
    made.texts.toolsText = (fields) => (fields.offered !== undefined ? "Fixture: write CALL lookup to look things up." : "");
    await call(agent, ASK);
    expect(sentOf(made, 1).texts[0]).toContain("Fixture: write CALL lookup to look things up.");
    expect(sentOf(made, 1).texts[0]).not.toContain("You can use tools.");
  });

  test("an agent set to text is offered its tools as text from its first call; one set to native fails on a refusal", async () => {
    const { made, agent } = await agentOn(WRITES_A_CALL, "text");
    expect(callsOf(await call(agent, ASK))).toEqual([["lookup", { what: "the bell" }]]);
    expect(made.sent.map((_, n) => sentOf(made, n).tools)).toEqual([false]);
    await made.done();
    const native = await agentOn(REFUSAL, "native");
    expect((await call(native.agent, ASK)).stopReason).toBe("error");
    expect(native.made.sent.length).toBe(1);
  });
});

describe("calls read back from text", () => {
  const names = new Set(["lookup", "note"]);
  test("each form a model writes is run as its call, and what is not a call stays text", () => {
    const forms: [string, string][] = [
      ["the file's form, Hermes's and Qwen's", 'Looking.\n<tool_call>{"name": "lookup", "arguments": {"what": "bell"}}</tool_call>'],
      ["Claude's XML", 'Looking.\n<function_calls><invoke name="lookup"><parameter name="what">bell</parameter></invoke></function_calls>'],
      ["Llama's", 'Looking.\n<function=lookup>{"what": "bell"}</function>'],
      ["Mistral's", 'Looking.\n[TOOL_CALLS] [{"name": "lookup", "arguments": {"what": "bell"}}]'],
      ["DeepSeek's leaked tokens", 'Looking.\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>lookup\n```json\n{"what": "bell"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>'],
      ["a fenced JSON", 'Looking.\n```json\n{"name": "lookup", "arguments": {"what": "bell"}}\n```'],
    ];
    for (const [form, text] of forms) expect([form, writtenCalls(text, names)]).toEqual([form, { calls: [{ name: "lookup", args: { what: "bell" } }], rest: "Looking." }]);
    expect(writtenCalls('{"name": "note", "arguments": {"text": "two bells"}}', names)).toEqual({ calls: [{ name: "note", args: { text: "two bells" } }], rest: "" });
    // A tool the agent hasn't, a block that doesn't parse, a tool's description: text.
    for (const text of ['<tool_call>{"name": "sink_ship", "arguments": {}}</tool_call>', "<tool_call>{not json}</tool_call>", '{"name": "lookup", "description": "Looks a thing up."}', "The bell rang twice."]) expect(writtenCalls(text, names)).toEqual({ calls: [], rest: text });
  });
});
