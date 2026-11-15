// The job tools behind the search (§6.8, §13.5): `job_list`, `job_read` and `job_cancel` held by no
// definition's list, found with `tool_search` and called with `tool_use`, by a turn's agent and by a
// job's; `job_start` naming an earlier job to start again, through its own path and an agent's limits.
// The refusals a start gives are facts with their numbers, not sentences. Everything here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import type { JobView, JsonObject } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import type { LinesPart } from "../../src/files/api";
import { type Answer, gate, type Reply } from "../../src/testing/rig";
import { request, type Stage, stage, textOf, USER } from "../harness/support";
import { jobOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [job_start, tool_search, tool_use]\ngiven:\n  - briefing\n---\nFixture lead: you run the turn.\n";
const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
const WATCHER = "---\nname: watcher\ndescription: Fixture watcher of the other jobs.\nmodel: default\ntools: [tool_search, tool_use]\n---\nFixture watcher: you look at the jobs of the chat.\n";
const FILES = { ".agents/lead.md": LEAD, ".agents/keeper.md": KEEPER, ".agents/watcher.md": WATCHER };
const BRIEF = "Count the bells in the tower.";
const SLOW = "Count the lamps on the quay.";
const WATCH = "Look at the jobs of this chat.";

type Later = Reply | (() => Reply);

/** Every call's answer, by whose call it is: each of `keepers`' briefs has its own list, in order, and every other call is the lead's; an entry may be made when its call comes. */
function routed(lead: Later[], keepers: Record<string, Later[]>): Answer[] {
  const lists = new Map(Object.entries(keepers));
  const route: Answer = (req) => {
    const user = req.messages.filter((message) => message.role === "user").map(textOf).join("\n");
    const own = [...lists].find(([brief]) => user.includes(brief))?.[1] ?? lead;
    const next = own.shift();
    if (next === undefined) throw new Error("The fixture has no answer left for this call.");
    return typeof next === "function" ? next() : next;
  };
  const count = lead.length + Object.values(keepers).reduce((total, list) => total + list.length, 0);
  return Array.from({ length: count }, () => route);
}

const call = (id: string, name: string, args: JsonObject) => ({ call: name, args, id });
const use = (id: string, name: string, args: JsonObject) => call(id, "tool_use", { name, args });
const reply = (text: string): Reply => ({ pieces: [{ text: `<reply>${text}</reply>` }] });

/** What the host was told of each job, in order. */
function toldJobs(s: Stage): JobView[] {
  return s.told.flatMap((told) => (told.kind === "job" ? [told.payload as JobView] : []));
}

/** Resolves once `count` jobs have been traced in `state`. */
function jobIn(s: Stage, state: JobView["state"], count = 1): Promise<void> {
  return s.trace.seen(() => s.trace.of("job").filter((record) => record.event.job.state === state).length >= count);
}

/** The answer a call got, as the model read it in a later request. */
function answerTo(s: Stage, callId: string): string {
  for (const req of s.model.requests) {
    const found = req.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    if (found !== undefined) return textOf(found);
  }
  return "";
}

/** The shipped words of the jobs' answers. */
async function words(s: Stage): Promise<LinesPart> {
  const part = await loadGuidance(s.env.files, request("t1").scope).part("jobs");
  if (part?.format !== "lines") throw new Error("jobs.md is a lines part.");
  return part;
}

describe("the job tools behind the search", () => {
  test("an agent lists the jobs its turn started, reads one whole and cancels one through tool_use, and starts one again by naming it; the declared tool list is unchanged", async () => {
    const held = gate();
    const ids = { done: "", slow: "" };
    const s = (open = await stage({
      files: FILES,
      answers: routed(
        [
          { pieces: [{ call: "job_start", args: { agent: "keeper", brief: BRIEF }, id: "start-done" }, { call: "job_start", args: { agent: "keeper", brief: SLOW }, id: "start-slow" }] },
          reply("Two jobs go."),
          { pieces: [{ call: "tool_search", args: { words: "job" }, id: "search-1" }] },
          () => ({ pieces: [use("list-1", "job_list", {}), use("read-1", "job_read", { job: ids.done })] }),
          () => ({ pieces: [use("cancel-1", "job_cancel", { job: ids.slow })] }),
          () => ({ pieces: [{ call: "job_start", args: { repeats: ids.slow }, id: "again-1" }] }),
          reply("Started again."),
        ],
        { [BRIEF]: [{ pieces: [{ text: "Counted seven." }] }], [SLOW]: [{ pieces: [{ hold: held }, { text: "Never written." }] }, { pieces: [{ text: "Counted nine." }] }] },
      ),
    }));

    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
    await jobIn(s, "done");
    await jobIn(s, "running", 2);
    ids.done = toldJobs(s).find((job) => job.brief === BRIEF)!.id;
    ids.slow = toldJobs(s).find((job) => job.brief === SLOW)!.id;

    expect((await s.turn(request("t2", { lead: "lead" }))).outcome.status).toBe("released");
    held.open();
    const jobs = await words(s);

    // Found with the search: a family of its own, held by nobody's list.
    const found = answerTo(s, "search-1");
    for (const name of ["job_list", "job_read", "job_cancel"]) expect(found).toContain(name);
    // Listed: both, the latest first, each with where it stands and the first line of its task.
    const listed = answerTo(s, "list-1");
    expect(listed).toContain(jobs.line("listed", { id: ids.done, agent: "keeper", state: "done", brief: BRIEF })!);
    expect(listed).toContain(jobs.line("listed", { id: ids.slow, agent: "keeper", state: "running", brief: SLOW })!);
    // Read whole: its state, its task, its report.
    const read = answerTo(s, "read-1");
    expect(read).toContain(jobs.line("read", { id: ids.done, agent: "keeper", state: "done" })!);
    expect(read).toContain(jobs.line("brief", { brief: BRIEF })!);
    expect(read).toContain(jobs.line("report", { report: "Counted seven." })!);
    // Cancelled: it stops, with what it had.
    expect(answerTo(s, "cancel-1")).toBe(jobs.line("cancelled", { id: ids.slow, state: "cancelled" })!);
    expect((await s.harness.jobs.get(USER, ids.slow))?.state).toBe("cancelled");

    // Started again by naming it: a new job with its agent and task, which names the first and was started by the lead, in its turn.
    await jobIn(s, "done", 2);
    const again = toldJobs(s).find((job) => job.repeats === ids.slow && job.state === "done")!;
    expect(again).toMatchObject({ agent: "keeper", brief: SLOW, repeats: ids.slow, startedBy: { definition: "lead" }, scope: { turn: "t2" }, report: "Counted nine." });
    expect(answerTo(s, "again-1")).toBe(jobs.line("started", { job: again.id, agent: "keeper" })!);

    // The declared tools of the lead are the same in every request, and name none of the three.
    const declared = s.model.requests.filter((req) => req.tools.some((tool) => tool.name === "job_start")).map((req) => req.tools.map((tool) => tool.name).sort());
    expect(declared.length).toBeGreaterThan(3);
    for (const names of declared) {
      expect(names).toEqual(declared[0]!);
      expect(names).not.toContain("job_list");
      expect(names).not.toContain("job_read");
      expect(names).not.toContain("job_cancel");
    }
  });

  test("a start that names a job that cannot be started again, or no job and no task, is answered in the words of the file, and starts nothing", async () => {
    const ids = { done: "" };
    const s = (open = await stage({
      files: FILES,
      answers: routed(
        [
          { pieces: [{ call: "job_start", args: { agent: "keeper", brief: BRIEF }, id: "start-done" }] },
          reply("One job goes."),
          () => ({ pieces: [call("again-done", "job_start", { repeats: ids.done }), call("again-none", "job_start", { repeats: "no-such-job" }), call("again-bare", "job_start", {})] }),
          reply("Nothing started."),
        ],
        { [BRIEF]: [{ pieces: [{ text: "Counted seven." }] }] },
      ),
    }));
    expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
    await jobIn(s, "done");
    ids.done = toldJobs(s)[0]!.id;
    const before = toldJobs(s).length;

    expect((await s.turn(request("t2", { lead: "lead" }))).outcome.status).toBe("released");
    const jobs = await words(s);
    expect(answerTo(s, "again-done")).toBe(jobs.line("not_again", { id: ids.done, state: "done" })!);
    expect(answerTo(s, "again-none")).toBe(jobs.line("no_job", { id: "no-such-job" })!);
    expect(answerTo(s, "again-bare")).toBe(jobs.line("no_task")!);
    expect(toldJobs(s)).toHaveLength(before);
  });

  test("a job's agent reaches the job tools too: it cancels no job the player started and reads none of another chat", async () => {
    const held = gate();
    const ids = { owners: "" };
    const s = (open = await stage({
      files: FILES,
      answers: routed([], {
        [SLOW]: [{ pieces: [{ hold: held }, { text: "Never written." }] }],
        [WATCH]: [
          () => ({ pieces: [use("list-1", "job_list", {}), use("cancel-1", "job_cancel", { job: ids.owners }), use("read-1", "job_read", { job: "elsewhere" })] }),
          { pieces: [{ text: "Looked." }] },
        ],
      }),
    }));
    const owners = jobOf(await s.harness.jobs.start(request("t1").scope, { agent: "keeper", brief: SLOW }));
    ids.owners = owners.id;
    const watcher = jobOf(await s.harness.jobs.start(request("t1").scope, { agent: "watcher", brief: WATCH }));
    await jobIn(s, "done");
    const jobs = await words(s);

    expect(answerTo(s, "list-1")).toContain(jobs.line("listed", { id: owners.id, agent: "keeper", state: "running", brief: SLOW })!);
    expect(answerTo(s, "list-1")).toContain(jobs.line("listed", { id: watcher.id, agent: "watcher", state: "running", brief: WATCH })!);
    expect(answerTo(s, "cancel-1")).toBe(jobs.line("not_yours", { id: owners.id })!);
    expect(answerTo(s, "read-1")).toBe(jobs.line("no_job", { id: "elsewhere" })!);
    expect((await s.harness.jobs.get(USER, owners.id))?.state).toBe("running");
    held.open();
  });
});

describe("a start that is refused", () => {
  test("past the day's count it is the refusal with max and value, and throws nothing", async () => {
    const s = (open = await stage({ config: "jobs:\n  perDay: 1\n", files: FILES, answers: [{ pieces: [{ text: "Counted seven." }] }] }));
    const first = jobOf(await s.harness.jobs.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.event.kind === "job" && record.event.job.id === first.id && record.event.job.state === "done");

    expect(await s.harness.jobs.start(request("t1").scope, { agent: "keeper", brief: BRIEF })).toEqual({ refused: "day-count", max: 1, value: 1 });
    expect(await s.harness.jobs.start(request("t1").scope, { agent: "keeper", brief: BRIEF, limits: { calls: -2 } })).toEqual({ refused: "limit", limit: "calls", value: -2 });
    expect(await s.harness.jobs.start(request("t1").scope, { agent: "nobody", brief: BRIEF })).toEqual({ refused: "agent", agent: "nobody" });
    expect(toldJobs(s).filter((job) => job.state === "queued")).toHaveLength(1);
  });

  test("past the day's tokens it is the refusal with max and value", async () => {
    const s = (open = await stage({ config: "jobs:\n  tokensPerDay: 100\n", files: FILES, answers: [{ pieces: [{ text: "Counted seven." }], usage: { input: 90, output: 30 } }] }));
    const first = jobOf(await s.harness.jobs.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.event.kind === "job" && record.event.job.id === first.id && record.event.job.state === "done");

    expect(await s.harness.jobs.start(request("t1").scope, { agent: "keeper", brief: BRIEF })).toEqual({ refused: "day-tokens", max: 100, value: 120 });
  });
});
