// What the runner does around each tool call and model call besides the claims: live updates in
// the trace, a tool's failure and reports as the model sees them, marks kept for the rules, a rule
// that holds a call, a host's tool that takes `closing` left out of every agent's request and named
// in the log, and a model that fails.
import { afterEach, describe, expect, test } from "bun:test";
import type { TextChannel, ToolGate } from "../../src/loop";
import { MessageReply, TagReply } from "../../src/reply";
import { request, type Stage, stage } from "../harness/support";
import { type Answer, fired, rigAgent, said, SinkRecorder, textOf, tool, user } from "./support";

const author = { id: "author", definition: "author" };

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe("around a tool call", () => {
  test("a tool's updates are traced in order between its start and its end; marks are kept but not shown to the model", async () => {
    const survey = tool("survey", async (_args, ctx) => {
      ctx.onUpdate(said("north wing done"));
      ctx.onUpdate(said("south wing done"));
      return { content: [{ type: "text", text: "both wings" }], marks: ["unsourced"] };
    });
    const { runner, scripted, recorder, clock } = rigAgent(author, [{ pieces: [{ call: "survey", args: { closing: "true" } }] }, { pieces: [{ text: "Done." }] }], { tools: [survey] });

    await clock.settle(runner.start({ messages: [user("Survey the house.")] }).done);

    expect(recorder.kinds().filter((kind) => kind.startsWith("tool_"))).toEqual(["tool_started", "tool_update", "tool_update", "tool_ended"]);
    expect(recorder.of("tool_started")[0]!.event).toMatchObject({ closing: true, args: {} });
    expect(recorder.of("tool_update").map((record) => textOf(record.event.partial))).toEqual(["north wing done", "south wing done"]);
    expect(recorder.of("tool_ended")[0]!.event.result.marks).toEqual(["unsourced"]);
    // A clean closing call: no second call was needed, though the model may send `closing` as text.
    expect(scripted.requests).toHaveLength(1);
  });

  test("a tool that fails reaches the model as a failed call, and keeps the run going", async () => {
    const broken = tool("broken", async () => {
      throw new Error("Fixture failure: the ledger is locked.");
    });
    const { runner, scripted, recorder, clock } = rigAgent(author, [{ pieces: [{ call: "broken", args: { closing: true } }] }, { pieces: [{ text: "It failed; going on." }] }], { tools: [broken] });

    const outcome = await clock.settle(runner.start({ messages: [user("Check the ledger.")] }).done);

    expect(outcome.status).toBe("done");
    expect(scripted.requests).toHaveLength(2);
    const result = scripted.requests[1]!.messages.at(-1)!;
    expect(result.role).toBe("toolResult");
    expect(textOf(result)).toBe("Fixture: broken failed.");
    expect(recorder.of("tool_ended")[0]!.event).toMatchObject({ clean: false, endedRun: false, result: { error: true, details: { error: "Fixture failure: the ledger is locked." } } });
  });

  test("a closing call a rule holds does not end the run: the call does not run, and the agent reads the rule's text in its place", async () => {
    const HOLD = "Fixture rule: the vault stays shut.";
    const opened: string[] = [];
    const apply = tool("world_apply", async () => (opened.push("opened"), said("the vault is open")));
    const holding: ToolGate = {
      before: async (call) => (call.tool === "world_apply" ? { hold: fired("vault-shut", "tool-call", HOLD), remind: [] } : { remind: [] }),
      after: async (_call, result) => ({ result, remind: [] }),
    };
    const { runner, scripted, recorder, clock } = rigAgent(
      author,
      [{ pieces: [{ text: "<reply>She tries the vault.</reply>" }, { call: "world_apply", args: { note: "open the vault", closing: true } }] }, { pieces: [{ text: "It stays shut." }] }],
      { tools: [apply], gate: holding },
    );

    const outcome = await clock.settle(runner.start({ messages: [user("Open the vault.")] }).done);

    expect(outcome.status).toBe("done");
    expect(opened).toEqual([]);
    expect(scripted.requests).toHaveLength(2);
    const answered = scripted.requests[1]!.messages.at(-1)!;
    expect([answered.role, textOf(answered)]).toEqual(["toolResult", HOLD]);
    expect(recorder.of("tool_ended")[0]!.event).toMatchObject({ tool: "world_apply", clean: false, endedRun: false });
    expect(recorder.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.action])).toEqual([["vault-shut", "hold"]]);
  });

  test("a tool that takes an argument named closing is left out and named, and the agent works with the rest", async () => {
    const query = tool("world_query", async () => said("an answer"), { parameters: { type: "object", properties: { closing: { type: "string" } } } });
    const note = tool("scene_note", async () => said("noted"));
    const { runner, scripted, clock } = rigAgent(author, [{ pieces: [{ call: "world_query", args: { closing: "the door" } }] }, { pieces: [{ text: "Done." }] }], { tools: [query, note] });

    expect(runner.leftOut).toEqual(["world_query"]);
    const outcome = await clock.settle(runner.start({ messages: [user("Ask about the door.")] }).done);

    expect(outcome.status).toBe("done");
    expect(scripted.requests[0]!.tools.map((declared) => declared.name)).toEqual(["scene_note"]);
    expect(textOf(scripted.requests[1]!.messages.at(-1)!)).toBe("Fixture: no tool named world_query.");
  });

  test("a host's tool that takes closing is left out of the lead's, a sub-agent's and the writer's requests, and the log names it for each", async () => {
    const GM = "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: [world_query]\n---\nFixture GM: rule on what you are asked.\n";
    const NARRATOR = "---\nname: narrator\ndescription: Fixture narrator.\nmodel: default\ntools: [world_query]\ngiven:\n  - prompt:*(as sent, with the preset's sampling and prefill)\n  - brief\n---\nFixture narrator: write the reply from the brief.\n";
    const s = (open = await stage({
      drafted: true,
      files: { ".agents/gm.md": GM, ".agents/narrator.md": NARRATOR },
      tools: { world_query: { tier: "read", description: "Fixture: reads the world, and takes its own closing.", parameters: { properties: { at: { type: "string" }, closing: { type: "string" } } }, run: async () => said("the boat is late") } },
      answers: [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the boat." }, id: "d-1" }] },
        { pieces: [{ text: "The boat is late." }] },
        { pieces: [{ call: "write_reply", args: { brief: "Wren says the boat is late.", live: true, closing: true }, id: "w-1" }] },
        { pieces: [{ text: "Late again, Wren says." }] },
      ],
    }));

    const { outcome } = await s.turn(request("t1"));

    expect(outcome.status).toBe("released");
    // Each request, by the agent whose call it was: a call's start is traced just before its request is made.
    const by = s.trace.of("call_started").map((record, at) => [record.agent?.definition, s.model.requests[at]!.tools.map((declared) => declared.name)] as const);
    expect(by.map(([agent]) => agent)).toEqual(["author", "gm", "author", "narrator"]);
    for (const [, tools] of by) expect(tools).not.toContain("world_query");
    expect(by[0]![1]).toContain("delegate");
    const named = s.logged.filter((line) => line.message === "Tools that take an argument named closing, which RPH adds to every tool, are left out.").map((line) => line.fields);
    expect(named).toEqual([
      { agent: "author", tools: ["world_query"] },
      { agent: "gm", tools: ["world_query"] },
      { agent: "narrator", tools: ["world_query"] },
    ]);
  });
});

