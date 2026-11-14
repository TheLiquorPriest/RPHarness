// What the runner does around each tool call and model call besides the claims: live updates in
// the trace, a tool's failure and reports as the model sees them, marks kept for the rules, and a
// model that fails.
import { describe, expect, test } from "bun:test";
import { rigAgent, said, textOf, tool, user } from "./support";

const author = { id: "author", definition: "author" };

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
    expect(textOf(result)).toContain("Fixture failure: the ledger is locked.");
    expect(recorder.of("tool_ended")[0]!.event).toMatchObject({ clean: false, endedRun: false, result: { error: true } });
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
});
