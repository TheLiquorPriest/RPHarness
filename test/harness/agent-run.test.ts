// One way to make an agent's run (§13.2): a turn and a job keep their requests, make their gates and
// hold their tools the same way, so a job's request files settle before its end is told, as a
// turn's do, and `tool_use` is a carrier where it is made, so no kind of run marks it again.
// Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Answer, Reply } from "../../src/testing/rig";
import { gate, type HostToolFixture, request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper.\nmodel: default\ntools: [tool_use, tide_table]\n---\nFixture keeper: you read the tides.\n";
const lead = (tools: string) => `---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [${tools}]\ngiven: [prompt:*]\n---\nFixture lead: you run the turn.\n`;
const TIDES: Record<string, HostToolFixture> = {
  tide_table: { tier: "read", family: "tides", description: "Fixture: gives the tide table for a day.", parameters: { properties: { day: { type: "integer" } }, required: ["day"] }, run: async (args) => ({ content: [{ type: "text", text: `High water on day ${JSON.stringify(args)}.` }] }) },
};
const BRIEF = "Read the tides.";

/** Each call's answer from the list of whoever makes it: the keeper's calls carry its brief. */
function routed(lead: Reply[], keeper: Reply[]): Answer {
  return (req) => {
    const own = req.messages.some((message) => message.role === "user" && textOf(message).includes(BRIEF)) ? keeper : lead;
    const next = own.shift();
    if (next === undefined) throw new Error("The fixture has no answer left for this call.");
    return next;
  };
}

test("a job's first request file is written and settled before the job's end is told, as a turn's is", async () => {
  const asked = gate();
  const held = gate();
  const s = (open = await stage({
    files: { ".agents/lead.md": lead("job_start"), ".agents/keeper.md": KEEPER },
    tools: TIDES,
    filesPort: (inner) => ({
      layers: (scope) => inner.layers(scope),
      places: (scope) => inner.places(scope),
      find: (scope, query) => inner.find(scope, query),
      read: (scope, path, range) => inner.read(scope, path, range),
      write: async (scope, path, op, by) => {
        // The keeper's first request file is held while it is written.
        if (path.includes("/keeper-") && path.endsWith(".call-1.json")) {
          asked.open();
          await held.opened;
        }
        return inner.write(scope, path, op, by);
      },
    }),
    answers: Array(3).fill(routed([{ pieces: [{ call: "job_start", args: { agent: "keeper", brief: BRIEF } }] }, { pieces: [{ text: "<reply>The keeper is reading the tides.</reply>" }] }], [{ pieces: [{ text: "Read." }] }])),
  }));

  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  await asked.opened;
  await s.trace.seen(() => s.trace.records.some((record) => record.event.kind === "agent_ended" && record.agent?.definition === "keeper"));
  // The keeper's work is over, but its request file is still being written: the job's end is not told yet.
  expect(s.trace.records.some((record) => record.event.kind === "job" && record.event.job.state === "done")).toBe(false);
  held.open();
  await s.trace.seen(() => s.trace.records.some((record) => record.event.kind === "job" && record.event.job.state === "done"));
});

test("a turn and a job each carry a found tool through tool_use, and neither maps its tools to mark it", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": lead("tool_use, tide_table, job_start"), ".agents/keeper.md": KEEPER },
    tools: TIDES,
    answers: Array(4).fill(
      routed(
        [{ pieces: [{ call: "tool_use", args: { name: "tide_table", args: { day: 1 } }, id: "lead-use" }, { call: "job_start", args: { agent: "keeper", brief: BRIEF } }] }, { pieces: [{ text: "<reply>Day one is read.</reply>" }] }],
        [{ pieces: [{ call: "tool_use", args: { name: "tide_table", args: { day: 2 } }, id: "job-use" }] }, { pieces: [{ text: "Read." }] }],
      ),
    ),
  }));

  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  await s.trace.seen(() => s.trace.records.some((record) => record.event.kind === "job" && record.event.job.state === "done"));

  const found = s.trace.of("tool_started").filter((record) => record.event.via === "tool_use");
  expect(found.map((record) => [record.event.callId, record.event.tool])).toEqual([
    ["lead-use", "tide_table"],
    ["job-use", "tide_table"],
  ]);
  // The tool is a carrier where it is made: neither kind of run marks it again.
  const src = join(import.meta.dir, "..", "..", "src");
  for (const file of ["harness/own.ts", "harness/turn.ts", "jobs/run.ts"]) expect({ file, marks: (await readFile(join(src, file), "utf8")).includes("carrier: true") }).toEqual({ file, marks: false });
});
