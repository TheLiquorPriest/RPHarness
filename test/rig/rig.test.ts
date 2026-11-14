// The scripted-model rig stands where a real model does: pi's own Agent runs a turn on it, a tool
// call and all, and the rig keeps each request as it came. Its pieces come as the script splits
// them, at the times its waits set on the rig's clock or when a gate opens; an answer can end cut
// off half way or in an error; and a call's signal stops it like a provider's stream, unless the
// script says to go on regardless.

import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { Reply } from "../../src/testing/rig";
import { FakeClock, scriptedModel, scriptedSource } from "../../src/testing/rig";

/** A tool that answers from a list of things in the house, and keeps what it was asked. */
function lookupTool(asked: unknown[]): AgentTool {
  return {
    name: "lookup",
    label: "Lookup",
    description: "Looks up where a thing in the house is.",
    parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
    execute: async (_id, params) => {
      asked.push(params);
      return { content: [{ type: "text", text: "under the mat" }], details: {} };
    },
  };
}

/** The text pieces an agent's events carried, in order. */
function heard(agent: Agent): string[] {
  const pieces: string[] = [];
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") pieces.push(event.assistantMessageEvent.delta);
  });
  return pieces;
}

/** The agent's last message: its answer. */
function lastAnswer(agent: Agent): AssistantMessage {
  const last = agent.state.messages.at(-1);
  if (last?.role !== "assistant") throw new Error("the agent's last message isn't an answer");
  return last;
}

function textIn(message: Message | undefined): string {
  return message === undefined || message.role === "system" ? "" : typeof message.content === "string" ? message.content : contentText(message.content);
}

describe("a turn on a scripted model, run by pi's Agent", () => {
  test("calls a tool, reads its result in the next answer, and every request is kept as it was sent", async () => {
    const clock = new FakeClock();
    const second = (request: { index: number; messages: Message[] }): Reply => {
      const result = request.messages.findLast((m) => m.role === "toolResult");
      return { pieces: [{ text: "They are " }, { text: `${textIn(result)}.` }], usage: { input: 240, cacheRead: 200, output: 9 } };
    };
    const model = scriptedModel([{ pieces: [{ thinking: "The keys first." }, { text: "Let me look." }, { call: "lookup", args: { what: "keys" }, id: "call_keys" }], usage: { input: 120, output: 30, reasoning: 6 } }, second], { clock });
    const asked: unknown[] = [];
    const agent = new Agent({ initialState: { systemPrompt: "You find things in the house.", model: model.model, thinkingLevel: "medium", tools: [lookupTool(asked)] }, streamFn: model.streamFn, sessionId: "session-house" });
    const pieces = heard(agent);
    await clock.settle(agent.prompt("Where are the keys?"));

    expect(asked).toEqual([{ what: "keys" }]);
    expect(pieces).toEqual(["Let me look.", "They are ", "under the mat."]);
    expect(lastAnswer(agent)).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "They are under the mat." }], usage: { input: 240, cacheRead: 200, output: 9, totalTokens: 449 } });
    expect(model.left).toBe(0);

    const [first, then] = model.requests;
    expect(model.requests.length).toBe(2);
    expect(first?.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(first?.tools.map((t) => t.name)).toEqual(["lookup"]);
    expect(first?.options).toEqual({ reasoning: "medium", sessionId: "session-house" });
    expect(then?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"]);
    expect(then?.messages[2]).toMatchObject({ role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "The keys first." }, { type: "text", text: "Let me look." }, { type: "toolCall", id: "call_keys", name: "lookup", arguments: { what: "keys" } }] });
    expect(then?.messages[3]).toMatchObject({ role: "toolResult", toolCallId: "call_keys", toolName: "lookup", content: [{ type: "text", text: "under the mat" }] });
    expect(first?.pushed.map((p) => [p.kind, p.text])).toEqual([
      ["thinking", "The keys first."],
      ["text", "Let me look."],
      ["call", '{"what":"keys"}'],
    ]);
  });

  test("records the sampling and room a call was asked with", async () => {
    const model = scriptedModel([{ pieces: [{ text: "Yes." }] }]);
    const agent = new Agent({ initialState: { model: model.model, thinkingLevel: "high" }, streamFn: (m, context, options) => model.streamFn(m, context, { ...options, temperature: 0.7, maxTokens: 900, samplingParams: { top_p: 0.9, stop: ["THE END"] } }) });
    await agent.prompt("Ready?");
    expect(model.requests[0]?.options).toEqual({ temperature: 0.7, maxTokens: 900, samplingParams: { top_p: 0.9, stop: ["THE END"] }, reasoning: "high" });
  });
});

