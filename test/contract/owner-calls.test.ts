// What only the owner's own presses may do (C-5, C-19, C-24; §13.5 "Nothing starts a job but an
// agent's `job_start` or you. Code does not"): pause, let go and say something to a run; start and
// cancel a job, switch jobs off or hold them all, hold one that waits, start one again, answer a job
// that asks; compact a session on his word; make the opening blocks afresh (Apply now). The helpers module lists those members once, and both
// repositories' tests read the list: here, that every name on it is a member of the harness, and
// that no source of RPH but the folder host's command line calls one. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { OWNER_ONLY } from "rp-harness/helpers";
import { type Stage, stage } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const SRC = join(import.meta.dir, "..", "..", "src");
/** The one place a press may come from inside RPH: the folder host's command line. */
const COMMAND_LINE = /^src\/hosts\/folder\/(command|cli)/;
/** The names a harness member is held under in RPH's own source: the live view's hub too. */
const HELD_AS: Record<string, string[]> = { live: ["live", "hub"], jobs: ["jobs"], sessions: ["sessions"], definitions: ["definitions"] };

/** A source without its comments, which may name a member without calling it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** The owner-only members a source calls, as `<harness member>.<name>`. */
function calls(source: string): string[] {
  const text = code(source);
  return OWNER_ONLY.filter((entry) => {
    const [api = "", name = ""] = entry.split(".");
    const receivers = HELD_AS[api] ?? [api];
    return new RegExp(`\\b(?:${receivers.join("|")})[!?]*\\.${name}\\s*\\(`).test(text);
  });
}

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("the scan sees a call of a member on the list, and passes over a comment, a declaration and another object's member of the same name", () => {
  expect(calls("await harness.jobs!.start(scope, start);")).toEqual(["jobs.start"]);
  expect(calls("core.hub.pause(user, run); this.live?.say(user, run, words);")).toEqual(["live.pause", "live.say"]);
  expect(calls("// harness.jobs.cancel(user, id)\n/* sessions.compact(scope) */\nstart(scope: Scope): void;\nrunner.start(input);\nholds.add(run, 'paused');")).toEqual([]);
});

test("no RPH source but the folder host's command line calls a member of the owner-only list, and every name on the list is a member of the harness's API", async () => {
  const s = (open = await stage({ answers: [] }));
  const harness = s.harness as unknown as Record<string, Record<string, unknown>>;
  expect(OWNER_ONLY.length).toBeGreaterThan(0);
  // "Apply now" is the owner's press too: no source of RPH calls it (the harness's `index.ts` only defines it).
  expect(OWNER_ONLY).toContain("definitions.apply");
  for (const entry of OWNER_ONLY) {
    const [api = "", name = ""] = entry.split(".");
    expect({ entry, member: typeof harness[api]?.[name] }).toEqual({ entry, member: "function" });
  }

  const callers: Record<string, string[]> = {};
  for (const path of await sources(SRC)) {
    const where = relative(join(SRC, ".."), path);
    if (COMMAND_LINE.test(where)) continue;
    const found = calls(await readFile(path, "utf8"));
    if (found.length > 0) callers[where] = found;
  }
  expect(callers).toEqual({});
});
