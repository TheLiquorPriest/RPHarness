// Claim d (§18.1 row 0.2, §13.3, §10.5): two sub-agents ask the lead at the same time. Asking ends
// a sub-agent's work with its question, which comes back through the lead's `delegate` call; a
// message from the lead continues it where it stopped. Both are answered.
//
// The three tools here are scaffolding over the runner's means (a tool result that asks; `start`
// with a message answering it); the real `delegate`, `ask_author` and `agent_message` are the
// tools lane's.
import { Agent } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "bun:test";
import type { JsonValue, ToolCtx } from "../../src/contract";
import { type AgentOutcome, AgentRunner, type LoopTool, type LoopToolResult, type RunTrace, type WorkInput } from "../../src/loop";
import { type Answer, FakeClock, gate, type RecordedRequest, rigAgent, scriptedModel, type ScriptedModel, terms, textOf, tool, TraceRecorder, user } from "./support";

const author = { id: "author", definition: "author" };

function field(args: JsonValue, name: string): string {
  return typeof args === "object" && args !== null && !Array.isArray(args) && typeof args[name] === "string" ? args[name] : "";
}

/** What a sub-agent's work came to, as the lead's tool result: its question, or its answer. */
function asResult(handle: string, outcome: AgentOutcome): LoopToolResult {
  if (outcome.status === "asked") {
    const question = typeof outcome.question === "object" && outcome.question !== null && !Array.isArray(outcome.question) ? outcome.question : {};
    // Fixture wording; the shipped one is `.prompts/question.md`.
    return { content: [{ type: "text", text: `${handle} asks: ${String(question["question"])} (searched: ${String(question["searched"])})` }], details: { handle, asked: true } };
  }
  return { content: [{ type: "text", text: `${handle}: ${outcome.text}` }], details: { handle, status: outcome.status } };
}

/** Sub-agents the lead can start and continue, each in the lead's run. */
function team(trace: RunTrace, clock: FakeClock, scripts: Record<string, Answer[]>): { tools: LoopTool[]; agents: Map<string, AgentRunner>; models: Record<string, ScriptedModel> } {
  const agents = new Map<string, AgentRunner>();
  const models: Record<string, ScriptedModel> = {};
  const askAuthor = tool("ask_author", async (args) => ({ content: [], ask: { question: field(args, "question"), searched: field(args, "searched") } }));
  const work = async (handle: string, runner: AgentRunner, input: WorkInput, ctx: ToolCtx): Promise<LoopToolResult> => {
    const started = runner.start(input, { parent: { agent: ctx.agent.id, run: ctx.run, call: ctx.callId } });
    ctx.signal.addEventListener("abort", () => started.stop(), { once: true });
    return asResult(handle, await started.done);
  };
  const delegate = tool("delegate", async (args, ctx) => {
    const definition = field(args, "agent");
    const handle = `${definition}#1`;
    const scripted = scriptedModel(scripts[definition] ?? [], { clock, id: `model-of-${handle}` });
    models[definition] = scripted;
    const runner = new AgentRunner({ agent: { id: handle, definition, parent: ctx.agent.id }, trace, model: scripted.model, streamFn: scripted.streamFn, connection: "connection-a", session: `session-of-${handle}`, texts: { continueAfterRule: () => "" }, terms, tools: [askAuthor] });
    agents.set(handle, runner);
    return work(handle, runner, { messages: [user(field(args, "brief"))] }, ctx);
  });
  const agentMessage = tool("agent_message", async (args, ctx) => {
    const handle = field(args, "agent");
    const runner = agents.get(handle);
    if (runner === undefined) return { content: [{ type: "text", text: `no agent ${handle}` }], error: true };
    return work(handle, runner, { message: field(args, "message") }, ctx);
  });
  return { tools: [delegate, agentMessage], agents, models };
}

