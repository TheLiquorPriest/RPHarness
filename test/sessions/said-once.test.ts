// A session file the host will not take (a full disk, a folder taken away, a host that refuses): the
// failure is said once while it lasts, not once per append; a job that ends with its lines still
// unwritten ends failed, in the shipped line's words; and a refusal that ends mid-run lands every
// held line, in order, and the run ends well. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { FilesPort, FileOp, Refused } from "../../src/contract";
import { request, type Stage, stage, USER } from "../harness/support";
import { jobOf } from "../jobs/support";
import { entries, FILE, played, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
const COUNT = (n: number) => ({ pieces: [{ call: "todo", args: { items: [{ text: `count bell ${n}`, done: false }] }, id: `c-${n}` }] });
const SAID = "The session file could not be written";

/** A files port that refuses the appends `refused` picks, as the host would a path outside its view, counting them. */
function refusing(refused: (path: string, change: FileOp) => boolean): { port: (inner: FilesPort) => FilesPort; count: () => number } {
  let count = 0;
  return {
    count: () => count,
    port: (inner) => ({
      layers: (scope) => inner.layers(scope),
      places: (scope) => inner.places(scope),
      find: (scope, query) => inner.find(scope, query),
      read: (scope, path, range) => inner.read(scope, path, range),
      write: async (scope, path, change, by) => {
        if (change.op !== "append" || !refused(path, change)) return inner.write(scope, path, change, by);
        count += 1;
        const refusal: Refused = { status: "refused", path, reason: "outside", writable: [] };
        return refusal;
      },
    }),
  };
}

test("a job whose session file the host refuses: said once for many appends, and the job ends failed with the shipped line in its report", async () => {
  const host = refusing((path) => path.endsWith(".jsonl") && !path.includes("transcripts/"));
  const s = (open = await stage({ files: { ".agents/keeper.md": KEEPER }, filesPort: host.port, answers: [COUNT(1), COUNT(2), COUNT(3), { pieces: [{ text: "Seven bells." }] }] }));

  const job = jobOf(await s.harness.jobs.start(request("t1").scope, { agent: "keeper", brief: "Count the bells." }));
  await s.trace.seen(() => s.trace.of("job").some((record) => record.event.job.state === "failed"));

  expect(host.count()).toBeGreaterThan(3);
  const said = s.logged.filter((line) => line.message.startsWith(SAID));
  expect(said).toHaveLength(1);
  expect(said[0]).toMatchObject({ level: "warn", fields: { status: "refused", reason: "outside" } });
  const ended = await s.harness.jobs.get(USER, job.id);
  expect(ended?.state).toBe("failed");
  expect(ended?.report).toContain("Seven bells.");
  expect(ended?.report).toMatch(/The session file \S+\.jsonl could not be written \(outside\)\. Its lines are held, and go out with the next write that lands\./);
});

test("a refusal that ends mid-run lands every held line in order, said once when it began and once when it ended, and the turn ends well", async () => {
  let refuse = true;
  const host = refusing((path) => {
    if (path !== FILE || !refuse) return false;
    // The host takes the file again after its first refusal.
    refuse = false;
    return true;
  });
  const s = (open = await stage({ filesPort: host.port, answers: [played(1)] }));

  const { outcome } = await s.turn(turn("t1"));

  expect(outcome).toMatchObject({ status: "released", reply: "Reply 1." });
  expect(host.count()).toBe(1);
  expect(s.logged.filter((line) => line.message.startsWith(SAID)).map((line) => line.level)).toEqual(["warn"]);
  const again = s.logged.filter((line) => line.message.startsWith("The session file is written again"));
  expect(again).toHaveLength(1);
  expect(again[0]).toMatchObject({ level: "info", fields: { path: FILE } });
  expect(again[0]!.fields?.["lines"]).toBeGreaterThan(0);
  // On disk, each entry once, after the one it follows, from the turn's first to what it spent.
  const lines = await entries(s);
  const seen = new Set<string>();
  for (const line of lines) {
    expect(seen.has(line.id)).toBe(false);
    if (line.parent !== null) expect(seen.has(line.parent)).toBe(true);
    seen.add(line.id);
  }
  expect(lines[0]?.type).toBe("turn");
  expect(lines.map((line) => line.type)).toContain("intent");
  expect(lines.at(-1)?.type).toBe("spent");
});
