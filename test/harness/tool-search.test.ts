// Tool search, held by the harness (§6.8): RPH's own lead finds a host's tool its definition does
// not list, calls it through `tool_use`, and the call is treated as the found tool's own: the
// player's permission for its lane is asked, a rule on its result fires for it, and the trace shows
// it under its own name, never `tool_use`'s. Finding and using tools adds nothing to the tool list,
// which is the same in every request of the session. A family the definition keeps out of reach
// (`out_of_reach:`) is neither found nor called, and the user's setting caps what a search gives.
// Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { ApprovalsPort, JsonValue } from "../../src/contract";
import { SHIPPED_GUIDANCE } from "../../src/index";
import { request, said, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const RULE = "---\ndescription: Fixture - fog on the rock.\nagents: [lead]\ncondition: fog\nscope: [result:weather_set]\n---\nFixture rule: say who sees the fog come in.\n";

/** The answer a call got, as the model read it in a later request. */
function answerTo(s: Stage, callId: string): string {
  for (const req of s.model.requests) {
    const found = req.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    if (found !== undefined) return textOf(found);
  }
  return "";
}

test("a host's tool the lead does not list is found, called through tool_use as itself, and the tool list holds still through the session", async () => {
  const ran: JsonValue[] = [];
  const asked: string[] = [];
  const approvals: ApprovalsPort = {
    permission: async (_scope, lane) => (lane === "world" ? "confirm" : "auto"),
    ask: async (_scope, ask) => {
      asked.push(`${ask.tool}:${ask.lane}`);
      return { go: true };
    },
  };
  const s = (open = await stage({
    files: { ".rules/fixture-fog.md": RULE },
    approvals,
    tools: {
      weather_set: {
        tier: "write",
        lane: "world",
        family: "weather",
        description: "Fixture: sets the weather over a region.",
        parameters: { properties: { region: { type: "string" }, state: { type: "string" } }, required: ["region", "state"] },
        run: async (args) => {
          ran.push(args);
          return said(`Weather set: ${JSON.stringify(args)}`);
        },
      },
    },
    answers: [
      { pieces: [{ call: "tool_search", args: { words: "weather" }, id: "search-1" }] },
      { pieces: [{ call: "tool_use", args: { name: "weather_set", args: { region: "Gannet Rock", state: "fog" } }, id: "use-1" }] },
      { pieces: [{ text: "<reply>Fog closes over the rock.</reply>" }] },
      // The next turn of the same session.
      { pieces: [{ call: "tool_use", args: { name: "weather_set", args: { region: "Gannet Rock", state: "gale" } }, id: "use-2" }] },
      { pieces: [{ text: "<reply>The gale comes on.</reply>" }] },
    ],
  }));

  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  expect((await s.turn(request("t2", { lead: "lead" }))).outcome.status).toBe("released");

  expect(answerTo(s, "search-1")).toContain("weather_set");
  expect(ran).toEqual([
    { region: "Gannet Rock", state: "fog" },
    { region: "Gannet Rock", state: "gale" },
  ]);
  // Gated as itself: the player was asked about the found tool, on its own lane.
  expect(asked).toEqual(["weather_set:world", "weather_set:world"]);
  // Ruled on as itself: the rule on its result fired for it, and its text came back with the answer.
  expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.tool, record.event.firing.callId])).toEqual([["fixture-fog", "weather_set", "use-1"]]);
  expect(answerTo(s, "use-1")).toContain("Fixture rule: say who sees the fog come in.");
  // Traced as itself, once, and the carrier not at all.
  const started = s.trace.of("tool_started").filter((record) => record.event.callId.startsWith("use-"));
  expect(started.map((record) => [record.event.tool, record.event.callId, record.event.via])).toEqual([
    ["weather_set", "use-1", "tool_use"],
    ["weather_set", "use-2", "tool_use"],
  ]);
  const ended = s.trace.of("tool_ended").filter((record) => record.event.callId.startsWith("use-"));
  expect(ended.map((record) => [record.event.tool, record.event.callId, record.event.clean])).toEqual([
    ["weather_set", "use-1", false],
    ["weather_set", "use-2", true],
  ]);
  // The tool list is the same, byte for byte, in every request of the session, and the found tool is never in it.
  const lists = s.model.requests.map((req) => JSON.stringify(req.tools));
  expect(lists).toHaveLength(5);
  expect(new Set(lists).size).toBe(1);
  expect(s.model.requests[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["tool_search", "tool_use"]));
  expect(s.model.requests[0]!.tools.map((tool) => tool.name)).not.toContain("weather_set");
});

test("a family the lead's definition keeps out of reach is neither found nor called, and the setting caps how many tools a search gives", async () => {
  const shipped = await Bun.file(join(SHIPPED_GUIDANCE, ".agents", "lead.md")).text();
  const lead = shipped.replace(/^tools: .*$/m, (line) => `${line}\nout_of_reach: [weather]`);
  expect(lead).toContain("out_of_reach: [weather]");
  const ran: string[] = [];
  const tool = (name: string, family: string, description: string) => ({ tier: "read" as const, family, description, run: async () => (ran.push(name), said(`${name} ran`)) });
  const s = (open = await stage({
    config: "tools:\n  search: 1\n",
    files: { ".agents/lead.md": lead },
    tools: { weather_set: tool("weather_set", "weather", "Fixture: sets the tide-driven weather."), tide_read: tool("tide_read", "tides", "Fixture: reads the tide table."), tide_mark: tool("tide_mark", "tides", "Fixture: marks a tide on the chart.") },
    answers: [
      { pieces: [{ call: "tool_search", args: { words: "weather" }, id: "search-1" }, { call: "tool_search", args: { words: "tide" }, id: "search-2" }, { call: "tool_use", args: { name: "weather_set", args: {} }, id: "use-1" }] },
      { pieces: [{ text: "<reply>The tide turns.</reply>" }] },
    ],
  }));

  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

  expect(answerTo(s, "search-1")).not.toContain("weather_set");
  const tides = ["tide_read", "tide_mark"].filter((name) => answerTo(s, "search-2").includes(name));
  expect(tides).toHaveLength(1);
  expect(answerTo(s, "use-1")).not.toBe("");
  expect(ran).toEqual([]);
});