describe("sub-agents asking the lead", () => {
  test("two ask at once: each question comes back through its delegate call, each answer continues its asker, and both are answered", async () => {
    const clock = new FakeClock();
    const recorder = new TraceRecorder();
    const leadAnswers: Answer[] = [
      { pieces: [{ text: "Two things to settle." }, { call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-gm" }, { call: "delegate", args: { agent: "keeper", brief: "Recall the vow." }, id: "d-keeper" }] },
      (request) => {
        const results = request.messages.filter((message) => message.role === "toolResult").map(textOf);
        expect(results).toEqual(["gm#1 asks: Is the gap ten feet or twenty? (searched: the map notes)", "keeper#1 asks: Which vow, the first or the second? (searched: the chat)"]);
        return { pieces: [{ call: "agent_message", args: { agent: "gm#1", message: "Twenty feet." }, id: "m-gm" }, { call: "agent_message", args: { agent: "keeper#1", message: "The second vow." }, id: "m-keeper" }] };
      },
      (request) => {
        const results = request.messages.filter((message) => message.role === "toolResult").slice(-2).map(textOf);
        expect(results).toEqual(["gm#1: At twenty feet the jump fails.", "keeper#1: The second vow binds her."]);
        return { pieces: [{ text: "Both settled." }] };
      },
    ];
    let toolsOfTeam: LoopTool[] = [];
    const rig = rigAgent(author, leadAnswers, { clock, recorder, tools: [tool("delegate", (args, ctx) => toolsOfTeam[0]!.run(args, ctx)), tool("agent_message", (args, ctx) => toolsOfTeam[1]!.run(args, ctx))] });
    const lastToolResult = (request: RecordedRequest): string => {
      const last = request.messages.filter((message) => message.role === "toolResult").at(-1);
      return last === undefined ? "" : textOf(last);
    };
    const crew = team(rig.trace, clock, {
      gm: [
        { pieces: [{ text: "Looking at the map." }, { wait: 3 }, { call: "ask_author", args: { question: "Is the gap ten feet or twenty?", searched: "the map notes" } }] },
        (request) => ({ pieces: [{ text: lastToolResult(request) === "Twenty feet." ? "At twenty feet the jump fails." : "no answer" }] }),
      ],
      keeper: [
        { pieces: [{ wait: 5 }, { call: "ask_author", args: { question: "Which vow, the first or the second?", searched: "the chat" } }] },
        (request) => ({ pieces: [{ text: lastToolResult(request) === "The second vow." ? "The second vow binds her." : "no answer" }] }),
      ],
    });
    toolsOfTeam = crew.tools;

    const outcome = await clock.settle(rig.runner.start({ messages: [user("She leaps for the far ledge.")] }).done);

    expect(outcome.status).toBe("done");
    expect(outcome.text).toBe("Both settled.");
    expect(rig.scripted.requests).toHaveLength(3);
    for (const name of ["gm", "keeper"]) {
      const requests = crew.models[name]!.requests;
      expect(requests).toHaveLength(2);
      // The answer is the ask's own result: the sub-agent goes on where it stopped.
      expect(requests[1]!.messages.at(-1)?.role).toBe("toolResult");
    }
    const ended = recorder.of("agent_ended").map((record) => [record.agent.id, record.event.status]);
    expect(ended).toEqual([
      ["gm#1", "asked"],
      ["keeper#1", "asked"],
      ["gm#1", "done"],
      ["keeper#1", "done"],
      ["author", "done"],
    ]);
    // At the same time: each asked while the other's first work was still going.
    const at = (id: string, kind: string, nth = 0) => recorder.records.filter((record) => record.agent.id === id && record.event.kind === kind)[nth]!.at;
    expect(at("gm#1", "agent_started")).toBeLessThan(at("keeper#1", "agent_ended"));
    expect(at("keeper#1", "agent_started")).toBeLessThan(at("gm#1", "agent_ended"));
    // Each stretch of a sub-agent's work hangs under the lead's call that started or continued it.
    const parents = recorder.records.filter((record) => record.event.kind === "agent_started" && record.agent.id !== "author").map((record) => [record.agent.id, record.agent.parent, record.parent?.call]);
    expect(parents).toEqual([
      ["gm#1", "author", "d-gm"],
      ["keeper#1", "author", "d-keeper"],
      ["gm#1", "author", "m-gm"],
      ["keeper#1", "author", "m-keeper"],
    ]);
  });

  test("why not pi's steering queue: a message steered to the lead while its tool call waits is not read until that call returns", async () => {
    const clock = new FakeClock();
    const held = gate();
    const scripted = scriptedModel([{ pieces: [{ call: "wait_for_agent" }] }, { pieces: [{ text: "Read it." }] }], { clock });
    const agent = new Agent({
      initialState: {
        model: scripted.model,
        tools: [{ name: "wait_for_agent", label: "wait_for_agent", description: "Fixture.", parameters: { type: "object", properties: {} }, execute: async () => (await held.opened, { content: [{ type: "text" as const, text: "the sub-agent finished" }], details: {} }) }],
      },
      streamFn: scripted.streamFn,
    });
    const running = agent.prompt(user("Delegate."));
    await clock.settle(clock.sleep(1));
    // The sub-agent's question, queued as steering while the lead's call waits on that sub-agent.
    agent.steer(user("A question from the sub-agent."));
    await clock.settle(clock.sleep(5));
    // Nothing reads it: the lead is still inside its first batch of tool calls, waiting.
    expect(scripted.requests).toHaveLength(1);
    expect(agent.state.pendingToolCalls.size).toBe(1);
    // Only when the call returns does the question reach the model, after the call's result.
    held.open();
    await clock.settle(running);
    expect(scripted.requests).toHaveLength(2);
    expect(scripted.requests[1]!.messages.slice(-2).map((message) => [message.role, textOf(message)])).toEqual([
      ["toolResult", "the sub-agent finished"],
      ["user", "A question from the sub-agent."],
    ]);
  });
});
