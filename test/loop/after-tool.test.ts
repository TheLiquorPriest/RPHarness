// After a tool, pi's own hook for it (`afterToolCall`, §13.3) carries the rules on its result and
// the bound on what the model reads of one call (`results.clipChars`, R-118): the tool's answer and
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
      config: "results:\n  clipChars: 120\n",
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
      config: "results:\n  clipChars: 120\n",
      tools: hostTools(ran),
      answers: [{ pieces: [{ call: "tide_table", args: { day: 9 }, id: "f-1" }, { call: "tool_use", args: { name: "tide_table", args: { day: 10 } }, id: "u-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    expect(ran).toEqual(['tide_table {"day":9}', 'tide_table {"day":10}']);
    // The two calls of one message run side by side, so which result's rule is traced first is not fixed: they are compared call by call.
    const fired = s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.tool, record.event.firing.moment, record.event.firing.callId]);
    expect(fired.sort((a, b) => `${a[3]}`.localeCompare(`${b[3]}`))).toEqual([
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
      config: "results:\n  clipChars: 30\n",
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

  test("a write that went through, with a result rule that throws and a keeping that fails: the model reads the write's own answer and the two lines beside it, the log names both, and the write is made once", async () => {
    const ran: string[] = [];
    const written = "Ledger opened for Mira, with forty silver marks entered on its first page.";
    let breakRules = false;
    const tools = hostTools(ran);
    const ledger = tools["ledger_open"];
    if (ledger === undefined) throw new Error("The fixture has no ledger_open.");
    tools["ledger_open"] = {
      ...ledger,
      run: async (args) => {
        ran.push(`ledger_open ${JSON.stringify(args)}`);
        // The rules on its result are read next: that read fails once.
        breakRules = true;
        return { content: [{ type: "text", text: written }] };
      },
    };
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".rules/fixture-tides.md": TIDE_RULE },
      config: "results:\n  clipChars: 30\n",
      tools,
      filesPort: (inner) => ({
        layers: async (scope) => {
          if (!breakRules) return inner.layers(scope);
          breakRules = false;
          throw new Error("Fixture: the levels cannot be listed.");
        },
        places: (scope) => inner.places(scope),
        find: (scope, query) => inner.find(scope, query),
        read: (scope, path, range) => inner.read(scope, path, range),
        write: async (scope, path, op, by) => {
          if (path.includes("cache/results/")) throw new Error("Fixture: the disk is full.");
          return inner.write(scope, path, op, by);
        },
      }),
      answers: [{ pieces: [{ call: "ledger_open", args: { holder: "Mira" }, id: "w-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    expect(ran).toEqual(['ledger_open {"holder":"Mira"}']);
    const answer = answerTo(s, "w-1");
    expect(answer).toStartWith(written.slice(0, 30));
    expect(answer).toContain(lines.line("rule_unasked", { tool: "ledger_open" }) ?? "?");
    expect(answer).toContain(lines.line("not_kept", { tool: "ledger_open" }) ?? "?");
    expect(answer).not.toContain(lines.line("failed", { tool: "ledger_open" }) ?? "?");
    expect(s.logged.map((line) => line.message)).toEqual(expect.arrayContaining(["The rules on a tool's answer could not be asked; the answer stands as the tool gave it.", "A clipped tool answer's whole could not be kept."]));
  });

  test("an answer pi words for a long refused argument list keeps to the clip, its whole kept", async () => {
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD },
      config: "results:\n  clipChars: 60\n",
      tools: hostTools([]),
      answers: [{ pieces: [{ call: "tide_table", args: { day: "the ninth ".repeat(40) }, id: "p-1" }] }, REPLY],
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

    const lines = await notices(s);
    // pi's own refusal, worded by the runner with the tool's whole schema: longer than the setting.
    const whole = await kept(s, "p-1");
    expect(whole.length).toBeGreaterThan(60);
    expect(answerTo(s, "p-1")).toBe(clipped(lines, whole, 60, "p-1"));
    expect(s.trace.of("tool_ended").find((record) => record.event.callId === "p-1")?.event.result.content).toEqual([{ type: "text", text: whole.slice(0, 60) }, { type: "text", text: lines.line("clipped", { shown: 60, length: whole.length, left: whole.length - 60, path: "sessions/s1/turns/t1/cache/results/p-1.md" }) ?? "" }]);
  });

  test("a job from the Jobs page with a long answer: the whole is in its session's cache/ and the line names it", async () => {
    const keeper = "---\nname: keeper\ndescription: Fixture keeper.\nmodel: default\ntools: [tide_table]\n---\nFixture keeper: you read the tides.\n";
    const s = (open = await stage({
      files: { ".agents/keeper.md": keeper },
      config: "results:\n  clipChars: 40\n",
      tools: hostTools([]),
      answers: [{ pieces: [{ call: "tide_table", args: { day: 9 }, id: "j-1" }] }, { pieces: [{ text: "Read." }] }],
    }));
    const scope = { user: request("t1").scope.user, chat: request("t1").scope.chat, session: "s1" };

    const started = await s.harness.jobs.start(scope, { agent: "keeper", brief: "Read the tides for the ninth." });
    if ("refused" in started) throw new Error("The job was not started.");
    await s.trace.seen(() => s.trace.records.some((record) => record.event.kind === "job" && record.event.job.state === "done"));

    // A job runs in a session of its own, with no turn: the whole goes in that session's cache/.
    const lines = await notices(s);
    const path = `sessions/${started.scope.session}/cache/results/j-1.md`;
    const read = await s.env.files.read(started.scope, path);
    expect(read.status === "read" ? read.text : "").toBe(TIDES);
    expect(answerTo(s, "j-1")).toBe(`${TIDES.slice(0, 40)}${lines.line("clipped", { shown: 40, length: TIDES.length, left: TIDES.length - 40, path }) ?? ""}`);
  });
});
