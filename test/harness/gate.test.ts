// What runs around each tool call (§13.3, §6.8, §5.4): the user's permission for what a tool writes,
// the rules on its arguments and its result, a long result clipped, and a call that cannot run or
// whose tool failed, each answered in the words of a file, never in pi's or an exception's own.
import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ApprovalAnswer, ApprovalsPort, LanePermission, RuleFiring } from "../../src/contract";
import { request, said, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** The answer a call got, as the model read it on its next request. */
function answered(messages: readonly Message[], callId: string): string {
  const result = messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
  return result === undefined ? "" : textOf(result);
}

function approvals(permission: LanePermission, answer: ApprovalAnswer = { go: true }): ApprovalsPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    permission: async () => permission,
    ask: async (_scope, ask) => {
      asked.push(`${ask.tool}:${ask.lane}`);
      return answer;
    },
  };
}

const RESULT_RULE = "---\ndescription: Fixture - reminds when a write comes back marked unsourced.\nagents: [author]\ncondition: marked unsourced\nscope: [result:world_apply]\n---\nFixture rule: say where that came from.\n";
const HOLD_RULE = "---\ndescription: Fixture - holds a write to the vault.\nagents: [author]\ncondition: vault\nscope: [arguments:world_apply]\nhold: true\n---\nFixture rule: the vault stays shut.\n";

describe("permissions", () => {
  test("a write to a lane the player set to Never is refused in the file's words, and the tool never runs", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      drafted: true,
      approvals: approvals("never"),
      tools: { world_apply: { tier: "write", lane: "engine", description: "Fixture: records a change.", run: async () => (ran.push("world_apply"), said("recorded")) } },
      answers: [{ pieces: [{ call: "world_apply", args: {} }] }, { pieces: [{ text: "<reply>Nothing changes.</reply>" }] }],
    }));

    await s.turn(request("t1"));

    expect(ran).toEqual([]);
    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe("world_apply was not run: it writes to engine, where the player allows no writes.");
  });

  test("Confirm: the player is asked, the trace shows the question and the answer, and a no comes back with the player's reason", async () => {
    const ran: string[] = [];
    const port = approvals("confirm", { go: false, reason: "Not tonight." });
    const s = (open = await stage({
      drafted: true,
      approvals: port,
      tools: { world_apply: { tier: "write", lane: "engine", description: "Fixture: records a change.", run: async () => (ran.push("world_apply"), said("recorded")) } },
      answers: [{ pieces: [{ call: "world_apply", args: {} }] }, { pieces: [{ text: "<reply>Nothing changes.</reply>" }] }],
    }));

    await s.turn(request("t1"));

    expect(port.asked).toEqual(["world_apply:engine"]);
    expect(ran).toEqual([]);
    expect(s.trace.of("approval_answered").map((record) => record.event.answer)).toEqual([{ go: false, reason: "Not tonight." }]);
    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe("world_apply was not run: the player said no. Their reason: Not tonight.");
  });
});

describe("rules on a tool call", () => {
  test("a rule on a tool's result adds its text after the result, and a closing call that drew it does not end the run", async () => {
    const s = (open = await stage({
      drafted: true,
      files: { ".rules/fixture-unsourced.md": RESULT_RULE },
      tools: { world_apply: { tier: "write", lane: "engine", description: "Fixture: records a change.", run: async () => ({ content: [{ type: "text", text: "recorded: the boat is lost" }], marks: ["unsourced"] }) } },
      answers: [{ pieces: [{ text: "<reply>The boat is lost.</reply>" }, { call: "world_apply", args: { closing: true } }] }, { pieces: [{ text: "From the chat, message four." }] }],
    }));

    await s.turn(request("t1"));

    expect(s.model.requests).toHaveLength(2);
    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe("recorded: the boat is lostFixture rule: say where that came from.");
    expect(s.trace.of("tool_ended").map((record) => [record.event.clean, record.event.endedRun])).toEqual([[false, false]]);
    const fired = s.told.filter((told) => told.kind === "ruleFired").map((told) => told.payload as RuleFiring);
    expect(fired).toMatchObject([{ rule: "fixture-unsourced", moment: "tool-result", action: "remind", callId: "call_1_1", tool: "world_apply", then: { did: "wrote" } }]);
  });

  test("a rule on a tool's arguments that holds it: the tool never runs, and the rule's text is its answer", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      drafted: true,
      files: { ".rules/fixture-vault.md": HOLD_RULE },
      tools: { world_apply: { tier: "write", lane: "engine", description: "Fixture: records a change.", parameters: { properties: { what: { type: "string" } } }, run: async () => (ran.push("world_apply"), said("recorded")) } },
      answers: [{ pieces: [{ call: "world_apply", args: { what: "open the vault" } }] }, { pieces: [{ text: "<reply>The vault stays shut.</reply>" }] }],
    }));

    await s.turn(request("t1"));

    expect(ran).toEqual([]);
    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe("Fixture rule: the vault stays shut.");
    expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.action])).toEqual([["fixture-vault", "hold"]]);
  });
});

describe("answers in a file's words", () => {
  test("a tool that throws is answered with the file's line, holding the error's own words", async () => {
    const s = (open = await stage({
      drafted: true,
      tools: {
        world_query: {
          tier: "read",
          description: "Fixture: a read whose store is locked.",
          run: async () => {
            throw new Error("Fixture: the ledger is locked.");
          },
        },
      },
      answers: [{ pieces: [{ call: "world_query", args: { closing: true } }] }, { pieces: [{ text: "<reply>The ledger stays shut.</reply>" }] }],
    }));

    await s.turn(request("t1"));

    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe("world_query failed: Fixture: the ledger is locked.");
  });

  test("a call to a tool the agent does not hold, arguments that do not fit, and arguments cut short by the length limit: never pi's own words", async () => {
    const s = (open = await stage({
      drafted: true,
      answers: [
        { pieces: [{ call: "fly_away", args: {} }, { call: "file_read", args: {} }] },
        { pieces: [{ call: "todo", args: { items: [] } }], end: "length" },
        { pieces: [{ text: "<reply>Grounded.</reply>" }] },
      ],
    }));

    await s.turn(request("t1"));

    const second = s.model.requests[1]!.messages;
    expect(answered(second, "call_1_1")).toBe("You hold no tool named fly_away.");
    expect(answered(second, "call_1_2")).toStartWith("file_read was not run: the arguments you sent do not fit what it takes. It takes {");
    expect(answered(s.model.requests[2]!.messages, "call_2_1")).toBe("todo was not run: your message reached its length limit, so its arguments may be cut short. Call it again.");
  });

  test("a long result reaches the model clipped to the setting, and its whole is kept in the turn's folder, where the line says", async () => {
    const long = "The tide table for the week: ".padEnd(100, "x");
    const s = (open = await stage({
      drafted: true,
      config: "results:\n  clip: 40\n",
      tools: { world_query: { tier: "read", description: "Fixture: a long read.", run: async () => said(long) } },
      answers: [{ pieces: [{ call: "world_query" }] }, { pieces: [{ text: "<reply>High water at six.</reply>" }] }],
    }));

    await s.turn(request("t1"));

    const kept = "sessions/s1/turns/t1/cache/results/call_1_1.md";
    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe(`${long.slice(0, 40)}[40 of 100 characters shown. The whole result is in ${kept}.]`);
    const read = await s.host.files.read(request("t1").scope, kept);
    expect(read.status === "read" ? read.text : "").toBe(long);
  });
});
