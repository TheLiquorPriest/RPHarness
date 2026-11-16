// Several sub-agents at once (§13.4): two started in one step run side by side, both may ask, both
// are answered and finish; a stop ends every one of them where it stands and leaves no model call
// running.
import { afterEach, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { definition, gate, type Gate, PROGRESS, type RecordedRequest, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = definition("lead", { model: "lead-model", tools: ["delegate", "agent_message"] }, "Fixture lead: you run the turn.");
const GM = definition("gm", { model: "gm-model", tools: ["ask_author"] }, "Fixture GM.");
const KEEPER = definition("keeper", { model: "keeper-model", tools: ["ask_author"] }, "Fixture keeper.");

function results(messages: readonly Message[]): string[] {
  return messages.filter((message) => message.role === "toolResult").map(textOf);
}

/** A first answer that tells the test its call came, then holds until the gate opens. */
function arriving(held: Gate, pieces: { call: string; args: Record<string, string>; id: string }[]) {
  const { promise, resolve } = Promise.withResolvers<RecordedRequest>();
  return {
    came: promise,
    answer: (request: RecordedRequest) => {
      resolve(request);
      return { pieces: [{ hold: held }, ...pieces] };
    },
  };
}

test("two started in one step work side by side; both ask, both are answered, both finish", async () => {
  const both = gate();
  const gm = arriving(both, [{ call: "ask_author", args: { question: "Ten feet or twenty?", searched: "the scene notes" }, id: "a-gm" }]);
  const keeper = arriving(both, [{ call: "ask_author", args: { question: "Which vow, the first or the second?", searched: "the chat" }, id: "a-keeper" }]);
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM, ".agents/keeper.md": KEEPER, ".prompts/progress.md": PROGRESS },
    models: {
      "lead-model": [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-gm" }, { call: "delegate", args: { agent: "keeper", brief: "Recall the vow." }, id: "d-keeper" }] },
        { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Twenty feet." }, id: "m-gm" }, { call: "agent_message", args: { agent: "keeper-1", message: "The second vow." }, id: "m-keeper" }] },
        { pieces: [{ text: "Both settled." }] },
      ],
      "gm-model": [gm.answer, (request) => ({ pieces: [{ text: `Ruled on ${textOf(request.messages.at(-1) ?? { content: "" })}` }] })],
      "keeper-model": [keeper.answer, (request) => ({ pieces: [{ text: `Recalled ${textOf(request.messages.at(-1) ?? { content: "" })}` }] })],
    },
  }));

  const turn = await s.play("She leaps, and remembers her vow.");
  // Both calls are in flight at once before either may go on.
  await Promise.all([gm.came, keeper.came]);
  both.open();
  const outcome = await turn.done;

  expect(outcome).toMatchObject({ status: "done", text: "Both settled." });
  const lead = s.models["lead-model"]!.requests;
  expect(results(lead[1]!.messages)).toEqual(["gm-1 stopped to ask before going on:\n\nTen feet or twenty?\n\nWhat it found before asking:\n\nthe scene notes", "keeper-1 stopped to ask before going on:\n\nWhich vow, the first or the second?\n\nWhat it found before asking:\n\nthe chat"]);
  expect(results(lead[2]!.messages).slice(-2)).toEqual(["gm-1 answered:\n\nRuled on Twenty feet.", "keeper-1 answered:\n\nRecalled The second vow."]);
  // Each asked, then finished; the lead ended last. Which of the two came back first is theirs to decide.
  const ended = s.trace.of("agent_ended");
  for (const id of ["gm-1", "keeper-1"]) expect(ended.filter((record) => record.agent?.id === id).map((record) => record.event.status)).toEqual(["asked", "done"]);
  expect(ended.at(-1)?.agent?.id).toBe(turn.lead.id);
  // Both questions were in the lead's hands before either agent went on.
  const order = ended.map((record) => `${record.agent?.id} ${record.event.status}`);
  expect(Math.max(order.indexOf("gm-1 asked"), order.indexOf("keeper-1 asked"))).toBeLessThan(Math.min(order.indexOf("gm-1 done"), order.indexOf("keeper-1 done")));
  // The thinking block says who is at work, how many at once, and who has a question, in the progress file's words.
  expect([...s.progress].sort()).toEqual(["2 agents at work.", "Asking gm-1.", "Asking keeper-1.", "gm-1 has a question.", "keeper-1 has a question."]);
});

test("a stop ends every one of them where it stands, and leaves no model call running", async () => {
  const never = gate();
  const gm = arriving(never, []);
  const keeper = arriving(never, []);
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM, ".agents/keeper.md": KEEPER },
    models: {
      "lead-model": [{ pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-gm" }, { call: "delegate", args: { agent: "keeper", brief: "Recall the vow." }, id: "d-keeper" }] }],
      "gm-model": [gm.answer],
      "keeper-model": [keeper.answer],
    },
  }));

  const turn = await s.play("She leaps.");
  const calls = await Promise.all([gm.came, keeper.came]);
  turn.stop();
  const outcome = await turn.done;
  // Whatever the held calls would still send goes nowhere.
  never.open();
  await s.clock.idle();

  expect(outcome.status).toBe("stopped");
  // Every agent of the turn ended stopped, each after its model call was given up: nothing of theirs is still running.
  expect(s.trace.of("agent_ended").map((record) => [record.agent?.id, record.event.status]).sort()).toEqual([
    ["gm-1", "stopped"],
    ["keeper-1", "stopped"],
    [turn.lead.id, "stopped"],
  ].sort());
  for (const call of calls) expect(call.pushed).toEqual([]);
  expect(s.models["gm-model"]!.requests).toHaveLength(1);
  expect(s.models["keeper-model"]!.requests).toHaveLength(1);
  expect(s.models["lead-model"]!.requests).toHaveLength(1);
  // Nothing about any of them came after its end.
  const last = new Map(s.trace.records.map((record, at) => [record.agent?.id, { at, kind: record.event.kind }]));
  for (const { kind } of last.values()) expect(kind).toBe("agent_ended");
});
