// What is checked before a tool runs is carried by pi's own hook for it (`beforeToolCall`, §13.3):
// the player's Never and Confirm, a rule that holds the call, a tool switched off on the server, and
// the turn's limits, for a tool of the agent's own list and for one found through `tool_use` alike.
// pi settles every call of a message there before any of them runs, so a call it refuses ends before
// the next call of the same message begins, nothing of the message runs while the player is asked,
// the refusal is the call's answer in the file's words, and the tool's own `run` is never called.
// Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalAnswer, ApprovalsPort, LanePermission, SwitchesPort, TraceRecord } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import type { LinesPart } from "../../src/files/api";
import { gate, type HostToolFixture, request, type Stage, stage, textOf } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [ledger_open, tide_table, bell_toll, dice_roll, tool_search, tool_use]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";

const HOLD = "---\ndescription: Fixture - the bell is not tolled at night.\nagents: all\nscope: [arguments:bell_toll]\ncondition: night\nhold: true\n---\nFixture rule: the bell stays silent at night.\n";

const DICE_TOWER = { kind: "mcp-server", name: "dice-tower", target: "dice-tower --stdio" } as const;

/** The host's tools; each records its runs in `ran`. */
function hostTools(ran: string[]): Record<string, HostToolFixture> {
  const runs = (name: string, text: string): HostToolFixture["run"] => async (args) => {
    ran.push(`${name} ${JSON.stringify(args)}`);
    return { content: [{ type: "text", text }] };
  };
  return {
    ledger_open: { tier: "write", lane: "engine", family: "money", description: "Fixture: opens a ledger for a holder.", parameters: { properties: { holder: { type: "string" } }, required: ["holder"] }, run: runs("ledger_open", "Ledger opened.") },
    tide_table: { tier: "read", family: "tides", description: "Fixture: gives the tide table for a day.", parameters: { properties: { day: { type: "integer" } }, required: ["day"] }, run: runs("tide_table", "High water at six.") },
    bell_toll: { tier: "read", family: "bells", description: "Fixture: tolls the drowned bell.", parameters: { properties: { when: { type: "string" } }, required: ["when"] }, run: runs("bell_toll", "The bell tolls.") },
    dice_roll: { tier: "external", family: "dice", description: "Fixture: rolls dice on the dice tower.", parameters: { properties: { formula: { type: "string" } }, required: ["formula"] }, switchable: DICE_TOWER, run: runs("dice_roll", "17") },
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

/**
 * Whether pi ran the call's tool at all: pi gives a call's result message the time its tool took
 * only when it executed the tool, so a call its hook before it blocked has none.
 */
function executed(s: Stage, callId: string): boolean {
  for (const req of s.model.requests) {
    const found = req.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    if (found !== undefined) return "durationMs" in found && typeof found.durationMs === "number";
  }
  return false;
}

async function notices(s: Stage): Promise<LinesPart> {
  const part = await loadGuidance(s.env.files, request("t1").scope).part("tool-notices");
  if (part?.format !== "lines") throw new Error("tool-notices.md is a lines part.");
  return part;
}

/** The starts and ends of tool calls in the trace, in order, as `started:<call>` and `ended:<call>`. */
function toolOrder(s: Stage): string[] {
  return s.trace.records.flatMap((record) => (record.event.kind === "tool_started" ? [`started:${record.event.callId}`] : record.event.kind === "tool_ended" ? [`ended:${record.event.callId}`] : []));
}

function ended(s: Stage, callId: string): Extract<TraceRecord["event"], { kind: "tool_ended" }> | undefined {
  return s.trace.of("tool_ended").find((record) => record.event.callId === callId)?.event;
}

/** The player's settings per lane, and what he answers when asked; each question is recorded as `tool:call`, and the first can be held until the test lets it be answered. */
function player(lanes: Readonly<Record<string, LanePermission>>, answer: ApprovalAnswer, holdFirst?: Promise<void>): ApprovalsPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    permission: async (_scope, lane) => lanes[lane] ?? "auto",
    ask: async (_scope, ask) => {
      asked.push(`${ask.tool}:${ask.callId}`);
      if (asked.length === 1 && holdFirst !== undefined) await holdFirst;
      return answer;
    },
  };
}

const REPLY = { pieces: [{ text: "<reply>The tide turns at six.</reply>" }] };

