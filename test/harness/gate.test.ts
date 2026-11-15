// What runs around each tool call (§13.3, §6.8, §5.4): the user's permission for what a tool writes,
// the host's switches, each user's own, for a tool that calls out, the rules on its arguments and
// its result, a long result clipped, and a call that cannot run or whose tool failed, each answered
// in the words of a file, never in pi's or an exception's own.
import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ApprovalAnswer, ApprovalsPort, LanePermission, RuleFiring, SwitchesPort } from "../../src/contract";
import { request, said, type Stage, stage, textOf, USER } from "./support";

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

  test("each write is traced with its lane and the permission it ran under: Auto, Confirm with the player's word, and Never, three records; a read carries none", async () => {
    const ran: string[] = [];
    const lanes: Record<string, LanePermission> = { engine: "auto", story: "confirm", cast: "never" };
    const port: ApprovalsPort = { permission: async (_scope, lane) => lanes[lane] ?? "auto", ask: async () => ({ go: true }) };
    const write = (name: string, lane: string) => ({ tier: "write" as const, lane, description: `Fixture: writes to ${lane}.`, run: async () => (ran.push(name), said(`${name} recorded`)) });
    const s = (open = await stage({
      drafted: true,
      approvals: port,
      tools: {
        world_apply: write("world_apply", "engine"),
        story_record: write("story_record", "story"),
        cast_update: write("cast_update", "cast"),
        world_query: { tier: "read", description: "Fixture: reads the world.", run: async () => (ran.push("world_query"), said("the boat is late")) },
      },
      answers: [
        { pieces: [{ call: "world_apply", args: {}, id: "a-1" }, { call: "story_record", args: {}, id: "c-1" }, { call: "cast_update", args: {}, id: "n-1" }, { call: "world_query", args: {}, id: "r-1" }] },
        { pieces: [{ text: "<reply>The boat is late.</reply>" }] },
      ],
    }));

    await s.turn(request("t1"));

    expect(ran).toEqual(["world_apply", "story_record", "world_query"]);
    // By call, whatever order they ended in: the Never was settled before any of the others ran.
    expect(Object.fromEntries(s.trace.of("tool_ended").map((record) => [record.event.callId, record.event.permission ?? null]))).toEqual({
      "a-1": { lane: "engine", setting: "auto" },
      "c-1": { lane: "story", setting: "confirm", answer: { go: true } },
      "n-1": { lane: "cast", setting: "never" },
      "r-1": null,
    });
  });
});

describe("switches", () => {
  const TOWER = { kind: "mcp-server", name: "dice-tower", target: "dice-tower --stdio" } as const;
  /** The host's registry, each user's own: the dice tower switched on for `on` alone. */
  const switchedOnFor = (on: string): SwitchesPort & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      state: async (user, thing) => {
        asked.push(user);
        return user === on && thing.name === TOWER.name && thing.target === TOWER.target ? "on" : "waiting";
      },
    };
  };
  const played = async (port: SwitchesPort, ran: string[]): Promise<Stage> => {
    const s = (open = await stage({
      files: { ".agents/lead.md": "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [dice_roll]\ngiven: [prompt:*]\n---\nFixture lead: you run the turn.\n" },
      switches: port,
      tools: { dice_roll: { tier: "read", description: "Fixture: rolls dice on the dice tower.", switchable: TOWER, run: async () => (ran.push("dice_roll"), said("17")) } },
      answers: [{ pieces: [{ call: "dice_roll", args: {}, id: "d-1" }] }, { pieces: [{ text: "<reply>The dice fall.</reply>" }] }],
    }));
    await s.turn(request("t1", { lead: "lead" }));
    return s;
  };

  test("a tool that calls out, switched on for one user, is off for another of the same kind, name and target: the second user's call is refused by the switch, and its record says so", async () => {
    const ran: string[] = [];
    const mine = switchedOnFor(USER);
    const first = await played(mine, ran);
    expect(ran).toEqual(["dice_roll"]);
    expect(mine.asked).toEqual([USER]);
    await first.close();

    // The same thing, switched on for another user only: this user's call is refused.
    const theirs = switchedOnFor("second-reader");
    const second = await played(theirs, ran);
    expect(ran).toEqual(["dice_roll"]);
    expect(theirs.asked).toEqual([USER]);
    expect(second.trace.of("tool_ended").find((record) => record.event.callId === "d-1")?.event).toMatchObject({ tool: "dice_roll", refused: { by: "switch", thing: TOWER, state: "waiting" } });
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
  test("a tool that throws is answered with the file's line; the error's own words go to the trace, never to the model", async () => {
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

    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe("world_query failed.");
    expect(s.trace.of("tool_ended")[0]?.event.result.details).toEqual({ error: "Fixture: the ledger is locked." });
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
    expect(answered(second, "call_1_2")).toStartWith("file_read was not run: the arguments you sent do not fit what it takes. path is missing.");
    expect(answered(s.model.requests[2]!.messages, "call_2_1")).toBe("todo was not run: your message reached its length limit, so its arguments may be cut short. Call it again.");
  });

  test("a call that does not fit is told which arguments did not fit and whether each was left out, never the check's own words; the whole schema only for a tool whose schema is within the setting", async () => {
    const s = (open = await stage({
      drafted: true,
      config: "tools:\n  schemaShown: 1500\n",
      tools: {
        world_query: { tier: "read", description: "Fixture: the tide on a day.", parameters: { properties: { day: { type: "integer" } }, required: ["day"] }, run: async () => said("calm") },
        world_apply: { tier: "read", description: "Fixture: a long form.", parameters: { properties: { note: { type: "string", description: "Fixture: ".padEnd(2_000, "x") } }, required: ["note"] }, run: async () => said("noted") },
      },
      answers: [{ pieces: [{ call: "world_query", args: { day: "three" } }, { call: "world_apply", args: {} }] }, { pieces: [{ text: "<reply>Calm.</reply>" }] }],
    }));

    await s.turn(request("t1"));

    const second = s.model.requests[1]!.messages;
    expect(answered(second, "call_1_1")).toStartWith("world_query was not run: the arguments you sent do not fit what it takes. day does not fit. It takes {");
    expect(answered(second, "call_1_2")).toBe("world_apply was not run: the arguments you sent do not fit what it takes. note is missing.");
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
    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe(`${long.slice(0, 40)}[40 of 100 characters shown; 60 left out. The whole answer is in ${kept}.]`);
    const read = await s.host.files.read(request("t1").scope, kept);
    expect(read.status === "read" ? read.text : "").toBe(long);
  });
});

