// A call's tokens, as Build 1 counted them: what was sent (with what of it the provider read from its
// cache and wrote to it), and what was written and how much of that was reasoning. What the provider
// didn't report is the call's own estimate, from its text at a number of characters per token, and is
// flagged as one. Calls are counted in tokens alone: no price, published or billed, makes a cost.

import { afterEach, describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { ConnectionInput, PromptMessage } from "../../src/contract";
import { promptMessages } from "../../src/harness/prompt";
import { callUsage, estimateOf, promptTokens, requestTokens, tokensOf } from "../../src/model";
import type { Rig, Script } from "./support";
import { anthropicStream, anthropicTurn, call, chatStream, chunk, eventStream, rig, USER } from "./support";

/** An estimate never the answer here, so that a count taken from it shows. */
const GUESS = { in: 1, out: 1, reasoningOut: 1 };
const ASK: Message[] = [{ role: "user", content: "Where is Ilse?", timestamp: 1 }];

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** The answer a call on `connection` gets when its provider answers as `script` does, and the model it went to. */
async function answered(script: Script, connection: ConnectionInput, key?: string): Promise<{ answer: AssistantMessage; model: Model<Api> }> {
  r = rig({ script });
  const saved = await r.layer.api.save(USER, connection, key);
  const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" });
  const answer = await call(agent, ASK);
  expect(answer.errorMessage).toBeUndefined();
  return { answer, model: agent.model };
}

/** A chat-completions stream ending in `usage`, as a server that reports its usage sends it. */
function chatWithUsage(usage: Record<string, unknown>): Script {
  return () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop"), { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [], usage }]));
}

describe("a call's tokens, from what its provider reported", () => {
  test("Anthropic: everything sent, the cache's reads and writes, and what was written; a model with a published price is given no cost", async () => {
    const { answer, model } = await answered(() => eventStream(anthropicStream(anthropicTurn({ text: "At the quay.", usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 50 } }))), { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, "sk-ant-api03-0123456789abcdef");
    // Anthropic reported no reasoning count, so that one is the estimate.
    expect(callUsage(answer, model, GUESS)).toEqual({ in: 1050, cachedIn: 900, cacheWrite: 50, out: 40, reasoningOut: 1, estimated: ["reasoningOut"] });
  });

  test("an OpenAI-compatible server: everything sent, its cache's reads, what was written and its reasoning", async () => {
    const { answer, model } = await answered(chatWithUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 50 } }), {
      name: "Local",
      provider: "openai-compatible",
      auth: "none",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "served-model",
    });
    expect(callUsage(answer, model, GUESS)).toEqual({ in: 1000, cachedIn: 600, out: 200, reasoningOut: 50, estimated: [] });
  });

  test("DeepSeek: its cache's reads under its own name, and no cost", async () => {
    const { answer, model } = await answered(chatWithUsage({ prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100, prompt_cache_hit_tokens: 1500 }), { name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-v4-pro" }, "sk-deepseek-0123456789abcdef");
    expect(callUsage(answer, model, GUESS)).toEqual({ in: 2000, cachedIn: 1500, out: 100, reasoningOut: 0, estimated: [] });
  });

  test("OpenRouter: the bill it sends with the counts is not taken up", async () => {
    const { answer, model } = await answered(chatWithUsage({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.0042, is_byok: false }), { name: "Router", provider: "openrouter", auth: "key", model: "deepseek/deepseek-v4-flash" }, "sk-or-v1-0123456789abcdefghijklmn");
    expect(callUsage(answer, model, GUESS)).toEqual({ in: 10, cachedIn: 0, out: 10, reasoningOut: 0, estimated: [] });
  });
});