describe("before a tool runs, in pi's beforeToolCall", () => {
  test("a write to a lane the player set to Never: refused in the file's words, ended before the next call of its message begins, with the permission it was refused under; its tool never runs", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD },
      approvals: player({ engine: "never" }, { go: true }),
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "ledger_open", args: { holder: "Mira" }, id: "w-1" }, { call: "tide_table", args: { day: 3 }, id: "r-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    expect(ran).toEqual(['tide_table {"day":3}']);
    expect(answerTo(s, "w-1")).toBe(lines.line("never", { tool: "ledger_open", lane: "engine" }) ?? "");
    expect(toolOrder(s)).toEqual(["started:w-1", "ended:w-1", "started:r-1", "ended:r-1"]);
    expect([executed(s, "w-1"), executed(s, "r-1")]).toEqual([false, true]);
    expect(ended(s, "w-1")).toMatchObject({ tool: "ledger_open", clean: false, permission: { lane: "engine", setting: "never" } });
  });

  test("Confirm: the player is asked about a tool of the lead's own list and about the same tool found through tool_use, each under its own name; nothing else of the message starts while he is asked, and on his no the tool never runs", async () => {
    const answered = gate();
    const port = player({ engine: "confirm" }, { go: false, reason: "Not tonight." }, answered.opened);
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD },
      approvals: port,
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "ledger_open", args: { holder: "Mira" }, id: "w-1" }, { call: "tool_use", args: { name: "ledger_open", args: { holder: "Okoro" } }, id: "u-1" }] }, REPLY],
    }));

    const turn = s.turn(request("t1", { lead: "lead" }));
    await s.trace.seen((record) => record.event.kind === "approval_asked");
    // Everything that can happen while he is asked has happened: the found call has not begun, and nobody else was asked.
    await s.clock.idle();
    expect(port.asked).toEqual(["ledger_open:w-1"]);
    expect(toolOrder(s)).toEqual(["started:w-1"]);
    answered.open();
    expect((await turn).outcome.status).toBe("released");

    const lines = await notices(s);
    const declined = lines.line("declined", { tool: "ledger_open", reason: "Not tonight." }) ?? "";
    expect(port.asked).toEqual(["ledger_open:w-1", "ledger_open:u-1"]);
    expect(ran).toEqual([]);
    expect([answerTo(s, "w-1"), answerTo(s, "u-1")]).toEqual([declined, declined]);
    expect(s.trace.of("tool_started").map((record) => [record.event.callId, record.event.tool, record.event.via])).toEqual([
      ["w-1", "ledger_open", undefined],
      ["u-1", "ledger_open", "tool_use"],
    ]);
    expect(toolOrder(s)).toEqual(["started:w-1", "ended:w-1", "started:u-1", "ended:u-1"]);
    // The question was asked in the hook before the tool, which blocked it: pi never executed the call. (The found call's carrier, tool_use, is executed in either case; inside it, pi's runToolCall takes the found tool through the same hook.)
    expect(executed(s, "w-1")).toBe(false);
  });

  test("a rule that holds the call's arguments: its text is the call's answer, ended before the next call of its message begins; the tool never runs", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".rules/fixture-hold.md": HOLD },
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "bell_toll", args: { when: "at night" }, id: "h-1" }, { call: "tide_table", args: { day: 1 }, id: "r-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    expect(ran).toEqual(['tide_table {"day":1}']);
    expect(answerTo(s, "h-1")).toBe("Fixture rule: the bell stays silent at night.");
    expect(toolOrder(s)).toEqual(["started:h-1", "ended:h-1", "started:r-1", "ended:r-1"]);
    expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.action, record.event.firing.callId])).toEqual([["fixture-hold", "hold", "h-1"]]);
    expect(ended(s, "h-1")?.result.content).toEqual([{ type: "text", text: "Fixture rule: the bell stays silent at night." }]);
  });

  test("a tool switched off on the server: refused in the file's words, ended before the next call of its message begins; it never runs", async () => {
    const ran: string[] = [];
    const off: SwitchesPort = { state: async () => "off" };
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD },
      switches: off,
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "dice_roll", args: { formula: "2d6" }, id: "x-1" }, { call: "tide_table", args: { day: 2 }, id: "r-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    expect(ran).toEqual(['tide_table {"day":2}']);
    expect(answerTo(s, "x-1")).toBe(lines.line("not_switched_on", { tool: "dice_roll", name: "dice-tower", kind: "mcp-server" }) ?? "");
    // Refused by the switch: its end gives that reason as a fact, and the permission it would have run under.
    expect(ended(s, "x-1")).toMatchObject({ permission: { lane: "external", setting: "auto" }, refused: { by: "switch", thing: DICE_TOWER, state: "off" } });
  });

  test("once the turn's tokens have run out no tool starts: the work ends at that limit and says which, and the call it kept from running still ends in the trace", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD },
      // Above the least room an answer is given (256 by default), so the first call is made; its answer spends past it.
      config: "limits:\n  turn:\n    tokensOut: 300\n",
      tools: hostTools(ran),
      answers: [{ pieces: [{ text: "Checking the tide." }, { call: "tide_table", args: { day: 2 }, id: "r-1" }], usage: { input: 400, output: 320 } }, REPLY],
    }));

    const { outcome } = await s.turn(request("t1", { lead: "lead" }));

    const lines = await notices(s);
    expect(outcome.status).toBe("limit");
    expect(outcome.limit).toMatchObject({ limit: "tokensOut", per: "turn", max: 300, value: 320 });
    expect(ran).toEqual([]);
    expect(s.model.requests).toHaveLength(1);
    const kinds = s.trace.records.map((record) => (record.event.kind === "tool_started" || record.event.kind === "tool_ended" ? `${record.event.kind}:${record.event.callId}` : record.event.kind));
    expect(kinds.slice(kinds.indexOf("tool_started:r-1"))).toEqual(["tool_started:r-1", "limit", "tool_ended:r-1", "agent_ended", "run_ended"]);
    // It never started: its own line, not the line for a call that may have done its work, and its end says why.
    expect(ended(s, "r-1")).toMatchObject({ result: { content: [{ type: "text", text: lines.line("not_started", { tool: "tide_table" }) ?? "" }], error: true }, clean: false, refused: { by: "limit", hit: { limit: "tokensOut", per: "turn", max: 300, value: 320 } } });
    expect(lines.line("not_started", { tool: "tide_table" })).not.toBe(lines.line("unfinished", { tool: "tide_table" }));
  });

  test("a found tool stopped by a spent limit before its carrier began, and one refused by a switch: each recorded under its own name, the stopped one answered with its own line; a write so stopped names its lane; each end record gives its reason", async () => {
    // Refused by the switch through tool_use: recorded as the tool it named, with the switch's state.
    const waiting: SwitchesPort = { state: async () => "waiting" };
    const switched = (open = await stage({
      files: { ".agents/lead.md": LEAD },
      switches: waiting,
      tools: hostTools([]),
      answers: [{ pieces: [{ call: "tool_use", args: { name: "dice_roll", args: { formula: "2d6" } }, id: "u-2" }] }, REPLY],
    }));
    expect((await switched.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
    expect(switched.trace.of("tool_started").find((record) => record.event.callId === "u-2")?.event).toMatchObject({ tool: "dice_roll", via: "tool_use", args: { formula: "2d6" } });
    expect(ended(switched, "u-2")).toMatchObject({ tool: "dice_roll", refused: { by: "switch", thing: DICE_TOWER, state: "waiting" } });
    await switched.close();

    // Stopped by a spent limit before its carrier began: recorded as the write it named, with its lane, its own line and the limit.
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD },
      config: "limits:\n  turn:\n    tokensOut: 300\n",
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "tool_use", args: { name: "ledger_open", args: { holder: "Mira" } }, id: "u-1" }], usage: { input: 400, output: 320 } }, REPLY],
    }));
    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("limit");
    const lines = await notices(s);
    expect(ran).toEqual([]);
    expect(s.trace.of("tool_started").find((record) => record.event.callId === "u-1")?.event).toMatchObject({ tool: "ledger_open", via: "tool_use", args: { holder: "Mira" } });
    expect(ended(s, "u-1")).toMatchObject({
      tool: "ledger_open",
      result: { content: [{ type: "text", text: lines.line("not_started", { tool: "ledger_open" }) ?? "" }], error: true },
      permission: { lane: "engine", setting: "auto" },
      refused: { by: "limit", hit: { limit: "tokensOut", per: "turn" } },
    });
  });

  test("the last call a calls limit allows runs its tools, as today's budget controls do, and no further model call is made (R-194)", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD.replace("given:", "limits: { calls: 1 }\ngiven:") },
      tools: hostTools(ran),
      answers: [{ pieces: [{ text: "Checking the tide." }, { call: "tide_table", args: { day: 4 }, id: "r-1" }] }, REPLY],
    }));

    const { outcome } = await s.turn(request("t1", { lead: "lead" }));

    expect(ran).toEqual(['tide_table {"day":4}']);
    expect(s.model.requests).toHaveLength(1);
    expect(outcome.status).toBe("limit");
    expect(outcome.limit).toMatchObject({ limit: "calls", per: "agent", max: 1, value: 1 });
    expect(ended(s, "r-1")).toMatchObject({ result: { content: [{ type: "text", text: "High water at six." }] }, clean: true });
  });
});
