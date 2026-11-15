// pi's Agent runs on the layer's model as it would on any: a turn that calls a tool goes to the
// provider twice through pi-ai, the second time with the model's own turn and the tool's result,
// and the answer streams back through the agent's events. The agent's session is the prompt cache's
// key, and its effort is the level asked of the model.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, eventStream, rig, textOf, USER } from "./support";

const KEY = "sk-ant-api03-0123456789abcdef";

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** A turn whose model first calls `lookup`, then answers; the requests that left, and what the agent heard and did. */
async function lookupTurn(made: Rig, sessionId?: string, messageThreads?: true, user = USER): Promise<{ run: Agent; asked: unknown[]; pieces: string[]; bodies: Record<string, unknown>[] }> {
  const saved = await made.layer.api.save(user, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", ...(messageThreads ? { messageThreads } : {}) }, KEY);
  const agent = await made.layer.agentModel({ user, connectionId: saved.id, model: null, effort: "high" });
  expect(agent.thinkingLevel).toBe("high");
  const asked: unknown[] = [];
  const lookup: AgentTool = {
    name: "lookup",
    label: "Lookup",
    description: "Looks up where a thing in the house is.",
    parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
    execute: async (_id, params) => {
      asked.push(params);
      return { content: [{ type: "text", text: "under the mat" }], details: {} };
    },
  };
  const run = new Agent({ initialState: { systemPrompt: "You find things in the house.", model: agent.model, thinkingLevel: agent.thinkingLevel, tools: [lookup] }, streamFn: agent.streamFn, ...(sessionId !== undefined ? { sessionId } : {}) });
  const pieces: string[] = [];
  run.subscribe((event: AgentEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") pieces.push(event.assistantMessageEvent.delta);
  });
  await run.prompt("Where are the keys?");
  return { run, asked, pieces, bodies: made.sent.map(bodyOf) };
}

/** The provider's two answers: thinking and a call to `lookup`, then the answer. */
function lookupAnswers(_sent: unknown, index: number): Response {
  return eventStream(anthropicStream(index % 2 === 0 ? anthropicTurn({ thinking: { text: "The keys first.", signature: "sig-1" }, tool: { id: "toolu_1", name: "lookup", input: { what: "keys" } } }) : anthropicTurn({ text: "Under the mat.", usage: { input: 40, output: 6, cacheRead: 900 } })));
}

describe("a turn on the layer's model, run by pi's Agent", () => {
  test("calls a tool, sends its result back after the model's own turn with its signed thinking, and streams the answer", async () => {
    r = rig({ script: lookupAnswers });
    const { run, asked, pieces, bodies } = await lookupTurn(r);
    expect(run.state.errorMessage).toBeUndefined();
    expect(asked).toEqual([{ what: "keys" }]);
    expect(pieces.join("")).toBe("Under the mat.");
    expect(run.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", usage: { input: 40, cacheRead: 900, output: 6 } });
    expect(bodies.length).toBe(2);
    const [first, second] = bodies;
    expect(textOf(first?.system)).toBe("You find things in the house.");
    expect((first?.tools as { name: string }[]).map((t) => t.name)).toEqual(["lookup"]);
    // The effort asked, as a budget within the model's longest reply (pi's 64,000 for this model).
    expect(first?.thinking).toEqual({ type: "enabled", budget_tokens: 16_384, display: "summarized" });
    expect(first?.max_tokens).toBe(64_000);
    const messages = second?.messages as { role: string; content: { type: string }[] }[];
    expect(messages.map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["thinking", "tool_use"]],
      ["user", ["tool_result"]],
    ]);
    expect(messages[1]?.content[0]).toMatchObject({ type: "thinking", thinking: "The keys first.", signature: "sig-1" });
  });

  test("in an agent session, every request carries the whole conversation: Anthropic's message threads are off", async () => {
    r = rig({ script: lookupAnswers });
    const { run, bodies } = await lookupTurn(r, "agent-session-7");
    expect(run.state.errorMessage).toBeUndefined();
    expect(bodies.map((b) => Object.keys(b).includes("thread"))).toEqual([false, false]);
    expect((bodies[1]?.messages as { role: string; content: { type: string }[] }[]).map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["thinking", "tool_use"]],
      ["user", ["tool_result"]],
    ]);
  });

  test("a connection that turns threads on: Anthropic's endpoint keeps the conversation, the next call sends only what is new, until the session ends", async () => {
    r = rig({ script: lookupAnswers });
    const { run, bodies } = await lookupTurn(r, "agent-session-7", true);
    expect(run.state.errorMessage).toBeUndefined();
    expect(bodies[0]?.thread).toEqual({ type: "create" });
    expect(bodies[1]?.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
    expect((bodies[1]?.messages as { role: string; content: { type: string }[] }[]).map((m) => [m.role, m.content.map((b) => b.type)])).toEqual([["user", ["tool_result"]]]);
    // Once the session has ended, what pi-ai kept of it is let go: the same session starts anew.
    r.layer.ended(USER, "agent-session-7");
    await run.prompt("And the door?");
    expect(bodyOf(r.sent[2]).thread).toEqual({ type: "create" });
  });

  test("two users with the same session id: each has a thread of his own, and one's ended keeps the other's", async () => {
    r = rig({ script: lookupAnswers });
    const ilse = await lookupTurn(r, "scene-7", true);
    const other = await lookupTurn(r, "scene-7", true, "lantern-keeper");
    // The second user's first call starts a thread: none of the first's is his.
    expect([bodyOf(r.sent[2]).thread, bodyOf(r.sent[3]).thread]).toEqual([{ type: "create" }, { type: "continue", previous_message_id: "msg_1" }]);
    r.layer.ended(USER, "scene-7");
    await other.run.prompt("And the door?");
    expect(bodyOf(r.sent[4]).thread).toMatchObject({ type: "continue" });
    await ilse.run.prompt("And the door?");
    expect(bodyOf(r.sent[6]).thread).toEqual({ type: "create" });
  });

  test("a model the layer didn't make has no connection to go on, and the call says so", async () => {
    r = rig();
    const saved = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null });
    const run = new Agent({ initialState: { model: { ...agent.model }, thinkingLevel: "off" }, streamFn: agent.streamFn });
    await run.prompt("Hello?");
    expect(run.state.errorMessage).toBe("This model wasn't made by the model layer, so the call has no connection to go on: ask the layer for the agent's model.");
    expect(r.sent).toEqual([]);
  });

  test("a call's connection is read as it stands at the time of the call: a key changed since goes with the next call", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) });
    const claude = { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" } as const;
    const saved = await r.layer.api.save(USER, claude, KEY);
    const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" });
    const run = new Agent({ initialState: { model: agent.model, thinkingLevel: agent.thinkingLevel }, streamFn: agent.streamFn });
    await run.prompt("Where is Ilse?");
    await r.layer.api.save(USER, { ...claude, id: saved.id }, "sk-ant-api03-fedcba9876543210");
    await run.prompt("And Okoro?");
    expect(r.sent.map((s) => s.headers["x-api-key"])).toEqual([KEY, "sk-ant-api03-fedcba9876543210"]);
  });
});
