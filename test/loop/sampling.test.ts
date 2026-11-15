// Claim f (§18.1 row 0.2, §13.3 "sampling per call"): the lead's call carries a preset's sampling,
// set per request: decided for each call as it is made, and in the provider's request as given.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { describe, expect, test } from "bun:test";
import type { Sampling } from "../../src/contract";
import { AgentRunner, type CallRequest, RunTrace } from "../../src/loop";
import { FakeClock, rigAgent, said, scope, terms, texts, tool, TraceRecorder, user } from "./support";

const author = { id: "author", definition: "author" };

const preset: Sampling = { temperature: 1.05, top_p: 0.92, top_k: 40, min_p: 0.05, frequency_penalty: 0.2, presence_penalty: 0.1, repetition_penalty: 1.07, seed: 7, stop: ["\n\nPlayer:"] };

/** The preset's sampling on the call that writes the reply, the agent's own on every other: decided per request. */
function settings(request: CallRequest): { sampling?: Sampling; maxTokens?: number } | undefined {
  return request.call === 2 ? { sampling: preset, maxTokens: 700 } : undefined;
}

describe("sampling per request", () => {
  test("each call carries the sampling decided for it as it is made", async () => {
    const look = tool("look", async () => said("a quiet room"));
    const { runner, scripted, recorder, clock } = rigAgent(author, [{ pieces: [{ call: "look" }] }, { pieces: [{ text: "<reply>Quiet.</reply>" }] }], { tools: [look], settings });

    await clock.settle(runner.start({ messages: [user("Look around.")] }).done);

    expect(scripted.requests.map((request) => request.options)).toEqual([
      { sessionId: "session-of-author" },
      { temperature: 1.05, maxTokens: 700, samplingParams: { top_p: 0.92, top_k: 40, min_p: 0.05, frequency_penalty: 0.2, presence_penalty: 0.1, repetition_penalty: 1.07, seed: 7, stop: ["\n\nPlayer:"] }, sessionId: "session-of-author" },
    ]);
    expect(recorder.of("call_started").map((record) => [record.event.call, record.event.sampling, record.event.maxTokens])).toEqual([
      [1, undefined, undefined],
      [2, preset, 700],
    ]);
  });

  test("an OpenAI-compatible connection's request body holds the preset's sampling as given", async () => {
    const bodies: Record<string, unknown>[] = [];
    // pi-ai's own adapter, with a fetch that answers from a script: no network.
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fixture-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const body = chunk({ role: "assistant", content: "<reply>Quiet.</reply>" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const model: Model<"openai-completions"> = {
      id: "fixture-flash",
      name: "fixture-flash",
      api: "openai-completions",
      provider: "fixture-provider",
      baseUrl: "http://model.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64_000,
      maxTokens: 8_000,
    };
    // The loop hands back the model it was given; the adapter wants it under its own API's type.
    const streamFn: StreamFn = (_callModel, context, options) => streamSimple(model, context, { ...options, apiKey: "fixture-key", fetch });
    const clock = new FakeClock();
    const trace = new RunTrace(new TraceRecorder(), scope, "run-1", clock);
    const runner = new AgentRunner({ agent: author, trace, model, streamFn, connection: "connection-a", session: "session-a", texts, terms, settings: () => ({ sampling: preset, maxTokens: 700 }) });

    const outcome = await runner.start({ messages: [user("Look around.")] }).done;

    expect(outcome.status).toBe("done");
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body).toMatchObject({ temperature: 1.05, top_p: 0.92, top_k: 40, min_p: 0.05, frequency_penalty: 0.2, presence_penalty: 0.1, repetition_penalty: 1.07, seed: 7, stop: ["\n\nPlayer:"] });
    expect(body["max_tokens"] ?? body["max_completion_tokens"]).toBe(700);
  });
});
