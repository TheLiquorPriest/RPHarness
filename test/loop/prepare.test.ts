// Every request's context through pi's request hook (§10.2, §11, §13.3): the opening block with the
// agent's tools and the run's fixed context (a lead's prompt, what its session carries, its
// briefing) go with every request, the same byte for byte, while pi's transcript holds only the
// agent's own work; what was sent is kept as the model received it. Each call's model, effort,
// sampling and longest answer are decided for that request alone. The run's point before each
// request is shown the request as it would go and what it weighs, may put a summary in place of
// part of it, may make calls of its own under the run's limits and stop, and is asked again when
// the provider refuses a call as too long. Everything here is invented.
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { type AgentOutcome, Budget, RunTrace } from "../../src/loop";
import type { PendingRequest, RequestPoint } from "../../src/loop/types";
import { DEFAULT_CHARS_PER_TOKEN, promptTokens } from "../../src/model/tokens";
import { FakeClock, type RecordedRequest, type Reply, rigAgent, said, scope, textOf, tool, TraceRecorder, user } from "./support";

const lead = { id: "lead", definition: "lead" };
const OPENING = "Fixture lead: you tell the story of the harbour at Saltmere.";
const look = tool("look", async () => said("Fixture: the quay is empty."));

/** The run's fixed context, as a lead's is laid out: the prompt's frame, the prompt, what the session carries, the briefing. */
const BLOCKS: AgentMessage[] = [
  { role: "system", content: "Fixture frame: the chat's own prompt follows.", timestamp: 1_000 },
  { role: "user", content: "Fixture prompt: the player asks what moves on the quay.", timestamp: 1_000 },
  { role: "system", content: "Fixture carried: two earlier turns, as they were.", timestamp: 1_000 },
  { role: "system", content: "Fixture briefing: the tide turns at dusk.", timestamp: 1_000 },
];
/** The opening block and the fixed context: the head of every request. */
const HEAD = 1 + BLOCKS.length;

/** Four calls of `look`, each its own call, then the answer. */
function fiveCalls(): Reply[] {
  return [1, 2, 3, 4].map((n): Reply => ({ pieces: [{ call: "look", id: `c${n}` }] })).concat({ pieces: [{ text: "Fixture: nothing moves on the quay." }] });
}

/** A request's messages copied as JSON, as the scripted model keeps what it receives. */
function asSent(messages: readonly AgentMessage[]): unknown {
  return JSON.parse(JSON.stringify(messages));
}

/**
 * A request's messages as a provider is sent them, for comparing two runs. A tool result that pi
 * makes carries the machine's time it was made at and how long its tool ran (`timestamp`,
 * `durationMs`), and no provider is sent either one. Within one run every later request carries each
 * result as it was stamped once, so only two runs differ in them.
 */
function toProvider(messages: readonly Message[]): unknown[] {
  return messages.map((message) => (message.role === "toolResult" ? { ...message, timestamp: undefined, durationMs: undefined } : message));
}

/** A request's own part, after its head, each message as its role and what tells it apart: a call's ids, a result's call, a text. */
function own(request: RecordedRequest): [string, string][] {
  return request.messages.slice(HEAD).map((message): [string, string] => {
    if (message.role === "assistant") return ["assistant", message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])).join(",")];
    if (message.role === "toolResult") return ["toolResult", message.toolCallId];
    return [message.role, textOf(message)];
  });
}

function head(request: RecordedRequest): string {
  return JSON.stringify(request.messages.slice(0, HEAD));
}

