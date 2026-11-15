// After a tool, pi's own hook for it (`afterToolCall`, §13.3) carries the rules on its result and
// the bound on what the model reads of one call (`results.clip`, R-118): the tool's answer and
// reports, the rules' texts after it, and, for a call answered in its tool's place, a refusal's or a
// hold's words. What the model reads stays within the setting, the clipped line comes last, and the
// whole is kept in the turn's `cache/results/`, where the line says. A tool found through `tool_use`
// is ruled on and bounded as one of the agent's own list is. Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import type { ApprovalsPort } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import type { LinesPart } from "../../src/files/api";
import { type HostToolFixture, request, type Stage, stage, textOf } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [ledger_open, tide_table, bell_toll, tool_search, tool_use]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";

/** The tide table's answer: 80 characters. */
const TIDES = "High water at Gannet Rock at six; low water at noon; spring tides from the ninth.";
/** A rule's text of 100 characters, added after every tide table. */
const RULE_TEXT = "Fixture rule: a tide read from the table is a fact of the world; name the day it holds for, always.";
const TIDE_RULE = `---\ndescription: Fixture - a reminder after every tide table.\nagents: all\nscope: [result:tide_table]\ncondition: High water\nrepeat: always\n---\n${RULE_TEXT}\n`;
const HOLD_TEXT = "Fixture rule: the bell stays silent at night.";
const HOLD = `---\ndescription: Fixture - the bell is not tolled at night.\nagents: all\nscope: [arguments:bell_toll]\ncondition: night\nhold: true\n---\n${HOLD_TEXT}\n`;

const NEVER_ON_ENGINE: ApprovalsPort = { permission: async (_scope, lane) => (lane === "engine" ? "never" : "auto"), ask: async () => ({ go: true }) };

function hostTools(ran: string[]): Record<string, HostToolFixture> {
  const runs = (name: string, text: string): HostToolFixture["run"] => async (args) => {
    ran.push(`${name} ${JSON.stringify(args)}`);
    return { content: [{ type: "text", text }] };
  };
  return {
    ledger_open: { tier: "write", lane: "engine", family: "money", description: "Fixture: opens a ledger for a holder.", parameters: { properties: { holder: { type: "string" } }, required: ["holder"] }, run: runs("ledger_open", "Ledger opened.") },
    tide_table: { tier: "read", family: "tides", description: "Fixture: gives the tide table for a day.", parameters: { properties: { day: { type: "integer" } }, required: ["day"] }, run: runs("tide_table", TIDES) },
    bell_toll: { tier: "read", family: "bells", description: "Fixture: tolls the drowned bell.", parameters: { properties: { when: { type: "string" } }, required: ["when"] }, run: runs("bell_toll", "The bell tolls.") },
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

async function kept(s: Stage, callId: string): Promise<string> {
  const read = await s.env.files.read(request("t1").scope, `sessions/s1/turns/t1/cache/results/${callId}.md`);
  return read.status === "read" ? read.text : "";
}

/** What the model reads of a call cut at `clip`: the first `clip` characters of `whole`, then the clipped line naming the call's kept file. */
function clipped(lines: LinesPart, whole: string, clip: number, callId: string): string {
  return `${whole.slice(0, clip)}${lines.line("clipped", { shown: clip, length: whole.length, left: whole.length - clip, path: `sessions/s1/turns/t1/cache/results/${callId}.md` }) ?? ""}`;
}

const REPLY = { pieces: [{ text: "<reply>High water at six.</reply>" }] };

describe("after a tool, in pi's afterToolCall", () => {
  test("a long answer with a long rule text: the request holds no more of the call than the setting, then the line; the kept file holds all of it", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".rules/fixture-tides.md": TIDE_RULE },
      config: "results:\n  clip: 120\n",
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "tide_table", args: { day: 9 }, id: "f-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    // 80 characters of answer and the first 40 of the rule's text make the 120.
    expect(answerTo(s, "f-1")).toBe(clipped(lines, `${TIDES}${RULE_TEXT}`, 120, "f-1"));
    expect(await kept(s, "f-1")).toBe(`${TIDES}\n${RULE_TEXT}`);
    expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.moment, record.event.firing.action, record.event.firing.callId])).toEqual([["fixture-tides", "tool-result", "remind", "f-1"]]);
  });

  test("a rule on a result fires on a tool found through tool_use as on the same tool of the lead's own list, and the call is bounded alike", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".rules/fixture-tides.md": TIDE_RULE },
      config: "results:\n  clip: 120\n",
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "tide_table", args: { day: 9 }, id: "f-1" }, { call: "tool_use", args: { name: "tide_table", args: { day: 10 } }, id: "u-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    expect(ran).toEqual(['tide_table {"day":9}', 'tide_table {"day":10}']);
    expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.tool, record.event.firing.moment, record.event.firing.callId])).toEqual([
      ["fixture-tides", "tide_table", "tool-result", "f-1"],
      ["fixture-tides", "tide_table", "tool-result", "u-1"],
    ]);
    expect([answerTo(s, "f-1"), answerTo(s, "u-1")]).toEqual([clipped(lines, `${TIDES}${RULE_TEXT}`, 120, "f-1"), clipped(lines, `${TIDES}${RULE_TEXT}`, 120, "u-1")]);
    expect([await kept(s, "f-1"), await kept(s, "u-1")]).toEqual([`${TIDES}\n${RULE_TEXT}`, `${TIDES}\n${RULE_TEXT}`]);
    // The found call is traced as itself, its end with the answer as the bound left it.
    expect(s.trace.of("tool_ended").find((record) => record.event.callId === "u-1")?.event).toMatchObject({ tool: "tide_table", clean: false });
  });

  test("a refusal's and a hold's words are held to the bound too, and their whole is in the file the line names", async () => {
    const ran: string[] = [];
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".rules/fixture-hold.md": HOLD },
      config: "results:\n  clip: 30\n",
      approvals: NEVER_ON_ENGINE,
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "ledger_open", args: { holder: "Mira" }, id: "w-1" }, { call: "bell_toll", args: { when: "at night" }, id: "h-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    const never = lines.line("never", { tool: "ledger_open", lane: "engine" }) ?? "";
    expect(never.length).toBeGreaterThan(30);
    expect(ran).toEqual([]);
    expect(answerTo(s, "w-1")).toBe(clipped(lines, never, 30, "w-1"));
    expect(answerTo(s, "h-1")).toBe(clipped(lines, HOLD_TEXT, 30, "h-1"));
    expect(await kept(s, "w-1")).toBe(never);
    expect(await kept(s, "h-1")).toBe(HOLD_TEXT);
  });
});
