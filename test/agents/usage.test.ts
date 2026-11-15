// Usage and the live view (§13.4, Appendix A `UsageApi`, `LiveApi`): a sub-agent's calls are
// counted and shown under its own name, in the shapes the harness publishes for every agent: the
// run's usage by agent, the day's total, its window gauge, the live run's agents and its events
// and text as they come, and the progress lines its work brings.
import { afterEach, expect, test } from "bun:test";
import type { LiveItem } from "../../src/contract";
import { CHAT, definition, PROGRESS, said, type Stage, stage, USER } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = definition("lead", { model: "lead-model", tools: ["delegate"] }, "Fixture lead: you run the turn.");
const GM = definition("gm", { model: "gm-model", tools: ["roll"] }, "Fixture GM.");

test("a sub-agent's calls are counted and shown under its own name", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM, ".prompts/progress.md": PROGRESS },
    tools: { roll: { tier: "read", description: "Fixture: rolls dice.", run: async () => said("4") } },
    models: {
      "lead-model": [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-1" }], usage: { input: 1_000, output: 50 } },
        { pieces: [{ text: "Settled." }], usage: { input: 1_200, output: 20 } },
      ],
      "gm-model": [
        { pieces: [{ text: "Rolling." }, { call: "roll" }], usage: { input: 300, output: 15 } },
        { pieces: [{ text: "A four: the jump fails." }], usage: { input: 340, cacheRead: 300, output: 12 } },
      ],
    },
  }));
  const items: LiveItem[] = [];
  s.hub.subscribe({ user: USER, chat: CHAT }, (item) => items.push(item));

  const turn = await s.play("She leaps for the far ledge.");
  await turn.done;
  await s.usage.settled();

  const gm = { id: "gm-1", definition: "gm", parent: turn.lead.id };
  const gmUsage = { calls: 2, input: 940, cacheRead: 300, cacheWrite: 0, output: 27 };
  const leadUsage = { calls: 2, input: 2_200, cacheRead: 0, cacheWrite: 0, output: 70 };
  // The run's usage, by agent, and its total; the user's day counts both.
  expect(await s.usage.run(USER, "t1")).toEqual({
    run: "t1",
    total: { calls: 4, input: 3_140, cacheRead: 300, cacheWrite: 0, output: 97 },
    agents: [
      { agent: gm, usage: gmUsage },
      { agent: turn.lead, usage: leadUsage },
    ],
  });
  expect(await s.usage.day(USER)).toEqual({ calls: 4, input: 3_140, cacheRead: 300, cacheWrite: 0, output: 97 });
  // Its own window gauge: what its last call was sent, against its model's room.
  expect(await s.usage.window({ user: USER, chat: CHAT, session: "s1", turn: "t1" }, "gm-1")).toEqual({ used: 640, window: 64_000, reserve: 4_000 });
  // The live run lists it beside the lead, and its events and text came under its name, tied to the lead's call.
  expect(s.hub.running(USER)[0]?.agents).toEqual([turn.lead, gm]);
  const own = items.flatMap((item) => (item.type === "event" && item.record.agent.id === "gm-1" ? [item.record] : []));
  expect(own.map((record) => record.event.kind)).toEqual(["agent_started", "call_started", "call_ended", "tool_started", "tool_ended", "call_started", "call_ended", "agent_ended"]);
  expect(own.every((record) => record.parent?.call === "d-1")).toBe(true);
  const text = items.flatMap((item) => (item.type === "delta" && item.delta.agent === "gm-1" && item.delta.text !== undefined ? [item.delta.text] : []));
  expect(text.join("")).toBe("Rolling.A four: the jump fails.");
  // The thinking block says who is at work, in the progress file's words.
  expect(s.progress).toEqual(["Asking gm-1."]);
});
