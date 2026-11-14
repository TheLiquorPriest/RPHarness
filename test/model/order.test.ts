// A prompt a chat application assembled has system messages at its start, in its middle (a note at
// depth) and at its end (an instruction after the history). An agent's call goes out with each one
// where it stood: on OpenAI-style APIs as a system message in its place, on Anthropic's as a user's
// message in its place, and never moved to the top. What is checked is the request as it left for
// the provider, run through pi's own Agent. Without the layer's override pi-ai moves them, which the
// last two tests show on the same prompt.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, chatStream, chunk, eventStream, rig, scriptedFetch, textOf } from "./support";

const OPENING = "You are the Author of a story set in a harbour town.";
const PRESET = "Narrate the harbour town in the second person.";
const CARD = "Okoro keeps the harbour ledger.";
const NOTE = "(The tide is out.)";
const AFTER = "Write two short paragraphs.";

/** A reply the chat already holds, as its history carries it. */
function said(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "history", model: "history", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 };
}

/** The assembled prompt: two system messages at its start, one in its middle, one at its end. */
const PROMPT: Message[] = [
  { role: "system", content: PRESET, timestamp: 1 },
  { role: "system", content: CARD, timestamp: 1 },
  { role: "user", content: "Where is Ilse?", timestamp: 1 },
  said("At the mill."),
  { role: "system", content: NOTE, timestamp: 1 },
  { role: "user", content: "And now?", timestamp: 1 },
  { role: "system", content: AFTER, timestamp: 1 },
];

const LOOKUP: AgentTool = {
  name: "lookup",
  label: "Lookup",
  description: "Looks a thing up.",
  parameters: { type: "object", properties: { what: { type: "string" } } },
  execute: async () => ({ content: [{ type: "text", text: "found" }], details: {} }),
};

/** What a request's messages say, in order: each one's role and text, leaving out what says nothing (pi-ai's own effort marks). */
function spoken(messages: unknown): [string, string][] {
  return (messages as { role: string; content: unknown }[]).map((m): [string, string] => [m.role, textOf(m.content)]).filter(([, text]) => text !== "");
}

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** Runs the prompt through pi's Agent on the layer's model for `connection`, its opening block the system prompt, and gives back the request that left. */
async function sent(made: Rig, connection: string): Promise<Record<string, unknown>> {
  const agent = await made.layer.agentModel({ connectionId: connection, model: null, effort: "off" });
  const run = new Agent({ initialState: { systemPrompt: OPENING, model: agent.model, thinkingLevel: agent.thinkingLevel, tools: [LOOKUP] }, streamFn: agent.streamFn });
  await run.prompt(PROMPT as AgentMessage[]);
  expect(run.state.errorMessage).toBeUndefined();
  expect(made.sent.length).toBe(1);
  return bodyOf(made.sent[0]);
}

describe("an agent's call keeps every system message where it stood", () => {
  test("on Anthropic's API: the leading ones are the system prompt, in order; the middle and the last are the user's turns where they stood", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "The tide turns." }))) });
    const saved = await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, "sk-ant-api03-0123456789abcdef");
    const body = await sent(r, saved.id);
    expect(textOf(body.system)).toBe(`${OPENING}\n\n${PRESET}\n\n${CARD}`);
    expect(spoken(body.messages)).toEqual([
      ["user", "Where is Ilse?"],
      ["assistant", "At the mill."],
      ["user", NOTE],
      ["user", "And now?"],
      ["user", AFTER],
    ]);
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(["lookup"]);
  });

  test("where a system message goes as a user's message, it goes with the host's mark, and unmarked where the host gives none", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "The tide turns." }))), markNote: (text) => `[Fixture mark] ${text}` });
    const saved = await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, "sk-ant-api03-0123456789abcdef");
    expect(spoken((await sent(r, saved.id)).messages)).toEqual([
      ["user", "Where is Ilse?"],
      ["assistant", "At the mill."],
      ["user", `[Fixture mark] ${NOTE}`],
      ["user", "And now?"],
      ["user", `[Fixture mark] ${AFTER}`],
    ]);
  });

  test("on an Anthropic model that takes system messages itself, which pi-ai would hold back until the next answer: the same, in place", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ model: "claude-opus-5", text: "The tide turns." }))) });
    const saved = await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-opus-5" }, "sk-ant-api03-0123456789abcdef");
    const body = await sent(r, saved.id);
    expect(textOf(body.system)).toBe(`${OPENING}\n\n${PRESET}\n\n${CARD}`);
    expect(spoken(body.messages)).toEqual([
      ["user", "Where is Ilse?"],
      ["assistant", "At the mill."],
      ["user", NOTE],
      ["user", "And now?"],
      ["user", AFTER],
    ]);
  });

  test("on chat completions (DeepSeek): each one a system message in its place", async () => {
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "The tide turns." }), chunk({}, "stop")])) });
    const saved = await r.layer.api.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-flash" }, "sk-deepseek-0123456789abcdef");
    const body = await sent(r, saved.id);
    expect(spoken(body.messages)).toEqual([
      ["system", `${OPENING}\n\n${PRESET}\n\n${CARD}`],
      ["user", "Where is Ilse?"],
      ["assistant", "At the mill."],
      ["system", NOTE],
      ["user", "And now?"],
      ["system", AFTER],
    ]);
  });

  test("on an OpenAI-compatible server: the same, with the `system` role every server knows", async () => {
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "The tide turns." }), chunk({}, "stop")])) });
    const saved = await r.layer.api.save({ name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" });
    const body = await sent(r, saved.id);
    expect(r.sent[0]?.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(spoken(body.messages).map(([role]) => role)).toEqual(["system", "user", "assistant", "system", "user", "system"]);
    expect(spoken(body.messages)[3]).toEqual(["system", NOTE]);
  });
});

describe("pi-ai on its own, with the same prompt", () => {
  /** The request pi-ai sends for the transcript an agent's would be, with no override. */
  async function plain(model: string): Promise<Record<string, unknown>> {
    const { fetch, sent: requests } = scriptedFetch(() => eventStream(anthropicStream(anthropicTurn({ model, text: "The tide turns." }))));
    const pi = createModels();
    pi.setProvider(anthropicProvider());
    const listed = pi.getModel("anthropic", model);
    if (listed === undefined) throw new Error(`pi-ai lists no ${model}`);
    const context = normalizeContext({ systemPrompt: OPENING, messages: PROMPT });
    await pi.streamSimple(listed, context, { apiKey: "sk-ant-api03-0123456789abcdef", fetch, maxRetries: 0 }).result();
    return bodyOf(requests[0]);
  }

  test("moves every later system message to the top where the model takes none mid-conversation", async () => {
    const body = await plain("claude-sonnet-4-5");
    expect(textOf(body.system)).toBe([OPENING, PRESET, CARD, NOTE, AFTER].join("\n\n"));
    expect(spoken(body.messages)).toEqual([
      ["user", "Where is Ilse?"],
      ["assistant", "At the mill."],
      ["user", "And now?"],
    ]);
  });

  test("holds a later system message back past the user's message that followed it, where the model takes them", async () => {
    const body = await plain("claude-opus-5");
    const order = spoken(body.messages).map(([, text]) => text);
    expect(order.indexOf(NOTE)).toBeGreaterThan(order.indexOf("And now?"));
  });
});
