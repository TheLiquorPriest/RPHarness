// `ask_author` and `agent_message` (§10.5, §13.3): a sub-agent's question ends its work and comes
// back as the answer to the lead's `delegate`, marked as a question; the lead's message continues
// the same agent where it stopped, with everything it had, and a consent given with it is
// recorded as the contract's `ConsentGrant`.
import { afterEach, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { definition, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = definition("lead", { model: "lead-model", tools: ["delegate", "agent_message", "ask_author"] }, "Fixture lead: you run the turn.");
const GM = definition("gm", { model: "gm-model", tools: ["ask_author"] }, "Fixture GM: rule on what you are asked.");

function lastResult(messages: readonly Message[]): string {
  const result = messages.filter((message) => message.role === "toolResult").at(-1);
  return result === undefined ? "" : textOf(result);
}

test("a question comes back through delegate, marked; the answer continues the same run with everything it had; the consent is kept", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM },
    models: {
      "lead-model": [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump to the far ledge." }, id: "d-1" }] },
        { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Twenty feet. The rail may be rotten or sound; say which.", consent: { topic: "the state of the rail", bounds: "rotten or sound, nothing more", gap_check: "gap-7" } }, id: "m-1" }] },
        { pieces: [{ text: "Settled." }] },
      ],
      "gm-model": [
        { pieces: [{ text: "Measuring." }, { call: "ask_author", args: { question: "How wide is the gap?", searched: "the scene notes and the lore of the rock" }, id: "a-1" }] },
        { pieces: [{ text: "At twenty feet, and with the rail rotten, the jump fails." }] },
      ],
    },
  }));

  const turn = await s.play("She leaps for the far ledge.");
  const outcome = await turn.done;

  expect(outcome.status).toBe("done");
  const lead = s.models["lead-model"]!.requests;
  // The question is the answer to the delegate call, laid out by the question's part, and marked.
  expect(lastResult(lead[1]!.messages)).toBe("gm-1 stopped to ask before going on:\n\nHow wide is the gap?\n\nWhat it found before asking:\n\nthe scene notes and the lore of the rock");
  const delegated = s.trace.of("tool_ended").find((record) => record.event.callId === "d-1");
  expect(delegated?.event.result.marks).toEqual(["question"]);
  // The answer went on with the same agent: its earlier messages, then the lead's words as its question's answer.
  const gm = s.models["gm-model"]!.requests;
  expect(gm).toHaveLength(2);
  expect(gm[1]!.messages.slice(0, 2)).toEqual(gm[0]!.messages);
  expect(gm[1]!.messages.slice(2).map((message) => [message.role, textOf(message)])).toEqual([
    ["assistant", "Measuring."],
    ["toolResult", "Twenty feet. The rail may be rotten or sound; say which."],
  ]);
  expect(lastResult(lead[2]!.messages)).toBe("gm-1 answered:\n\nAt twenty feet, and with the rail rotten, the jump fails.");
  // One agent, two stretches of work: each under the call that set it going.
  const stretches = s.trace.records.filter((record) => record.agent.id === "gm-1" && (record.event.kind === "agent_started" || record.event.kind === "agent_ended"));
  expect(stretches.map((record) => [record.event.kind, record.event.kind === "agent_ended" ? record.event.status : record.parent?.call])).toEqual([
    ["agent_started", "d-1"],
    ["agent_ended", "asked"],
    ["agent_started", "m-1"],
    ["agent_ended", "done"],
  ]);
  // The consent, as the contract records one, told to the host and kept with the turn.
  const grant = { id: expect.any(String), by: turn.lead, to: { id: "gm-1", definition: "gm", parent: turn.lead.id }, via: { kind: "answer" as const, callId: "m-1" }, topic: "the state of the rail", bounds: "rotten or sound, nothing more", gapCheck: "gap-7" };
  expect(s.told.filter((item) => item.kind === "consent")).toEqual([{ kind: "consent", grant }]);
  expect((await s.kept("events")).filter((line) => line["kind"] === "consent").map((line) => line["grant"])).toEqual([grant]);
});

test("a message to a name no agent goes by, and a question from the run's own first agent, are answered in the file's words, and the run goes on", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM },
    models: {
      "lead-model": [
        { pieces: [{ call: "agent_message", args: { agent: "gm-4", message: "Go on." }, id: "m-1" }, { call: "ask_author", args: { question: "Who leads?", searched: "nowhere" }, id: "a-1" }] },
        { pieces: [{ text: "Settled." }] },
      ],
      "gm-model": [],
    },
  }));

  const outcome = await (await s.play("She waits.")).done;

  expect(outcome).toMatchObject({ status: "done", text: "Settled." });
  const results = s.models["lead-model"]!.requests[1]!.messages.filter((message) => message.role === "toolResult").map(textOf);
  expect(results).toEqual(["No agent you started this turn goes by gm-4.", "There is no one above you to ask."]);
  expect(s.models["gm-model"]!.requests).toHaveLength(0);
});

const KEEPER = definition("keeper", { model: "keeper-model", tools: ["agent_message"] }, "Fixture keeper: keep the lighthouse's records.");

test("only the agent that started a sub-agent answers or continues it: another agent's message, consent and all, is answered as a handle it does not hold", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM, ".agents/keeper.md": KEEPER },
    models: {
      "lead-model": [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump to the far ledge." }, id: "d-1" }] },
        { pieces: [{ call: "delegate", args: { agent: "keeper", brief: "Note the jump in the log." }, id: "d-2" }] },
        { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Twenty feet." }, id: "m-1" }] },
        { pieces: [{ text: "Settled." }] },
      ],
      "gm-model": [{ pieces: [{ call: "ask_author", args: { question: "How wide is the gap?", searched: "the scene notes" }, id: "a-1" }] }, { pieces: [{ text: "At twenty feet the jump fails." }] }],
      "keeper-model": [
        { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Forty feet, and the rail is sound.", consent: { topic: "the rail" } }, id: "k-1" }] },
        { pieces: [{ text: "Noted." }] },
      ],
    },
  }));

  const outcome = await (await s.play("She leaps for the far ledge.")).done;

  expect(outcome).toMatchObject({ status: "done", text: "Settled." });
  expect(lastResult(s.models["keeper-model"]!.requests[1]!.messages)).toBe("No agent you started this turn goes by gm-1.");
  expect(s.told.filter((item) => item.kind === "consent")).toEqual([]);
  // The question was answered by the lead's message alone, under the lead's call.
  const gm = s.models["gm-model"]!.requests;
  expect(gm).toHaveLength(2);
  expect(lastResult(gm[1]!.messages)).toBe("Twenty feet.");
  const stretches = s.trace.records.filter((record) => record.agent.id === "gm-1" && record.event.kind === "agent_started");
  expect(stretches.map((record) => record.parent?.call)).toEqual(["d-1", "m-1"]);
});
