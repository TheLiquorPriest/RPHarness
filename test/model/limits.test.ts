// A model's limits come from pi's catalogue where it lists the model; for one it doesn't, from what
// the connection's server reported, else nobody knows them, and whoever needs one is told so. What
// the user entered governs either way. Each limit is found on its own, and a call never asks more
// room than its model can write.

import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { limitsOf } from "../../src/model";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, call, chatStream, chunk, eventStream, json, rig } from "./support";

const KEY = "sk-deepseek-0123456789abcdef";

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

function listed(id: string): Model<Api> {
  const model = deepseekProvider()
    .getModels()
    .find((m) => m.id === id);
  if (model === undefined) throw new Error(`pi lists no ${id}`);
  return model;
}

describe("a model pi's catalogue lists", () => {
  test("has the window and the longest reply pi gives it, and the agent's model carries them", async () => {
    r = rig();
    const saved = await r.layer.api.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-flash" }, KEY);
    const pi = listed("deepseek-flash");
    expect(await r.layer.api.limits(saved.id)).toEqual({ contextWindow: { tokens: pi.contextWindow, from: "pi" }, maxTokens: { tokens: pi.maxTokens, from: "pi" } });
    const agent = await r.layer.agentModel({ connectionId: saved.id, model: null });
    expect([agent.model.contextWindow, agent.model.maxTokens]).toEqual([pi.contextWindow, pi.maxTokens]);
    // What pi lists for DeepSeek's own API today, as the plan expects it to read them.
    expect([pi.contextWindow, pi.maxTokens]).toEqual([1_000_000, 384_000]);
  });

  test("takes what the user entered where they entered it, and pi's for the other", async () => {
    r = rig();
    const saved = await r.layer.api.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-flash", limits: { "deepseek-flash": { contextWindow: 64_000 } } }, KEY);
    expect(await r.layer.api.limits(saved.id)).toEqual({ contextWindow: { tokens: 64_000, from: "user" }, maxTokens: { tokens: listed("deepseek-flash").maxTokens, from: "pi" } });
  });
});

