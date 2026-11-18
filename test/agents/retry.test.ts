// A sub-agent's model call that failed is made again as the lead's is (the owner's word of 18 Nov):
// the lead gets the sub-agent's whole answer, never what its broken call wrote.
import { afterEach, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { definition, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = definition("lead", { model: "lead-model", tools: ["delegate"] }, "Fixture lead: you run the turn.");
const GM = definition("gm", { model: "gm-model", tools: [] }, "Fixture GM: rule on what you are asked.");
const RESET = "The connection was closed or reset: The socket connection was closed unexpectedly.";

function toolResults(messages: readonly Message[]): string[] {
  return messages.filter((message) => message.role === "toolResult").map(textOf);
}

test("a sub-agent's call that broke off is made again: the lead gets its whole answer, and the trace shows the failed try", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM, "config.yml": "calls:\n  retryWaitSeconds: 0\n" },
    models: {
      "lead-model": [{ pieces: [{ call: "delegate", args: { agent: "gm", brief: "Can she make the jump?" }, id: "d-1" }] }, { pieces: [{ text: "Settled." }] }],
      "gm-model": [{ pieces: [{ text: "At twenty feet the ju" }], end: { error: RESET } }, { pieces: [{ text: "At twenty feet the jump fails." }] }],
    },
  }));

  const outcome = await (await s.play("She leaps for the far ledge.")).done;

  expect(outcome.status).toBe("done");
  expect(s.models["gm-model"]!.requests).toHaveLength(2);
  const [answer] = toolResults(s.models["lead-model"]!.requests[1]!.messages);
  expect(answer).toContain("At twenty feet the jump fails.");
  expect(answer?.split("At twenty feet")).toHaveLength(2);
  expect(s.trace.of("call_failed").map((record) => [record.agent?.definition, record.event.failure, record.event.retried])).toEqual([["gm", "connection", true]]);
});