describe("the request's context", () => {
  test("every request of a five-call turn begins with the opening block and the fixed context, byte for byte; the transcript holds only the agent's own work; each kept request is what the model received", async () => {
    const kept: { call: number; messages: unknown }[] = [];
    const { runner, scripted, clock } = rigAgent(lead, fiveCalls(), {
      instructions: OPENING,
      tools: [look],
      context: BLOCKS,
      keep: (call, messages) => {
        kept.push({ call, messages: asSent(messages) });
        return `requests/lead-${call}.json`;
      },
    });

    expect((await clock.settle(runner.start({ messages: [] }).done)).status).toBe("done");

    const sent = scripted.requests;
    expect(sent).toHaveLength(5);
    // The opening block first, with the tools as the model is told them; then the fixed context as given.
    expect(sent[0]!.messages[0]).toMatchObject({ role: "system", content: OPENING, toolsAdded: [{ name: "look" }] });
    expect(sent[0]!.messages.slice(1, HEAD)).toEqual(asSent(BLOCKS) as Message[]);
    for (const request of sent) expect(head(request)).toBe(head(sent[0]!));
    // pi's transcript is the agent's own work alone; each request is the head, then that work as it stood.
    expect(runner.transcript.map((message) => message.role)).toEqual(["assistant", "toolResult", "assistant", "toolResult", "assistant", "toolResult", "assistant", "toolResult", "assistant"]);
    sent.forEach((request, at) => expect(request.messages.slice(HEAD)).toEqual(asSent(runner.transcript.slice(0, 2 * at)) as Message[]));
    // Each call's request, kept as the model received it.
    expect(kept.map((entry) => entry.call)).toEqual([1, 2, 3, 4, 5]);
    expect(kept.map((entry) => entry.messages)).toEqual(sent.map((request) => request.messages));
  });

  test("a call's model, effort, sampling and longest answer, set for the second call alone, go with that request and no other", async () => {
    let other: Model<Api> | undefined;
    const rig = rigAgent(lead, [{ pieces: [{ call: "look", id: "c1" }] }, { pieces: [{ call: "look", id: "c2" }] }, { pieces: [{ text: "Fixture: the quay is quiet." }] }], {
      tools: [look],
      settings: (request) => (request.call === 2 && other !== undefined ? { model: other, effort: "high", sampling: { temperature: 0.25 }, maxTokens: 512 } : undefined),
    });
    other = { ...rig.scripted.model, id: "fixture-model-for-one-call" };

    expect((await rig.clock.settle(rig.runner.start({ messages: [] }).done)).status).toBe("done");

    const [first, second, third] = rig.scripted.requests;
    expect(second).toMatchObject({ model: "fixture-model-for-one-call", options: { reasoning: "high", temperature: 0.25, maxTokens: 512 } });
    for (const request of [first, third]) {
      expect(request?.model).toBe(rig.scripted.model.id);
      expect([request?.options.reasoning, request?.options.temperature, request?.options.maxTokens]).toEqual([undefined, undefined, undefined]);
    }
    expect(rig.recorder.of("call_started").map((record) => [record.event.model, record.event.maxTokens])).toEqual([
      [rig.scripted.model.id, undefined],
      ["fixture-model-for-one-call", 512],
      [rig.scripted.model.id, undefined],
    ]);
  });
});