describe("the pieces of an answer", () => {
  test("come at the times the script's waits set on the rig's clock, and not before", async () => {
    const clock = new FakeClock();
    const model = scriptedModel([{ pieces: [{ text: "The tide" }, { wait: 40 }, { text: " turns." }] }], { clock });
    const agent = new Agent({ initialState: { model: model.model }, streamFn: model.streamFn });
    const pieces = heard(agent);
    const run = agent.prompt("What does the tide do?");
    await clock.idle();
    expect(pieces).toEqual(["The tide"]);
    clock.advance(39);
    await clock.idle();
    expect(pieces).toEqual(["The tide"]);
    clock.advance(1);
    await run;
    expect(pieces).toEqual(["The tide", " turns."]);
    expect(model.requests[0]?.pushed.map((p) => p.at)).toEqual([0, 40]);
    expect(clock.now()).toBe(40);
  });

  test("hold at a gate until the test opens it", async () => {
    const model = scriptedModel([]);
    const held = model.gate();
    model.add({ pieces: [{ text: "Wait" }, { hold: held }, { text: "ed." }] });
    const agent = new Agent({ initialState: { model: model.model }, streamFn: model.streamFn });
    const pieces = heard(agent);
    const run = agent.prompt("Well?");
    await model.clock.idle();
    expect(pieces).toEqual(["Wait"]);
    held.open();
    await run;
    expect(pieces).toEqual(["Wait", "ed."]);
  });
});

describe("an answer that stops half way", () => {
  test("cut off by its stream: the run ends on an error, with what had come kept", async () => {
    const model = scriptedModel([{ pieces: [{ text: "The tide came in " }, { text: "over the" }], end: "cut" }]);
    const agent = new Agent({ initialState: { model: model.model }, streamFn: model.streamFn });
    await agent.prompt("Tell me about the tide.");
    expect(lastAnswer(agent)).toMatchObject({ stopReason: "error", errorMessage: "The stream ended before the answer did.", content: [{ type: "text", text: "The tide came in over the" }] });
    expect(agent.state.errorMessage).toBe("The stream ended before the answer did.");
    expect(model.requests.length).toBe(1);
  });

  test("ended by a provider's error, in its words", async () => {
    const model = scriptedModel([{ pieces: [{ text: "The" }], end: { error: "529: Overloaded (overloaded_error)" } }]);
    const agent = new Agent({ initialState: { model: model.model }, streamFn: model.streamFn });
    await agent.prompt("Tell me about the tide.");
    expect(lastAnswer(agent)).toMatchObject({ stopReason: "error", errorMessage: "529: Overloaded (overloaded_error)" });
  });

  test("stopped by the call's signal: no piece after it, the run ends as stopped, and its wait is let go", async () => {
    const clock = new FakeClock();
    const model = scriptedModel([{ pieces: [{ text: "The tide" }, { wait: 100 }, { text: " turns." }] }], { clock });
    const agent = new Agent({ initialState: { model: model.model }, streamFn: model.streamFn });
    const pieces = heard(agent);
    const run = agent.prompt("What does the tide do?");
    await clock.idle();
    agent.abort();
    await run;
    clock.advance(1_000);
    await clock.idle();
    expect(pieces).toEqual(["The tide"]);
    expect(lastAnswer(agent)).toMatchObject({ stopReason: "aborted", content: [{ type: "text", text: "The tide" }] });
    expect(model.requests[0]?.pushed.map((p) => p.text)).toEqual(["The tide"]);
    expect(clock.pending).toBe(0);
  });

  test("told to ignore the signal, it goes on sending after the stop, for a test of who holds that back", async () => {
    const clock = new FakeClock();
    const model = scriptedModel([{ pieces: [{ text: "The tide" }, { wait: 100 }, { text: " turns." }], ignoreAbort: true }], { clock });
    const agent = new Agent({ initialState: { model: model.model }, streamFn: model.streamFn });
    const pieces = heard(agent);
    const run = agent.prompt("What does the tide do?");
    await clock.idle();
    agent.abort();
    await clock.settle(run);
    expect(pieces).toEqual(["The tide", " turns."]);
    expect(model.requests[0]?.pushed.map((p) => [p.text, p.at])).toEqual([
      ["The tide", 0],
      [" turns.", 100],
    ]);
  });
});

describe("the script", () => {
  test("a call it has no answer for ends in words that say so", async () => {
    const model = scriptedModel([{ pieces: [{ call: "lookup", args: { what: "keys" } }] }]);
    const agent = new Agent({ initialState: { model: model.model, tools: [lookupTool([])] }, streamFn: model.streamFn });
    await agent.prompt("Where are the keys?");
    expect(lastAnswer(agent)).toMatchObject({ stopReason: "error", errorMessage: "The script has no answer for call 2." });
  });

  test("a rig of scripted models answers an agent's choice by the model it names, and refuses one no script names", async () => {
    const author = scriptedModel([{ pieces: [{ text: "Hm." }] }], { id: "author", contextWindow: 200_000 });
    const source = scriptedSource({ author });
    const chosen = await source.agentModel({ connectionId: null, model: "author", effort: "high" });
    expect([chosen.model.id, chosen.thinkingLevel, chosen.limits.contextWindow?.tokens]).toEqual(["author", "high", 200_000]);
    expect(chosen.streamFn).toBe(author.streamFn);
    await expect(source.agentModel({ connectionId: null, model: "gm" })).rejects.toThrow('No scripted model is named "gm".');
  });

  test("work that waits on what no timer brings is said to, rather than left hanging", async () => {
    const model = scriptedModel([]);
    model.add({ pieces: [{ hold: model.gate() }] });
    const agent = new Agent({ initialState: { model: model.model }, streamFn: model.streamFn });
    await expect(model.clock.settle(agent.prompt("Well?"))).rejects.toThrow("The work waits on something no timer will bring");
    agent.abort();
  });
});
