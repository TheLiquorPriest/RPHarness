// Every value RPH keeps through the host's store is a user's (READINGS R-52; Appendix B: every table
// carries the user): the store is asked with the scope RPH acts for, and the folder host keeps each
// user's values in a folder of his own. So two users' jobs, kept under the same key, never meet, each
// user's day's counts are his own, and a job is found only under its own user's name. Everything
// here is invented.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Environment, JobView, StorePort, Usage } from "../../src/contract";
import { createFolderHost, type FolderHost } from "../../src/hosts/folder";
import { createHarness, type Harness } from "../../src/index";
import { gate, scriptedModel } from "../../src/testing/rig";
import { CHARACTER, CHAT, request, type Stage, stage, USER, WatchedTrace } from "../harness/support";
import { jobOf } from "../jobs/support";

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
const BRIEF = "Count the bells in the tower.";
/** A second user, with a chat of his own on the same directory. */
const OTHER = "second-reader";
const OTHER_CHAT = "quay";

let open: Stage | undefined;
const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  await open?.close();
  open = undefined;
});

/** The day's counts of a usage with only calls and tokens in and out. */
const spent = (input: number, output: number): Usage => ({ calls: 1, input, cacheRead: 0, cacheWrite: 0, output });

/** The second user's folder host over the stage's directory, his chat beside the first user's, and a harness of its own whose keeper answers `text`. */
async function secondUser(s: Stage, text: string, usage: { input: number; output: number }): Promise<{ host: FolderHost; harness: Harness; trace: WatchedTrace }> {
  await mkdir(join(s.dir, "files", "chats", CHARACTER, OTHER_CHAT), { recursive: true });
  await mkdir(join(s.dir, "host", "chats", OTHER_CHAT), { recursive: true });
  await writeFile(join(s.dir, "host", "chats", OTHER_CHAT, "chat.json"), JSON.stringify({ character: CHARACTER, preset: { id: "fixture-preset", name: "Fixture preset" } }));
  const host = await createFolderHost({ dir: s.dir, user: OTHER, clock: s.clock, log: s.env.log });
  const trace = new WatchedTrace();
  const env: Environment = { ...host, trace };
  const model = scriptedModel([{ pieces: [{ text }], usage }], { clock: s.clock });
  let next = 0;
  const harness = createHarness(env, { models: { agentModel: async () => model.agentModel() }, ids: () => `id-${(next += 1)}` });
  closing.push(async () => {
    await harness.close();
    await host.close();
  });
  return { host, harness, trace };
}

/** Resolves once the trace holds the job's end. */
function jobDone(trace: WatchedTrace, id: string): Promise<void> {
  return trace.seen((record) => record.event.kind === "job" && record.event.job.id === id && record.event.job.state === "done");
}

describe("the store by user", () => {
  test("two users' jobs and day's counts stay apart on the folder host: the same job id holds each user's own job, and one user's jobs count in no other's day", async () => {
    const s = (open = await stage({ config: "jobs:\n  perDay: 1\n", files: { ".agents/keeper.md": KEEPER }, answers: [{ pieces: [{ text: "Counted seven." }], usage: { input: 100, output: 20 } }] }));
    const other = await secondUser(s, "Counted nine.", { input: 300, output: 40 });

    const mine = jobOf(await s.harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await jobDone(s.trace, mine.id);
    // The setting allows one job a day: the second user's first is his own day's first.
    const theirs = jobOf(await other.harness.jobs!.start({ user: OTHER, chat: OTHER_CHAT, session: "s1" }, { agent: "keeper", brief: BRIEF }));
    await jobDone(other.trace, theirs.id);

    // Each harness counts its own ids, so the two jobs are kept under the same key.
    expect(theirs.id).toBe(mine.id);
    expect((await s.harness.jobs!.list({ user: USER })).jobs.map((job: JobView) => [job.scope.user, job.report])).toEqual([[USER, "Counted seven."]]);
    expect((await other.harness.jobs!.list({ user: OTHER })).jobs.map((job: JobView) => [job.scope.user, job.report])).toEqual([[OTHER, "Counted nine."]]);
    expect(await s.harness.jobs!.get(USER, mine.id)).toMatchObject({ scope: { user: USER, chat: CHAT }, report: "Counted seven." });
    expect(await other.harness.jobs!.get(OTHER, theirs.id)).toMatchObject({ scope: { user: OTHER, chat: OTHER_CHAT }, report: "Counted nine." });
    expect(await s.harness.jobs!.start(request("t2").scope, { agent: "keeper", brief: BRIEF })).toEqual({ refused: "day-count", max: 1, value: 1 });
    // A harness's close waits for its day's totals to be kept; read after it, each user's day is his own.
    await s.harness.close();
    await other.harness.close();
    expect([await s.harness.usage.day(USER), await other.harness.usage.day(OTHER)]).toEqual([spent(100, 20), spent(300, 40)]);
  });

  test("a job is not found under another user's name: neither read nor stopped by its id, running or kept", async () => {
    const s = (open = await stage({ files: { ".agents/keeper.md": KEEPER }, answers: [] }));
    const other = await secondUser(s, "Never asked.", { input: 0, output: 0 });
    // A host that serves both users: each one's values in his own folder, through the folder host that serves him.
    const store = (user: string): StorePort => (user === OTHER ? other.host.store : s.host.store);
    const both: StorePort = {
      get: (scope, key) => store(scope.user).get(scope, key),
      set: (scope, key, value) => store(scope.user).set(scope, key, value),
      update: (scope, key, change) => store(scope.user).update(scope, key, change),
      delete: (scope, key) => store(scope.user).delete(scope, key),
      list: (scope, prefix) => store(scope.user).list(scope, prefix),
      jobs: {
        get: (scope, id) => store(scope.user).jobs.get(scope, id),
        set: (scope, job) => store(scope.user).jobs.set(scope, job),
        list: (scope, query) => store(scope.user).jobs.list(scope, query),
        prune: (scope, before) => store(scope.user).jobs.prune(scope, before),
      },
    };
    const held = gate();
    const model = scriptedModel([{ pieces: [{ hold: held }, { text: "Counted seven." }] }], { clock: s.clock });
    const harness = createHarness({ ...s.env, store: both }, { models: { agentModel: async () => model.agentModel() }, ids: () => "job-of-the-first" });
    closing.push(() => harness.close());

    const job = jobOf(await harness.jobs!.start(request("t1").scope, { agent: "keeper", brief: BRIEF }));
    await s.trace.seen((record) => record.event.kind === "job" && record.event.job.state === "running");

    expect(await harness.jobs!.get(OTHER, job.id)).toBeUndefined();
    expect(await harness.jobs!.cancel(OTHER, job.id)).toBeUndefined();
    expect(await harness.jobs!.list({ user: OTHER })).toEqual({ jobs: [] });
    expect((await harness.jobs!.get(USER, job.id))?.state).toBe("running");

    held.open();
    await jobDone(s.trace, job.id);
    expect(await harness.jobs!.get(OTHER, job.id)).toBeUndefined();
    expect(await harness.jobs!.cancel(OTHER, job.id)).toBeUndefined();
    expect((await harness.jobs!.get(USER, job.id))?.state).toBe("done");
  });
});
