// The test stages leave nothing in the temporary directory, whatever fails: a set-up that throws
// removes its folder, the sub-agents' stage waits for its usage book's writes before it removes
// its own, and every stage is closed when the test that made it ends. Each case here runs with a
// temporary directory of its own, so whatever is left in it is a stage's. Everything is invented.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, StorePort } from "../../src/contract";
import { stage as agentsStage } from "../agents/support";
import { gate, stage as harnessStage } from "./support";

const ROOT = join(import.meta.dir, "..", "..");
const WAS = process.env.TMPDIR;
let scratch = "";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "rph-support-test-"));
  process.env.TMPDIR = scratch;
});

afterAll(async () => {
  if (WAS === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = WAS;
  await rm(scratch, { recursive: true, force: true });
});

/** The stages' folders left in a temporary directory. */
async function stagesLeft(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => name.startsWith("rph-harness-") || name.startsWith("rph-agents-"));
}

test("a set-up that throws leaves no rph-harness- or rph-agents- folder in the temporary directory", async () => {
  expect(tmpdir()).toBe(scratch);
  // A file name no disk takes: the set-up throws after the stage's folder was made.
  const unwritable = { "fixture\0name.md": "Fixture." };
  await expect(harnessStage({ answers: [], files: unwritable })).rejects.toThrow();
  await expect(agentsStage({ models: {}, files: unwritable })).rejects.toThrow();
  expect(await stagesLeft(scratch)).toEqual([]);
});

test("a close() while the day's usage is still being written leaves no rph-agents- folder behind", async () => {
  const held = gate();
  const asked = gate();
  let landed: Promise<JsonValue | undefined> | undefined;
  // The day's usage is held on its way to the store until the test lets it go.
  const store = (inner: StorePort): StorePort => ({
    get: (scope, key) => inner.get(scope, key),
    set: (scope, key, value) => inner.set(scope, key, value),
    delete: (scope, key) => inner.delete(scope, key),
    list: (scope, prefix) => inner.list(scope, prefix),
    jobs: inner.jobs,
    update: (scope, key, change) => {
      if (!key.startsWith("usage/")) return inner.update(scope, key, change);
      asked.open();
      landed = held.opened.then(() => inner.update(scope, key, change));
      return landed;
    },
  });
  const s = await agentsStage({ models: { default: [{ pieces: [{ text: "Fixture: the tide turns." }] }] }, store });
  await (await s.play("Fixture: what does the tide do?")).done;
  await asked.opened;
  // The write goes on once the close asks the stage's usage book for its writes, as the harness's own
  // close does; a close that never asks has removed the folder by the time the write goes on.
  const settled = s.usage.settled.bind(s.usage);
  s.usage.settled = () => {
    held.open();
    return settled();
  };

  await s.close();
  held.open();
  await landed;
  expect(existsSync(s.dir)).toBe(false);
  expect(await stagesLeft(scratch)).toEqual([]);
});

/** The folders of the stages the test before made and never closed. */
const unclosed: string[] = [];

test("a stage its test never closed is closed when the test ends: here, two are made and left open", async () => {
  const harness = await harnessStage({ answers: [] });
  const agents = await agentsStage({ models: {} });
  unclosed.push(harness.dir, agents.dir);
  expect(unclosed.every((dir) => existsSync(dir))).toBe(true);
});

test("a stage its test never closed is closed when the test ends: the two left open are gone", async () => {
  expect(unclosed).toHaveLength(2);
  expect(unclosed.filter((dir) => existsSync(dir))).toEqual([]);
  expect(await stagesLeft(scratch)).toEqual([]);
});

test(
  "after test/agents/delegate.test.ts, together.test.ts and ask.test.ts have run, no rph-agents- folder is left",
  async () => {
    const own = await mkdtemp(join(scratch, "files-"));
    const child = Bun.spawn([process.execPath, "test", "./test/agents/delegate.test.ts", "./test/agents/together.test.ts", "./test/agents/ask.test.ts"], { cwd: ROOT, env: { ...process.env, TMPDIR: own }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, said: code === 0 ? "" : `${out}\n${err}` }).toEqual({ code: 0, said: "" });
    expect(await stagesLeft(own)).toEqual([]);
  },
  60_000,
);
