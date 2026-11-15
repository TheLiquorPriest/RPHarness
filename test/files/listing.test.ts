// A guidance folder is listed whole (§5.2 "everything loaded", R-183): the listing asks the host for
// every file in it, so the cap a host puts on a find that names no limit cuts nothing.

import { afterEach, expect, test } from "bun:test";
import { loadGuidance } from "../../src/files/index";
import type { Bench } from "./support";
import { bench, scope } from "./support";

let b: Bench | undefined;
afterEach(async () => {
  await b?.close();
  b = undefined;
});

test("250 skills on a host whose find stops at 200 all load", async () => {
  const names = Array.from({ length: 250 }, (_, i) => `skill-${String(i + 1).padStart(3, "0")}`);
  const skills: Record<string, string> = {};
  for (const name of names) skills[`.skills/${name}/SKILL.md`] = `---\nname: ${name}\ndescription: Fixture skill ${name}.\n---\nSteps for ${name}.\n`;
  b = await bench({ global: skills });
  // The folder host gives at most 200 hits to a find that names no limit, and says it stopped there.
  const capped = await b.host.files.find(scope, { by: "list", path: "@global/.skills", depth: 2 });
  expect(capped.status === "found" ? { hits: capped.hits.length, stopped: capped.stopped } : capped).toEqual({ hits: 200, stopped: { limit: { max: 200 } } });

  const g = loadGuidance(b.host.files, scope);
  expect((await g.skills()).map((s) => s.name)).toEqual(names);
  expect((await g.skill("skill-250"))?.body).toBe("Steps for skill-250.\n");
  expect(await g.problems()).toEqual([]);
});