describe("a call's tokens its provider didn't report", () => {
  const usage = (fields: Partial<Usage>): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...fields });
  const answer = (u: Usage, content: AssistantMessage["content"] = []): AssistantMessage => ({ role: "assistant", content, api: "openai-completions", provider: "x", model: "m", usage: u, stopReason: "stop", timestamp: 1 });

  test("a server that sends no usage at all: every count is the estimate", () => {
    const estimate = { in: 120, out: 30, reasoningOut: 10 };
    expect(callUsage(answer(usage({})), { api: "openai-completions" }, estimate)).toEqual({ in: 120, cachedIn: 0, out: 40, reasoningOut: 10, estimated: ["in", "cachedIn", "out", "reasoningOut"] });
  });

  test("the estimate is the call's text at the characters per token given, each message's rounded up, the tools its system messages add counted in", () => {
    const tool = { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: {} } };
    const sent: Message[] = [
      { role: "system", content: "You narrate.", sections: { scene: "The quay.", gone: null }, toolsAdded: [tool], timestamp: 1 },
      { role: "user", content: "Where is Ilse?", timestamp: 1 },
    ];
    const systemText = ["You narrate.", "The quay.", `lookup Looks a thing up. ${JSON.stringify(tool.parameters)}`].join("\n");
    expect(promptTokens(sent, 4)).toBe(Math.ceil(systemText.length / 4) + Math.ceil("Where is Ilse?".length / 4));
    expect(tokensOf("At the quay.", 3.2)).toBe(4);
    const said = answer(usage({}), [
      { type: "thinking", thinking: "Ilse sails at dawn." },
      { type: "text", text: "At the quay." },
    ]);
    expect(estimateOf(sent, said, 4)).toEqual({ in: promptTokens(sent, 4), out: 3, reasoningOut: 5 });
  });
});

describe("an estimate before a provider counts", () => {
  test("an estimate starts from the last call's reported input and adds the new text at the setting's ratio", () => {
    const opening: Message = { role: "system", content: "You narrate the harbour.", timestamp: 1 };
    const asked: Message = { role: "user", content: "Where is Ilse?", timestamp: 1 };
    const sent = [opening, asked];
    const said: Message = { role: "assistant", content: [{ type: "text", text: "At the quay, mending nets." }], api: "openai-completions", provider: "x", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 };
    const more: Message = { role: "user", content: "And the keeper?", timestamp: 3 };
    const counted = { messages: sent, tokens: 900 };
    // The provider said the first request was 900 tokens: only what came after it is estimated, at the ratio given.
    expect(requestTokens([...sent, said, more], 2, counted)).toBe(900 + Math.ceil("At the quay, mending nets.".length / 2) + Math.ceil("And the keeper?".length / 2));
    expect(requestTokens([...sent, said, more], 4, counted)).toBe(900 + Math.ceil("At the quay, mending nets.".length / 4) + Math.ceil("And the keeper?".length / 4));
    // A request that no longer goes on from the counted one (a message put in place of one it was sent) is estimated whole.
    const replaced: Message = { role: "user", content: "Where is Ilse?", timestamp: 1 };
    expect(requestTokens([opening, replaced, said], 2, counted)).toBe(promptTokens([opening, replaced, said], 2));
    // With no count, every message is estimated.
    expect(requestTokens([...sent, said], 2)).toBe(promptTokens([...sent, said], 2));
  });

  test("the model port gives the model's window as pi reports it, and its count of a prompt is the count RPH's fit check makes of the same messages, at the chat's ratio, from the provider's count where there is one", async () => {
    r = rig({ chats: { "chat-tight": "tokens:\n  charsPerToken: 2\n" } });
    const saved = await r.layer.api.save(USER, { name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-flash" }, "sk-deepseek-0123456789abcdef");
    const limits = await r.layer.api.limits(USER, saved.id);
    const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" });
    expect(limits.contextWindow).toEqual({ tokens: agent.model.contextWindow, from: "pi" });
    const prompt: PromptMessage[] = [
      { role: "system", content: [{ type: "text", text: "The tide turns at dusk." }, { type: "text", text: " Ilse knows it." }] },
      { role: "user", content: [{ type: "text", text: "Look at this chart." }, { type: "image", data: "aGFyYm91cg==", mimeType: "image/png" }, { type: "text", text: "Where is the reef?" }] },
      { role: "assistant", content: "North of the light." },
    ];
    // No provider has counted a host's prompt: the whole is estimated, exactly as the fit check estimates the messages pi's loop is given, at each chat's ratio.
    const fit = (ratio: number): number => promptTokens(promptMessages(prompt, agent.model, 0).messages, ratio);
    expect(await r.layer.api.count({ user: USER, chat: "chat-tight", session: "session-a" }, saved.id, prompt)).toBe(fit(2));
    expect(await r.layer.api.count({ user: USER, chat: "chat-plain", session: "session-b" }, saved.id, prompt)).toBe(fit(3.2));
    expect(fit(2)).not.toBe(fit(3.2));
  });
});