describe("a model pi's catalogue doesn't list", () => {
  test("has no limit at all where nobody gave one: DeepSeek's own API lists deepseek-flash, not deepseek-v4-flash", async () => {
    r = rig();
    const saved = await r.layer.api.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-v4-flash" }, KEY);
    expect(deepseekProvider().getModels().map((m) => m.id)).not.toContain("deepseek-v4-flash");
    expect(await r.layer.api.limits(saved.id)).toEqual({ contextWindow: null, maxTokens: null });
    const agent = await r.layer.agentModel({ connectionId: saved.id, model: null });
    expect([agent.model.contextWindow, agent.model.maxTokens]).toEqual([0, 0]);
    expect(agent.limits).toEqual({ contextWindow: null, maxTokens: null });
  });

  test("with no longest reply known and no room asked, a call on an OpenAI-style API sends no cap at all, so the provider's own default stands; a room asked is sent", async () => {
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop")])) });
    const saved = await r.layer.api.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-v4-flash" }, KEY);
    const agent = await r.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" });
    const ask: Message[] = [{ role: "user", content: "Ready?", timestamp: 1 }];
    await call(agent, ask);
    await call(agent, ask, { maxTokens: 300 });
    const [uncapped, capped] = r.sent.map((s) => bodyOf(s));
    expect(Object.keys(uncapped ?? {}).filter((k) => k.startsWith("max_"))).toEqual([]);
    expect(capped?.max_tokens).toBe(300);
  });

  test("takes what the user entered for it", async () => {
    r = rig();
    const saved = await r.layer.api.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-v4-flash", limits: { "deepseek-v4-flash": { contextWindow: 1_000_000, maxTokens: 384_000 } } }, KEY);
    expect(await r.layer.api.limits(saved.id)).toEqual({ contextWindow: { tokens: 1_000_000, from: "user" }, maxTokens: { tokens: 384_000, from: "user" } });
  });

  test("takes what its server reported when it listed its models, each limit by the name that server gives it", async () => {
    r = rig({
      script: () =>
        json({
          object: "list",
          data: [
            { id: "harbour-7b", object: "model", max_model_len: 32_768 },
            { id: "routed-model", context_length: 131_072, top_provider: { context_length: 131_072, max_completion_tokens: 16_384 } },
            { id: "quiet-model" },
          ],
        }),
    });
    const saved = await r.layer.api.save({ name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "harbour-7b" });
    expect(await r.layer.api.limits(saved.id)).toEqual({ contextWindow: null, maxTokens: null });
    expect((await r.layer.api.models(saved.id)).map((m) => m.id)).toEqual(["harbour-7b", "routed-model", "quiet-model"]);
    expect(r.sent[0]?.url).toBe("http://127.0.0.1:8080/v1/models");
    expect(await r.layer.api.limits(saved.id)).toEqual({ contextWindow: { tokens: 32_768, from: "connection" }, maxTokens: null });
    expect(await r.layer.api.limits(saved.id, "routed-model")).toEqual({ contextWindow: { tokens: 131_072, from: "connection" }, maxTokens: { tokens: 16_384, from: "connection" } });
    expect(await r.layer.api.limits(saved.id, "quiet-model")).toEqual({ contextWindow: null, maxTokens: null });
    // What the user enters still governs what the server said.
    await r.layer.api.save({ id: saved.id, name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "harbour-7b", limits: { "harbour-7b": { contextWindow: 16_384 } } });
    expect((await r.layer.api.limits(saved.id)).contextWindow).toEqual({ tokens: 16_384, from: "user" });
    // A server at another address reported none of it.
    await r.layer.api.save({ id: saved.id, name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.2:8080/v1", model: "routed-model" });
    expect(await r.layer.api.limits(saved.id)).toEqual({ contextWindow: null, maxTokens: null });
  });

  test("with no longest reply known, a call on Anthropic's API, which must be told one, says so and sends nothing; given one, it is sent", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ model: "harbour-claude", text: "At the mill." }))) });
    const proxy = { name: "Proxy", provider: "anthropic-compatible", auth: "none", baseUrl: "http://127.0.0.1:9090", model: "harbour-claude" } as const;
    const saved = await r.layer.api.save(proxy);
    const ask: Message[] = [{ role: "user", content: "Where is Ilse?", timestamp: 1 }];
    const answer = await call(await r.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" }), ask);
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toBe('Nobody has said how long a reply "harbour-claude" can write, and Anthropic\'s API must be told: enter it for the connection "Proxy" on the Connections page.');
    expect(r.sent).toEqual([]);
    await r.layer.api.save({ ...proxy, id: saved.id, limits: { "harbour-claude": { maxTokens: 2_048 } } });
    expect((await call(await r.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" }), ask)).stopReason).toBe("stop");
    expect(bodyOf(r.sent[0]).max_tokens).toBe(2_048);
  });
});

describe("a call's room", () => {
  test("is never more than the model's longest reply, and is that where the call names none", async () => {
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop")])) });
    const saved = await r.layer.api.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-v4-flash", limits: { "deepseek-v4-flash": { maxTokens: 8_000 } } }, KEY);
    const agent = await r.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" });
    const ask: Message[] = [{ role: "user", content: "Ready?", timestamp: 1 }];
    await call(agent, ask, { maxTokens: 900_000 });
    await call(agent, ask);
    await call(agent, ask, { maxTokens: 300 });
    expect(r.sent.map((s) => bodyOf(s).max_tokens)).toEqual([8_000, 8_000, 300]);
  });
});

describe("limits, each found on its own", () => {
  test("the user's entry first, then pi's, then the server's report; a number of 0 is none", () => {
    expect(limitsOf({ contextWindow: 200_000, maxTokens: 0 }, { contextWindow: 100_000, maxTokens: 8_192 }, { maxTokens: 4_096 })).toEqual({ contextWindow: { tokens: 200_000, from: "pi" }, maxTokens: { tokens: 4_096, from: "user" } });
    expect(limitsOf({ contextWindow: 0, maxTokens: 0 }, { maxTokens: 8_192 }, undefined)).toEqual({ contextWindow: null, maxTokens: { tokens: 8_192, from: "connection" } });
  });
});
