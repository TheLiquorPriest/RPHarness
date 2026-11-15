// The agent's session reaches pi on every request (pi's `Agent` takes `sessionId`), so the provider's
// cache knows the session (§13.3): OpenAI's prompt cache key is sent, and where a connection turns
// Anthropic's message threads on, what pi-ai keeps for the session is let go by the very id the runner
// sent once the model layer is told the session ended (`ModelLayer.ended`, which the session's close
// calls). No request leaves the process: the model layer's HTTP is scripted. Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import { AgentRunner, type LoopTool, RunTrace } from "../../src/loop";
import { anthropicStream, anthropicTurn, bodyOf, eventStream, type Rig, rig } from "../model/support";
import { replyMissing, rigAgent, said, scope, texts, tool, TraceRecorder, user } from "./support";

const author = { id: "author", definition: "author" };

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** OpenAI's Responses API streaming one short answer, as its server sends it. */
function openAIAnswer(text: string): Response {
  const events = [
    { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
  ];
  return eventStream(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

const LOOKUP: LoopTool = { name: "lookup", description: "Fixture: looks up where a thing in the house is.", parameters: { type: "object", properties: { what: { type: "string" } } }, run: async () => said("under the mat") };

describe("the session's id on every request", () => {
  test("every call's stream options carry the session's id: the first, the one after a tool, and the one a rule due at the run's end adds", async () => {
    const look = tool("look", async () => said("a quiet room"));
    const { runner, scripted, clock } = rigAgent(author, [{ pieces: [{ call: "look" }] }, { pieces: [{ text: "Quiet." }] }, { pieces: [{ text: "Quiet, and nothing else." }] }], {
      tools: [look],
      runEnd: replyMissing(() => false, "Fixture rule: the reply is still owed."),
    });

    await clock.settle(runner.start({ messages: [user("Look around.")] }).done);

    expect(scripted.requests.map((request) => request.options.sessionId)).toEqual(["session-of-author", "session-of-author", "session-of-author"]);
  });

  test("an OpenAI request made by pi-ai carries the session as its prompt cache key", async () => {
    r = rig({ script: () => openAIAnswer("At the quay.") });
    const saved = await r.layer.api.save(scope.user, { name: "OpenAI", provider: "openai", auth: "key", model: "gpt-4.1" }, "sk-proj-0123456789abcdef");
    const agent = await r.layer.agentModel({ user: scope.user, connectionId: saved.id, model: null, effort: "off" });
    const runner = new AgentRunner({ agent: author, trace: new RunTrace(new TraceRecorder(), scope, "run-1", r.clock), model: agent.model, streamFn: agent.streamFn, connection: "OpenAI", session: "scene-7", texts });

    // The layer's HTTP is a scripted fetch, which answers at once: nothing waits on the clock.
    const outcome = await runner.start({ messages: [user("Where is Ilse?")] }).done;

    expect(outcome.status).toBe("done");
    expect(r.sent).toHaveLength(1);
    expect(bodyOf(r.sent[0])["prompt_cache_key"]).toBe("scene-7");
  });

  test("a connection that turns Anthropic's message threads on: the session's later calls go on its thread, and once the layer is told the session with the runner's id ended, its next call starts anew", async () => {
    r = rig({ script: (_sent, index) => eventStream(anthropicStream(index === 0 ? anthropicTurn({ tool: { id: "toolu_1", name: "lookup", input: { what: "keys" } } }) : anthropicTurn({ text: "Under the mat." }))) });
    const saved = await r.layer.api.save(scope.user, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", messageThreads: true }, "sk-ant-api03-0123456789abcdef");
    const agent = await r.layer.agentModel({ user: scope.user, connectionId: saved.id, model: null, effort: "off" });
    const runner = new AgentRunner({ agent: author, trace: new RunTrace(new TraceRecorder(), scope, "run-1", r.clock), model: agent.model, streamFn: agent.streamFn, connection: "Claude", session: "scene-7", texts, tools: [LOOKUP] });

    expect((await runner.start({ messages: [user("Where are the keys?")] }).done).status).toBe("done");
    expect(r.sent.map((sent) => bodyOf(sent)["thread"])).toEqual([{ type: "create" }, { type: "continue", previous_message_id: "msg_1" }]);

    // What the session's close tells the model layer (PlanHarnessTools-21 makes that call), with the session the runner was given.
    r.layer.ended("scene-7");
    expect((await runner.start({ message: "And the door?" }).done).status).toBe("done");
    expect(bodyOf(r.sent[2])["thread"]).toEqual({ type: "create" });
  });
});
