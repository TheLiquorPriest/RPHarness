// No unexplained skip: the gate lists every skipped test with its reason, which a test that may be
// skipped gives at the end of its name while it is skipped, `(skipped: <why>)`, since Bun gives a
// skip no reason of its own; a skip with none is a defect that fails the run. A run filtered by `-t`
// judges no skips (Bun counts the tests it leaves out as skipped).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judge, runAll, summarize } from "../../../scripts/test-all";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rph-skips-"));
  mkdirSync(join(root, "test"));
  writeFileSync(
    join(root, "test/skips.test.ts"),
    'import { test } from "bun:test";\ntest("runs", () => {});\ntest.skipIf(true)("needs a model key (skipped: there is no key here)", () => {});\ntest.skip("is left out for no reason it gives", () => {});\ntest.todo("is not written yet");\n',
  );
  writeFileSync(join(root, "test/reasoned.test.ts"), 'import { test } from "bun:test";\ntest("runs", () => {});\ntest.skipIf(true)("needs a model key (skipped: there is no key here)", () => {});\n');
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

test("every skipped test is listed with its reason, and a skip that gives none fails the run", async () => {
  const judged = judge(await runAll({ root, jobs: 1, files: ["test/skips.test.ts"] }));
  expect(judged.skips).toEqual([
    { file: "test/skips.test.ts", name: "needs a model key", reason: "there is no key here" },
    { file: "test/skips.test.ts", name: "is left out for no reason it gives", reason: null },
    { file: "test/skips.test.ts", name: "is not written yet", reason: null },
  ]);
  const lines = summarize(judged);
  const skipped = lines.indexOf("Skipped, each with its reason (3):");
  expect(lines.slice(skipped + 1, skipped + 7)).toEqual([
    "  test/skips.test.ts: needs a model key",
    "    why: there is no key here",
    "  test/skips.test.ts: is left out for no reason it gives",
    "    why: none given, a defect",
    "  test/skips.test.ts: is not written yet",
    "    why: none given, a defect",
  ]);
  expect(lines.at(-1)).toBe("Verdict: fail: 2 skipped tests with no reason given.");
}, 20_000);

test("a skip that gives its reason is listed with it, and the run passes", async () => {
  const judged = judge(await runAll({ root, jobs: 1, files: ["test/reasoned.test.ts"] }));
  expect(judged.skips).toEqual([{ file: "test/reasoned.test.ts", name: "needs a model key", reason: "there is no key here" }]);
  expect(judged.ok).toBe(true);
  expect(summarize(judged).at(-1)).toBe("Verdict: pass.");
}, 20_000);

test("a run filtered by -t judges no skips", async () => {
  const judged = judge(await runAll({ root, jobs: 1, files: ["test/skips.test.ts"], bun: ["-t", "^runs$"] }));
  expect(judged.run.first).toMatchObject([{ ok: true, passed: 1 }]);
  expect(judged.skips).toEqual([]);
  expect(judged.ok).toBe(true);
}, 20_000);