describe("a model that fails", () => {
  test("its error ends the work as failed, in the provider's words, and the failed message leaves the transcript", async () => {
    const { runner, recorder, clock } = rigAgent(author, [{ pieces: [{ text: "Half a thou" }], end: { error: "Fixture provider error: overloaded." } }]);

    const outcome = await clock.settle(runner.start({ messages: [user("Speak.")] }).done);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("Fixture provider error: overloaded.");
    expect(recorder.of("call_ended")[0]!.event).toMatchObject({ stop: "error", error: "Fixture provider error: overloaded.", text: "Half a thou" });
    expect(recorder.of("agent_ended")[0]!.event.status).toBe("failed");
    expect(runner.transcript.at(-1)?.role).toBe("user");
  });

  test("a stream that drops half way ends the work as failed", async () => {
    const { runner, clock } = rigAgent(author, [{ pieces: [{ text: "Half a thou" }], end: "cut" }]);
    const outcome = await clock.settle(runner.start({ messages: [user("Speak.")] }).done);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).not.toBe("");
  });

  test("a reply its provider failed in the middle of is not released, in either form: what was held back never shows", async () => {
    const failing = (text: string): Answer => ({ pieces: [{ text }], end: { error: "Fixture provider error: overloaded." } });
    const released: string[] = [];
    async function failed(channel: TextChannel, answer: Answer): Promise<void> {
      const { runner, clock } = rigAgent(author, [answer], { channel });
      const outcome = await clock.settle(runner.start({ messages: [user("Speak.")] }).done);
      expect(outcome.status).toBe("failed");
    }
    // The tag form, holding back the sentence in progress as it does under a rule that covers the reply.
    const tagSink = new SinkRecorder();
    const tagged = new TagReply({ tags: { reply: "reply", intent: "intent" }, sink: tagSink, heldSentences: 1, tailSentences: 2, onReleased: (text) => released.push(text) });
    await failed(tagged, failing("<reply>The lamp turns. The sea is lou"));
    expect(tagged.released).toBe(false);
    expect(tagSink.text).toBe("The lamp turns. ");
    // The two-step form, which shows a message whole when it ends.
    const plainSink = new SinkRecorder();
    const plain = new MessageReply({ sink: plainSink, stream: false, heldSentences: 0, tailSentences: 2, onReleased: (text) => released.push(text) });
    await failed(plain, failing("The lamp turns. The sea is lou"));
    expect(plain.released).toBe(false);
    expect(plainSink.text).toBe("");
    expect(released).toEqual([]);
  });
});
