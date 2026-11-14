// What a call sends its provider: the room it may write in (its thinking within it), the effort as
// the provider takes it (`off` none; a level as pi-ai's, or the nearest the model takes; `auto` and
// `inherit` the connection's own, else the provider's default), the sampling parameters the
// provider takes and none it would refuse, one tool per answer when the connection asks it, and the
// prompt cache as the call asks. And what a failed call says: the provider's words with the status
// first, never a key or a header's value the layer holds, and what to do when the connection can't
// be used; pi-ai never tries again on its own.

import { afterEach, describe, expect, test } from "bun:test";
import type { Message, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { ConnectionInput } from "../../src/contract";
import type { ModelEffort } from "../../src/model";
import type { Rig, Script } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, call, chatStream, chunk, eventStream, failed, rig } from "./support";

const ANTHROPIC_KEY = "sk-ant-api03-Ilse0123456789abcdefOkoro";
const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";
const LOOKUP: Tool = { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: { what: { type: "string" } } } };
/** Every sampling parameter, as a preset sets them: `temperature` apart, as pi's loop passes it. */
const EVERY: SimpleStreamOptions = { temperature: 0.7, samplingParams: { top_p: 0.9, top_k: 40, min_p: 0.05, frequency_penalty: 0.3, presence_penalty: 0.2, repetition_penalty: 1.1, seed: 7, stop: ["THE END"] } };
const ASK: Message[] = [
  { role: "system", content: "You narrate a harbour town.", toolsAdded: [LOOKUP], timestamp: 1 },
  { role: "user", content: "Where is Ilse?", timestamp: 1 },
];

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** The body a call on a connection sent, the agent asking `effort`, the call asking `options`. */
async function bodyFor(script: Script, connection: ConnectionInput, key: string | undefined, effort: ModelEffort | undefined, options: SimpleStreamOptions = {}): Promise<Record<string, unknown>> {
  r = rig({ script });
  const saved = await r.layer.api.save(connection, key);
  const agent = await r.layer.agentModel({ connectionId: saved.id, model: null, ...(effort !== undefined ? { effort } : {}) });
  const answer = await call(agent, ASK, { ...options, ...(agent.thinkingLevel !== "off" ? { reasoning: agent.thinkingLevel } : {}) });
  expect(answer.errorMessage).toBeUndefined();
  return bodyOf(r.sent[0]);
}

const anthropicAnswer: Script = () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." })));
const claude = (model: string, more: Partial<ConnectionInput> = {}): ConnectionInput => ({ name: "Claude", provider: "anthropic", auth: "key", model, ...more });

