// A call that ended before its request went out (the model layer's `call_unmade`: stopped while it
// waited for its connection, or refused before it was sent) was no call: the work's usage, the budget
// above it and its trace count none, so a job cancelled before it ran reports no call.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model, type Api } from "@earendil-works/pi-ai";
import { expect, test } from "bun:test";
import { Budget } from "../../src/loop/budget";
import type { LayerOptions } from "../../src/model/source";
import { rigAgent, user } from "./support";

const author = { id: "author", definition: "author" };

function ended(model: Model<Api>, stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, errorMessage, timestamp: 0 };
}

test("a call stopped while it waited to be sent was no call: the work, the budget above it and the trace count none", async () => {
  // As the model layer does with a call held by its connection's throttle: it ends at the stop, and says it never went out.
  const waiting: StreamFn = (model, _context, options) => {
    const out = createAssistantMessageEventStream();
    options?.signal?.addEventListener(
      "abort",
      () => {
        (options as LayerOptions).heard?.({ kind: "call_unmade" });
        out.push({ type: "error", reason: "aborted", error: ended(model, "aborted", "Stopped.") });
      },
      { once: true },
    );
    return out;
  };
  const turn = new Budget("turn", {});
  const { runner, clock, recorder } = rigAgent(author, [], { streamFn: waiting, turn });

  const work = runner.start({ messages: [user("Count the bells.")] });
  await clock.idle();
  expect(recorder.of("call_started")).toHaveLength(1);
  work.stop();
  const outcome = await work.done;

  expect([outcome.status, outcome.usage.calls, turn.used.calls]).toEqual(["stopped", 0, 0]);
  expect(recorder.of("agent_ended")[0]?.event.usage.calls).toBe(0);
});

test("a call refused before it was sent (no key) was no call either, and is not made again", async () => {
  const refused: StreamFn = (model, _context, options) => {
    const out = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const layer = options as LayerOptions;
      layer.heard?.({ kind: "call_facts", facts: { unmade: true } });
      layer.heard?.({ kind: "call_unmade" });
      out.push({ type: "error", reason: "error", error: ended(model, "error", "The connection has no key.") });
    });
    return out;
  };
  const turn = new Budget("turn", {});
  const { runner, clock, recorder } = rigAgent(author, [], { streamFn: refused, turn });

  const outcome = await clock.settle(runner.start({ messages: [user("Count the bells.")] }).done);

  expect([outcome.status, outcome.usage.calls, turn.used.calls]).toEqual(["failed", 0, 0]);
  expect(recorder.of("call_ended").map((record) => record.event.usage.calls)).toEqual([0]);
  expect(recorder.of("call_failed").map((record) => [record.event.failure, record.event.retried])).toEqual([["unmade", false]]);
});
