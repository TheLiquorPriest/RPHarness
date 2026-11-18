// A sub-agent's and a job's brief go with their requests as a lead's blocks do (§10.2, §13.3): the
// fixed context their runner sets before every request in pi's request hook, after their opening
// block, the same on every call. Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import { definition, type RecordedRequest, said, type Stage as AgentsStage, stage as agentsStage, textOf } from "../agents/support";
import { request, type Stage as HarnessStage, stage as harnessStage } from "../harness/support";
import type { Answer, Reply } from "./support";

let open: AgentsStage | HarnessStage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const BRIEF = "Count the bells in the tower of Saltmere.";
const LEAD = definition("lead", { model: "lead-model", tools: ["delegate"] }, "Fixture lead: you run the turn.");
const KEEPER = definition("keeper", { model: "keeper-model", tools: ["roll"] }, "Fixture keeper: you count what you are asked to count.");
const ROLL = { roll: { tier: "read" as const, description: "Fixture: rolls dice.", run: async () => said("4") } };
/** The keeper's three calls: two rolls, then its count. */
const KEEPER_CALLS: Reply[] = [{ pieces: [{ call: "roll", id: "r-1" }] }, { pieces: [{ call: "roll", id: "r-2" }] }, { pieces: [{ text: "Fixture count: seven bells." }] }];

/** Each request carries the opening block and the brief at its head, the same bytes every time. */
function expectBriefEveryCall(requests: readonly RecordedRequest[]): void {
  expect(requests).toHaveLength(3);
  const head = (req: RecordedRequest): string => JSON.stringify(req.messages.slice(0, 2));
  expect(requests[0]!.messages[0]?.role).toBe("system");
  expect(requests[0]!.messages[1]?.role).toBe("user");
  expect(textOf(requests[0]!.messages[1]!)).toContain(BRIEF);
  for (const req of requests) expect(head(req)).toBe(head(requests[0]!));
}

describe("a sub-agent's brief", () => {
  test("goes with every one of its requests from the request hook", async () => {
    const s = await agentsStage({
      files: { ".agents/lead.md": LEAD, ".agents/keeper.md": KEEPER },
      tools: ROLL,
      models: {
        "lead-model": [{ pieces: [{ call: "delegate", args: { agent: "keeper", brief: BRIEF }, id: "d-1" }] }, { pieces: [{ text: "Fixture: counted." }] }],
        "keeper-model": KEEPER_CALLS,
      },
    });
    open = s;

    expect((await (await s.play("Fixture: how many bells?")).done).status).toBe("done");

    expectBriefEveryCall(s.models["keeper-model"]!.requests);
  });
});

describe("a job's brief", () => {
  test("goes with every request of the job's first agent, made by the team as jobs make it", async () => {
    const s = await agentsStage({
      files: { ".agents/lead.md": LEAD, ".agents/keeper.md": KEEPER },
      tools: ROLL,
      models: { "lead-model": [{ pieces: [{ text: "Fixture: nothing to do." }] }], "keeper-model": KEEPER_CALLS },
    });
    open = s;
    const turn = await s.play("Fixture: start the count.");
    expect((await turn.done).status).toBe("done");

    const made = await turn.team.first({ agent: "keeper", brief: BRIEF, attach: [] }, undefined, undefined, "s-job");
    if (!("runner" in made)) throw new Error("The team made no keeper.");
    expect((await made.runner.start({ messages: [] }).done).status).toBe("done");

    expectBriefEveryCall(s.models["keeper-model"]!.requests);
  });

  test("a job an agent starts carries its brief after its opening block on every call, the same each time", async () => {
    const lead = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [job_start]\n---\nFixture lead: you run the turn.\n";
    const keeper = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
    const keeperCalls: Reply[] = [{ pieces: [{ call: "todo", args: { items: [{ text: "count the bells", done: false }] } }] }, { pieces: [{ text: "Fixture count: seven bells." }] }];
    const leadCalls: Reply[] = [{ pieces: [{ call: "job_start", args: { agent: "keeper", brief: BRIEF }, id: "start-1" }] }, { pieces: [{ text: "<reply>The tower is quiet.</reply>" }] }];
    // Each call is answered from the keeper's list when its brief is in what was sent, else from the lead's.
    const route: Answer = (req) => {
      const own = req.messages.some((message) => message.role === "user" && textOf(message).includes(BRIEF)) ? keeperCalls : leadCalls;
      const next = own.shift();
      if (next === undefined) throw new Error("The fixture has no answer left for this call.");
      return next;
    };
    const s = await harnessStage({ files: { ".agents/lead.md": lead, ".agents/keeper.md": keeper }, answers: Array.from({ length: 4 }, () => route) });
    open = s;

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
    await s.trace.seen((record) => record.event.kind === "job" && record.event.job.state === "done");

    const keeperRequests = s.model.requests.filter((req) => req.messages.some((message) => message.role === "user" && textOf(message).includes(BRIEF)));
    expect(keeperRequests).toHaveLength(2);
    for (const req of keeperRequests) {
      expect(req.messages[0]?.role).toBe("system");
      expect(textOf(req.messages[0]!)).toContain("Fixture keeper: you count what you are asked to count.");
      expect(req.messages[1]?.role).toBe("user");
      expect(textOf(req.messages[1]!)).toContain(BRIEF);
    }
    expect(JSON.stringify(keeperRequests[1]!.messages.slice(0, 2))).toBe(JSON.stringify(keeperRequests[0]!.messages.slice(0, 2)));
  });
});