describe("the bound on one answer", () => {
  /** A floor painted past its map's edge: a short answer, and a report for every square that fell off. */
  const DONE = "Painted the cellar floor.";
  const OFF = Array.from({ length: 2_000 }, (_, at) => `Fixture: square ${at + 1} is off the map.`);

  test("a tool's reports count with its text: what the model reads, what the session file keeps and what the next turn carries stay within the setting, and the line says how much was left out and where the whole answer is", async () => {
    const s = (open = await stage({
      drafted: true,
      config: "results:\n  clip: 200\n",
      tools: { world_apply: { tier: "read", description: "Fixture: paints a floor.", run: async () => ({ content: [{ type: "text", text: DONE }], reports: OFF }) } },
      answers: [{ pieces: [{ call: "world_apply" }] }, { pieces: [{ text: "<reply>The floor is painted.</reply>" }] }, { pieces: [{ text: "<reply>The paint dries.</reply>" }] }],
    }));

    await s.turn(request("t1", { carry: "continuing" }));
    await s.turn(request("t2", { carry: "continuing", parent: "t1" }));

    const kept = "sessions/s1/turns/t1/cache/results/call_1_1.md";
    const length = [DONE, ...OFF].reduce((sum, text) => sum + text.length, 0);
    // 25 characters of text and five reports of 33 make 190; ten characters of the sixth report make 200.
    const line = `[200 of ${length} characters shown; ${length - 200} left out, among them 1995 of its 2000 reports. The whole answer is in ${kept}.]`;
    const read = answered(s.model.requests[1]!.messages, "call_1_1");
    expect(read).toBe(`${DONE}${OFF.slice(0, 5).join("")}${OFF[5]!.slice(0, 10)}${line}`);

    const file = await s.host.files.read(request("t1").scope, "sessions/s1/s1.jsonl");
    const entries = (file.status === "read" ? file.text : "").split("\n").flatMap((raw) => (raw.trim() === "" ? [] : [JSON.parse(raw) as { type: string; callId?: string; text?: string; reports?: string[] }]));
    const result = entries.find((entry) => entry.type === "result" && entry.callId === "call_1_1");
    expect(result?.text).toBe(DONE);
    expect(result?.reports).toEqual([...OFF.slice(0, 5), OFF[5]!.slice(0, 10), line]);
    expect(s.trace.of("tool_ended")[0]?.event.result.reports).toEqual(result?.reports);

    const carried = s.model.requests[2]!.messages.map((message) => textOf(message)).join("\n");
    expect(carried).toContain(line);
    expect(carried).not.toContain(OFF[6]!);
    const whole = await s.host.files.read(request("t1").scope, kept);
    expect(whole.status === "read" ? whole.text : "").toBe([DONE, ...OFF].join("\n"));
  });

  test("an answer that reported something is not clean though the bound left out every report, and with the notices file's line taken out: a closing call on it goes on for one more call", async () => {
    const s = (open = await stage({
      drafted: true,
      config: "results:\n  clip: 20\n",
      files: { ".prompts/tool-notices.md": "---\ndescription: Fixture - the notices with no line for a clipped answer.\nformat: lines\n---\nfailed: {{tool}} failed.\n" },
      tools: { world_apply: { tier: "read", description: "Fixture: paints a floor.", run: async () => ({ content: [{ type: "text", text: DONE }], reports: OFF.slice(0, 1) }) } },
      answers: [{ pieces: [{ text: "<reply>The floor is painted.</reply>" }, { call: "world_apply", args: { closing: true } }] }, { pieces: [{ text: "Noted." }] }],
    }));

    await s.turn(request("t1"));

    expect(answered(s.model.requests[1]!.messages, "call_1_1")).toBe(DONE.slice(0, 20));
    expect(s.trace.of("tool_ended").map((record) => record.event.clean)).toEqual([false]);
  });
});