describe("an Anthropic call", () => {
  test("with reasoning off takes the sampling Anthropic has, in its names, and none it hasn't; one tool per answer where the connection asks it", async () => {
    const body = await bodyFor(anthropicAnswer, claude("claude-sonnet-4-5", { serialTools: true }), ANTHROPIC_KEY, "off", { ...EVERY, maxTokens: 3000 });
    expect(body).toMatchObject({ model: "claude-sonnet-4-5", max_tokens: 3000, temperature: 0.7, top_p: 0.9, top_k: 40, stop_sequences: ["THE END"], thinking: { type: "disabled" }, tool_choice: { type: "auto", disable_parallel_tool_use: true } });
    for (const refused of ["min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed", "stop"]) expect(Object.keys(body)).not.toContain(refused);
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(["lookup"]);
  });

  test("that thinks to a budget keeps its thinking within the room it was given, and drops what thinking refuses", async () => {
    const body = await bodyFor(anthropicAnswer, claude("claude-sonnet-4-5"), ANTHROPIC_KEY, "high", { ...EVERY, maxTokens: 20_000 });
    expect(body.max_tokens).toBe(20_000);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16_384, display: "summarized" });
    for (const refused of ["temperature", "top_p", "top_k"]) expect(Object.keys(body)).not.toContain(refused);
    expect(body.stop_sequences).toEqual(["THE END"]);
  });

  test("on a model that chooses how long to think takes the level asked, or the nearest it has", async () => {
    expect((await bodyFor(anthropicAnswer, claude("claude-opus-4-7"), ANTHROPIC_KEY, "xhigh")).output_config).toEqual({ effort: "xhigh" });
    await r?.done();
    // claude-sonnet-4-6 has no `xhigh`: the nearest level it has is asked for.
    expect(await bodyFor(anthropicAnswer, claude("claude-sonnet-4-6"), ANTHROPIC_KEY, "xhigh")).toMatchObject({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" } });
  });

  test("`auto` and `inherit` take the connection's own effort, and with none the provider's default: no word of thinking at all", async () => {
    expect((await bodyFor(anthropicAnswer, claude("claude-opus-4-7", { effort: "low" }), ANTHROPIC_KEY, "auto")).output_config).toEqual({ effort: "low" });
    await r?.done();
    expect((await bodyFor(anthropicAnswer, claude("claude-opus-4-7", { effort: "low" }), ANTHROPIC_KEY, "inherit")).output_config).toEqual({ effort: "low" });
    await r?.done();
    const plain = await bodyFor(anthropicAnswer, claude("claude-opus-4-7"), ANTHROPIC_KEY, undefined);
    expect(Object.keys(plain)).not.toContain("thinking");
    expect(Object.keys(plain)).not.toContain("output_config");
  });

  test("marks the prompt cache as the call's retention says, and not at all for none", async () => {
    const kept = await bodyFor(anthropicAnswer, claude("claude-sonnet-4-5"), ANTHROPIC_KEY, "off", { cacheRetention: "long" });
    expect((kept.system as { cache_control?: unknown }[])[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    await r?.done();
    const none = await bodyFor(anthropicAnswer, claude("claude-sonnet-4-5"), ANTHROPIC_KEY, "off", { cacheRetention: "none" });
    expect(JSON.stringify(none)).not.toContain("cache_control");
  });
});

describe("a chat-completions call", () => {
  const chatAnswer: Script = () => eventStream(chatStream([chunk({ role: "assistant", content: "At the quay." }), chunk({}, "stop")]));

  test("to an OpenAI-compatible server takes every sampling parameter, and asks one tool per answer where the connection asks it", async () => {
    const body = await bodyFor(chatAnswer, { name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model", serialTools: true }, SERVER_KEY, "medium", EVERY);
    expect(r?.sent[0]?.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(body).toMatchObject({ model: "served-model", temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, frequency_penalty: 0.3, presence_penalty: 0.2, repetition_penalty: 1.1, seed: 7, stop: ["THE END"], parallel_tool_calls: false, reasoning_effort: "medium" });
  });

  test("to Groq leaves out what Groq refuses", async () => {
    const body = await bodyFor(chatAnswer, { name: "Groq", provider: "groq", auth: "key", model: "llama-3.3-70b-versatile" }, "gsk_0123456789abcdefghij", "off", EVERY);
    expect(body).toMatchObject({ temperature: 0.7, top_p: 0.9, frequency_penalty: 0.3, presence_penalty: 0.2, seed: 7, stop: ["THE END"] });
    for (const refused of ["top_k", "min_p", "repetition_penalty"]) expect(Object.keys(body)).not.toContain(refused);
  });
});

/** The words a call on an Anthropic connection ends in when its API answers as `script` does, the rig's clock run through every wait. */
async function anthropicFailure(script: Script): Promise<string> {
  const made = rig({ script });
  r = made;
  const saved = await made.layer.api.save(claude("claude-sonnet-4-5"), ANTHROPIC_KEY);
  const answer = await made.clock.settle(call(await made.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" }), ASK));
  expect(answer.stopReason).toBe("error");
  return answer.errorMessage ?? "";
}

/** The words a call on an OpenAI-compatible server, sent with `headers`, ends in when it answers as `script` does, the rig's clock run through every wait. */
async function serverFailure(script: Script, headers?: Record<string, string>): Promise<string> {
  const made = rig({ script });
  r = made;
  const saved = await made.layer.api.save({ name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model", ...(headers ? { headers } : {}) }, SERVER_KEY);
  const answer = await made.clock.settle(call(await made.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" }), ASK));
  expect(answer.stopReason).toBe("error");
  return answer.errorMessage ?? "";
}

/** A stream that sends `head` and then breaks as a socket closing does. */
function brokenStream(head: string, why: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      controller.error(new Error(why));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const STARTED = anthropicStream(anthropicTurn({ text: "The mill" }).slice(0, 3));

describe("a failed call", () => {
  test("leads with the provider's status, then its own words and their kind", async () => {
    expect(await anthropicFailure(() => failed(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }))).toBe("529: Overloaded (overloaded_error)");
    await r?.done();
    expect(await serverFailure(() => failed(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } }))).toBe("429: You exceeded your current quota, please check your plan and billing details. (insufficient_quota)");
  });

  test("says how a stream ended early or dropped in the middle, and is never made again once something of its answer came", async () => {
    expect(await anthropicFailure(() => eventStream(STARTED))).toContain("stream ended");
    expect(r?.sent.length).toBe(1);
    await r?.done();
    expect(await anthropicFailure(() => brokenStream(STARTED, "The socket connection was closed unexpectedly."))).toContain("socket connection was closed");
    expect(r?.sent.length).toBe(1);
  });
});

describe("a call that failed before any piece of its answer came", () => {
  const rateLimited = (): Response => failed(429, { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } });

  test("a 429, then a good answer: one answer, begun once, from the second request, a second after the first", async () => {
    const made = rig({ script: (_sent, index) => (index === 0 ? rateLimited() : eventStream(anthropicStream(anthropicTurn({ text: "At the quay." })))) });
    r = made;
    const saved = await made.layer.api.save(claude("claude-sonnet-4-5"), ANTHROPIC_KEY);
    const agent = await made.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" });
    const began = made.clock.now();
    const { kinds, answer } = await made.clock.settle(
      (async () => {
        const stream = await agent.streamFn(agent.model, normalizeContext({ messages: ASK }), {});
        const seen: string[] = [];
        for await (const event of stream) seen.push(event.type);
        return { kinds: seen, answer: await stream.result() };
      })(),
    );
    expect([answer.stopReason, answer.content]).toEqual(["stop", [{ type: "text", text: "At the quay." }]]);
    expect(kinds.filter((k) => k === "start").length).toBe(1);
    expect(made.sent.length).toBe(2);
    expect(made.clock.now() - began).toBe(1_000);
  });

  test("a server out of reach, a 5xx, a 429: made again as many times as the connection says, 2 when it says nothing, each wait twice the last", async () => {
    expect(await anthropicFailure(() => failed(503, { type: "error", error: { type: "api_error", message: "Service Unavailable" } }))).toBe("503: Service Unavailable (api_error)");
    expect([r?.sent.length, (r?.clock.now() ?? 0) - 1_000_000]).toEqual([3, 3_000]);
    await r?.done();
    await anthropicFailure(() => {
      throw new TypeError("Unable to connect. Is the computer able to access the url?");
    });
    expect(r?.sent.length).toBe(3);
    await r?.done();
    const made = rig({ script: rateLimited });
    r = made;
    const once = await made.layer.api.save(claude("claude-sonnet-4-5", { retries: 1 }), ANTHROPIC_KEY);
    const never = await made.layer.api.save(claude("claude-sonnet-4-5", { retries: 0 }), ANTHROPIC_KEY);
    for (const id of [once.id, never.id]) await made.clock.settle(call(await made.layer.agentModel({ connectionId: id, model: null, effort: "off" }), ASK));
    expect(made.sent.length).toBe(2 + 1);
  });

  test("a refusal that no second try changes is never made again, nor is a call stopped while it waits", async () => {
    await anthropicFailure(() => failed(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    expect(r?.sent.length).toBe(1);
    await r?.done();
    const made = rig({ script: rateLimited });
    r = made;
    const saved = await made.layer.api.save(claude("claude-sonnet-4-5"), ANTHROPIC_KEY);
    const stop = new AbortController();
    const calling = call(await made.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" }), ASK, { signal: stop.signal });
    await made.clock.idle();
    expect(made.clock.pending).toBe(1);
    stop.abort(new Error("The reply was stopped."));
    expect([(await calling).stopReason, (await calling).errorMessage]).toEqual(["aborted", "The reply was stopped."]);
    expect([made.sent.length, made.clock.pending]).toEqual([1, 0]);
  });

  test("never holds a key or a header's value, even where the provider repeats one", async () => {
    const refused = await serverFailure(() => failed(401, { error: { message: `Incorrect API key provided: ${SERVER_KEY}.`, type: "invalid_request_error", code: "invalid_api_key" } }));
    expect(refused.startsWith("401: Incorrect API key provided: [secret]")).toBe(true);
    expect(r?.sent[0]?.headers.authorization).toBe(`Bearer ${SERVER_KEY}`);
    await r?.done();
    const gateway = "gw-token-Okoro0123456789abcdef";
    expect(await serverFailure(() => failed(401, { error: { message: `Unknown gateway token ${gateway}.`, type: "invalid_request_error" } }), { "x-gateway-token": gateway })).toBe("401: Unknown gateway token [secret]. (invalid_request_error)");
    expect(r?.sent[0]?.headers["x-gateway-token"]).toBe(gateway);
  });
});

describe("a call its connection can't make", () => {
  test("says what to do, and sends nothing", async () => {
    const made = rig();
    r = made;
    const keyless = await made.layer.api.save(claude("claude-sonnet-4-5"));
    const unnamed = await made.layer.api.save({ name: "No model", provider: "anthropic", auth: "key" }, ANTHROPIC_KEY);
    const answer = async (connectionId: string): Promise<string | undefined> => (await call(await made.layer.agentModel({ connectionId, model: null, effort: "off" }), ASK)).errorMessage;
    expect(await answer(keyless.id)).toBe('The connection "Claude" has no key: add one on the Connections page.');
    await expect(made.layer.agentModel({ connectionId: unnamed.id, model: null })).rejects.toThrow('The connection "No model" names no model');
    await expect(made.layer.agentModel({ connectionId: "gone", model: null })).rejects.toThrow("This call's connection is no longer there");
    await made.layer.api.setDefault(null);
    await expect(made.layer.agentModel({ connectionId: null, model: null })).rejects.toThrow("There is no default connection");
    // A connection taken away after its agent's model was made: the call says so.
    const agent = await made.layer.agentModel({ connectionId: unnamed.id, model: "claude-sonnet-4-5" });
    await made.layer.api.remove(unnamed.id);
    expect((await call(agent, ASK)).errorMessage).toBe("This call's connection is no longer there: pick another on the Connections page.");
    expect(made.sent).toEqual([]);
  });

  test("stopped before it began ends as stopped, and sends nothing", async () => {
    r = rig({ script: anthropicAnswer });
    const saved = await r.layer.api.save(claude("claude-sonnet-4-5"), ANTHROPIC_KEY);
    const stop = new AbortController();
    stop.abort(new Error("The reply was stopped."));
    const answer = await call(await r.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" }), ASK, { signal: stop.signal });
    expect([answer.stopReason, answer.errorMessage]).toEqual(["aborted", "The reply was stopped."]);
    expect(r.sent).toEqual([]);
  });
});