describe("the run's point before each request", () => {
  test("is shown each request as it would go, the model's window, the reserve and the request's size; a summary it puts in place of calls 1 and 2 before call 4 holds for calls 4 and 5", async () => {
    const shown: PendingRequest[] = [];
    const summary = user("Fixture summary: the agent looked at the quay twice and found it empty.");
    const point: RequestPoint = {
      window: 64_000,
      reserve: 4_000,
      resend: 1,
      check: (request) => {
        shown.push(request);
        if (request.call !== 4) return undefined;
        const { to } = request.context;
        return [{ from: to, to: to + 4, messages: [summary] }];
      },
    };
    const { runner, scripted, clock } = rigAgent(lead, fiveCalls(), { instructions: OPENING, tools: [look], context: BLOCKS, point });

    expect((await clock.settle(runner.start({ messages: [] }).done)).status).toBe("done");

    expect(shown.map((request) => request.call)).toEqual([1, 2, 3, 4, 5]);
    expect(shown[0]).toMatchObject({ agent: lead, window: 64_000, reserve: 4_000, context: { from: 1, to: HEAD } });
    expect(shown.every((request) => request.refused === undefined)).toBe(true);
    // Where it put nothing in place, what it was shown is what went out, and its size is that request's.
    for (const at of [0, 1, 2, 4]) {
      expect(asSent(shown[at]!.messages)).toEqual(scripted.requests[at]!.messages);
      expect(shown[at]!.tokens).toBe(promptTokens(scripted.requests[at]!.messages, DEFAULT_CHARS_PER_TOKEN));
    }
    // Call 4 went out on the summary and the newest call with its result; call 5 the same, and its own call after.
    const summed: [string, string] = ["user", textOf(summary)];
    expect(own(scripted.requests[3]!)).toEqual([summed, ["assistant", "c3"], ["toolResult", "c3"]]);
    expect(own(scripted.requests[4]!)).toEqual([summed, ["assistant", "c3"], ["toolResult", "c3"], ["assistant", "c4"], ["toolResult", "c4"]]);
    expect(head(scripted.requests[4]!)).toBe(head(scripted.requests[0]!));
    expect(runner.transcript[0]).toEqual(summary);
  });

  test("a span that would part a tool call from its result puts nothing in place: the work fails in the harness before the request goes out", async () => {
    const point: RequestPoint = {
      reserve: 0,
      resend: 0,
      check: (request) => (request.call === 3 ? [{ from: request.context.to, to: request.context.to + 1, messages: [user("Fixture summary: one look.")] }] : undefined),
    };
    const { runner, scripted, clock } = rigAgent(lead, fiveCalls(), { instructions: OPENING, tools: [look], context: BLOCKS, point });

    const outcome = await clock.settle(runner.start({ messages: [] }).done);

    expect(outcome).toMatchObject({ status: "failed", failure: "harness" });
    expect(outcome.error).toContain("parts a tool call from its result");
    expect(scripted.requests).toHaveLength(2);
    expect(runner.transcript.map((message) => message.role)).toEqual(["assistant", "toolResult", "assistant", "toolResult"]);
  });

  test("may make a call of its own before the request goes out: it is in the run's trace, and it counts against the run's limits", async () => {
    const clock = new FakeClock();
    const recorder = new TraceRecorder();
    const trace = new RunTrace(recorder, scope, "run-1", clock);
    const turn = new Budget("turn", { calls: 2 });
    const saver = rigAgent({ id: "saver", definition: "lead" }, [{ pieces: [{ text: "Fixture: noted what matters." }] }], { clock, recorder, trace, turn });
    const point: RequestPoint = {
      reserve: 0,
      resend: 0,
      check: async (request) => {
        if (request.call !== 2) return undefined;
        await saver.runner.start({ messages: [user("Fixture rule: save what matters before the summary.")] }).done;
        return undefined;
      },
    };
    const { runner, scripted } = rigAgent(lead, [{ pieces: [{ call: "look", id: "c1" }] }, { pieces: [{ text: "Fixture: never sent." }] }], { clock, recorder, trace, turn, tools: [look], point });

    const outcome = await clock.settle(runner.start({ messages: [] }).done);

    // The point's call is the run's: traced between the lead's, and counted with them, so the lead's second call is held at the run's limit.
    expect(recorder.of("call_started").map((record) => record.agent.id)).toEqual(["lead", "saver"]);
    expect(outcome).toMatchObject({ status: "limit", limit: { limit: "calls", per: "turn", max: 2, value: 2 } });
    expect(scripted.requests).toHaveLength(1);
  });

  test("a stop ends the point's own call with the work, and the work does not wait on it", async () => {
    const clock = new FakeClock();
    const recorder = new TraceRecorder();
    const trace = new RunTrace(recorder, scope, "run-1", clock);
    const saver = rigAgent({ id: "saver", definition: "lead" }, [{ pieces: [{ wait: 1_000 }, { text: "Fixture: too late." }] }], { clock, recorder, trace });
    let saving: Promise<AgentOutcome> | undefined;
    const point: RequestPoint = {
      reserve: 0,
      resend: 0,
      check: async (request) => {
        if (request.call !== 2) return undefined;
        const work = saver.runner.start({ messages: [user("Fixture rule: save what matters before the summary.")] });
        request.signal.addEventListener("abort", () => work.stop(), { once: true });
        saving = work.done;
        await work.done;
        return undefined;
      },
    };
    const { runner, scripted } = rigAgent(lead, [{ pieces: [{ call: "look", id: "c1" }] }, { pieces: [{ text: "Fixture: never sent." }] }], { clock, recorder, trace, tools: [look], point });

    const work = runner.start({ messages: [] });
    await clock.settle(clock.sleep(50));
    work.stop();

    expect((await clock.settle(work.done)).status).toBe("stopped");
    expect(clock.now()).toBe(50);
    expect((await clock.settle(saving ?? Promise.reject(new Error("The point made no call.")))).status).toBe("stopped");
    expect(scripted.requests).toHaveLength(1);
  });

  test("with none, or one that puts nothing in place, each request goes out as set the moment the one before it is answered: the rig's clock shows no wait", async () => {
    const sent: unknown[] = [];
    for (const point of [undefined, { reserve: 0, resend: 0, check: () => undefined }]) {
      const { runner, scripted, clock } = rigAgent(lead, [{ pieces: [{ wait: 30 }, { call: "look", id: "c1" }] }, { pieces: [{ wait: 20 }, { text: "Fixture: the quay is quiet." }] }], {
        instructions: OPENING,
        tools: [look],
        context: BLOCKS,
        ...(point !== undefined ? { point } : {}),
      });
      expect((await clock.settle(runner.start({ messages: [] }).done)).status).toBe("done");
      expect(scripted.requests.map((request) => request.at)).toEqual([0, 30]);
      sent.push(scripted.requests.map((request) => toProvider(request.messages)));
    }
    expect(sent[1]).toEqual(sent[0]);
  });

  test("a call the provider refused as too long goes back to it with the provider's words, and out again on what it put in place, as many times in a row as the setting says; then the work ends on the provider's refusal", async () => {
    const refusal = (n: number): Reply => ({ pieces: [], end: { error: `Fixture provider: prompt is too long: ${70_000 + n} tokens > 64000 maximum` } });
    const refused: string[] = [];
    const summaries = [user("Fixture summary: one look at the quay."), user("Fixture summary: two looks at the quay.")];
    const point: RequestPoint = {
      window: 64_000,
      reserve: 4_000,
      resend: 2,
      check: (request) => {
        if (request.refused === undefined) return undefined;
        refused.push(request.refused);
        const { to } = request.context;
        // Each time, the oldest of the agent's own work gives way to a summary: first call 1 and its result, then all of it.
        return refused.length === 1 ? [{ from: to, to: to + 2, messages: [summaries[0]!] }] : [{ from: to, to: request.messages.length, messages: [summaries[1]!] }];
      },
    };
    const { runner, scripted, clock } = rigAgent(lead, [{ pieces: [{ call: "look", id: "c1" }] }, { pieces: [{ call: "look", id: "c2" }] }, refusal(1), refusal(2), refusal(3)], {
      instructions: OPENING,
      tools: [look],
      context: BLOCKS,
      point,
    });

    const outcome = await clock.settle(runner.start({ messages: [] }).done);

    expect(refused).toEqual([1, 2].map((n) => `Fixture provider: prompt is too long: ${70_000 + n} tokens > 64000 maximum`));
    expect(scripted.requests).toHaveLength(5);
    // Call 3 went out on the agent's two calls; each time again, on what the point put in place.
    expect(own(scripted.requests[2]!)).toEqual([["assistant", "c1"], ["toolResult", "c1"], ["assistant", "c2"], ["toolResult", "c2"]]);
    expect(own(scripted.requests[3]!)).toEqual([["user", textOf(summaries[0]!)], ["assistant", "c2"], ["toolResult", "c2"]]);
    expect(own(scripted.requests[4]!)).toEqual([["user", textOf(summaries[1]!)]]);
    expect(outcome).toMatchObject({ status: "failed", failure: "model", error: "Fixture provider: prompt is too long: 70003 tokens > 64000 maximum" });
  });
});
