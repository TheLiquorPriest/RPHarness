// A call through `tool_use`, as a turn runs it (§6.8): the found tool is run by the calling agent's
// own runner as itself, so the player's Never for its lane refuses it, a rule that holds its
// arguments holds it, its long result is clipped once, a closing call ends the run on its own result,
// and `ask_author` reached this way puts the question to the agent that gave the work. Everything
// here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalsPort, ToolResult } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import type { LinesPart } from "../../src/files/api";
import { type HostToolFixture, request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** A tide table long enough to be clipped at the stage's setting. */
const TIDES = `High water at Gannet Rock: ${"six hours on, six hours off; ".repeat(8)}`.trim();

const HOLD = "---\ndescription: Fixture - the bell is not tolled at night.\nagents: all\nscope: [arguments:bell_toll]\ncondition: night\nhold: true\n---\nFixture rule: the bell stays silent at night.\n";

/** The host's tools, none of them in the lead's list: each records its runs in `ran`. */
function hostTools(ran: string[], extra: Partial<Record<string, Partial<HostToolFixture>>> = {}): Record<string, HostToolFixture> {
  const tool = (name: string, fixture: Omit<HostToolFixture, "run">, result: ToolResult): HostToolFixture => ({
    ...fixture,
    run: async (args) => {
      ran.push(`${name} ${JSON.stringify(args)}`);
      return result;
    },
    ...extra[name],
  });
  return {
    ledger_open: tool("ledger_open", { tier: "write", lane: "engine", family: "money", description: "Fixture: opens a ledger for a holder.", parameters: { properties: { holder: { type: "string" } }, required: ["holder"] } }, { content: [{ type: "text", text: "Ledger opened." }] }),
    bell_toll: tool("bell_toll", { tier: "read", family: "bells", description: "Fixture: tolls the drowned bell.", parameters: { properties: { when: { type: "string" } }, required: ["when"] } }, { content: [{ type: "text", text: "The bell tolls." }] }),
    tide_table: tool("tide_table", { tier: "read", family: "tides", description: "Fixture: gives the tide table for a day.", parameters: { properties: { day: { type: "integer" } }, required: ["day"] } }, { content: [{ type: "text", text: TIDES }] }),
  };
}

/** The answer a call got, as the model read it in a later request. */
function answerTo(s: Stage, callId: string): string {
  for (const req of s.model.requests) {
    const found = req.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    if (found !== undefined) return textOf(found);
  }
  return "";
}

async function notices(s: Stage): Promise<LinesPart> {
  const part = await loadGuidance(s.env.files, request("t1").scope).part("tool-notices");
  if (part?.format !== "lines") throw new Error("tool-notices.md is a lines part.");
  return part;
}

const NEVER_ON_ENGINE: ApprovalsPort = { permission: async (_scope, lane) => (lane === "engine" ? "never" : "auto"), ask: async () => ({ go: true }) };

describe("a call through tool_use", () => {
  test("the found tool is refused by the player's Never, held by a rule on its arguments, and clipped once, each as itself; its arguments are taken by its own schema", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      config: "results:\n  clip: 40\n",
      files: { ".rules/fixture-hold.md": HOLD },
      approvals: NEVER_ON_ENGINE,
      tools: hostTools(ran),
      answers: [
        {
          pieces: [
            { call: "tool_use", args: { name: "ledger_open", args: { holder: "Mira" } }, id: "never-1" },
            { call: "tool_use", args: { name: "bell_toll", args: { when: "at night" } }, id: "hold-1" },
            { call: "tool_use", args: { name: "tide_table", args: { day: "3" } }, id: "clip-1" },
          ],
        },
        { pieces: [{ text: "<reply>The tide turns at six.</reply>" }] },
      ],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    expect(answerTo(s, "never-1")).toBe(lines.line("never", { tool: "ledger_open", lane: "engine" }) ?? "");
    expect(answerTo(s, "hold-1")).toContain("Fixture rule: the bell stays silent at night.");
    const kept = `sessions/s1/turns/t1/cache/results/clip-1.md`;
    expect(answerTo(s, "clip-1")).toBe(`${TIDES.slice(0, 40)}${lines.line("clipped", { shown: 40, length: TIDES.length, path: kept }) ?? ""}`);
    const whole = await s.env.files.read(request("t1").scope, kept);
    expect(whole.status === "read" ? whole.text : "").toBe(TIDES);
    // Only the clipped tool ran, with the day its own schema made a whole number.
    expect(ran).toEqual(['tide_table {"day":3}']);
    expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.tool, record.event.firing.callId])).toEqual([["fixture-hold", "bell_toll", "hold-1"]]);
  });

  test("a closing call through tool_use ends the run on the found tool's own answer: a clean one ends it, one that reports something goes on for one more call", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      tools: hostTools(ran, { bell_toll: { run: async () => ({ content: [{ type: "text", text: "The bell tolls." }], reports: ["The rope is frayed."] }) } }),
      answers: [
        { pieces: [{ text: "<reply>The tide turns.</reply>" }, { call: "tool_use", args: { name: "tide_table", args: { day: 1 }, closing: true }, id: "close-1" }] },
        // The next turn: the closing call's answer reports something, so the lead is called once more.
        { pieces: [{ text: "<reply>The bell tolls.</reply>" }, { call: "tool_use", args: { name: "bell_toll", args: { when: "at dawn" }, closing: true }, id: "close-2" }] },
        { pieces: [{ text: "Noted: the rope." }] },
      ],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
    expect(s.model.requests).toHaveLength(1);
    expect((await s.turn(request("t2", { lead: "lead" }))).outcome.status).toBe("released");
    expect(s.model.requests).toHaveLength(3);
    expect(answerTo(s, "close-2")).toContain("The rope is frayed.");
    expect(ran).toEqual(['tide_table {"day":1}']);
  });

  test("ask_author reached through tool_use puts the question to the agent that gave the work, and the answer comes back as that call's answer", async () => {
    const lead = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [delegate, agent_message, tool_search, tool_use]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";
    const gm = "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: [tool_search, tool_use]\n---\nFixture GM: rule on what you are asked.\n";
    const s = (open = await stage({
      files: { ".agents/lead.md": lead, ".agents/gm.md": gm },
      answers: [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Can she make the jump?" }, id: "d-1" }] },
        { pieces: [{ call: "tool_use", args: { name: "ask_author", args: { question: "How wide is the gap?", searched: "The scene file names no width." } }, id: "u-1" }] },
        { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Twenty feet." }, id: "m-1" }] },
        { pieces: [{ text: "At twenty feet the jump fails." }] },
        { pieces: [{ text: "<reply>She falls short.</reply>" }] },
      ],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    // The question came back to the lead as the delegate call's answer, marked as a question.
    expect(answerTo(s, "d-1")).toContain("How wide is the gap?");
    const delegated = s.trace.of("tool_ended").find((record) => record.event.callId === "d-1");
    expect(delegated?.event.result.marks).toEqual(["question"]);
    // The lead's message is the answer the GM's tool_use call got, and its work went on from there.
    expect(answerTo(s, "u-1")).toBe("Twenty feet.");
    expect(answerTo(s, "m-1")).toContain("At twenty feet the jump fails.");
  });
});
