// A session line the disk would not take (§11 "the file keeps everything, so nothing is lost"):
// its lines go out again, before anything newer, once the disk takes them, and until then the
// harness keeps the session whole in memory. So a write that fails, the `compacted` entry among its
// lines, never costs a later turn the session's history, and no entry on disk names a parent the
// file lacks.
import { afterEach, expect, test } from "bun:test";
import type { FilesPort } from "../../src/contract";
import { type Stage, stage } from "../harness/support";
import { carried, entries, FILE, inOrder, play, played, S1, said } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

test("appends refused from the one holding the compacted entry to the end of that turn: the next turn carries the summary and every turn after it, and the file on disk is whole once the disk takes the lines", async () => {
  let failing = false;
  let healed = false;
  const filesPort = (inner: FilesPort): FilesPort => ({
    layers: (scope) => inner.layers(scope),
    places: (scope) => inner.places(scope),
    find: (scope, query) => inner.find(scope, query),
    read: (scope, path, range) => inner.read(scope, path, range),
    write: async (scope, path, change, by) => {
      if (!healed && path === FILE && change.op === "append" && (failing || change.text.includes('"type":"compacted"'))) {
        failing = true;
        throw new Error("Fixture: the disk is full.");
      }
      return inner.write(scope, path, change, by);
    },
  });
  const s = (open = await stage({
    filesPort,
    config: "compaction:\n  keepTurns: 2\n",
    answers: [played(1), played(2), played(3), said("Fixture summary: the tide was checked."), played(4), played(5), played(6)],
  }));
  const sessions = s.harness.sessions!;
  await play(s, ["t1", "t2", "t3"]);
  await sessions.compact(S1);
  await play(s, ["t4"], "t3");
  expect(failing).toBe(true);
  expect(s.logged.some((line) => line.level === "error" && line.fields?.["error"] === "Fixture: the disk is full.")).toBe(true);

  // The disk takes lines again: the next turn finds the session as t4 left it.
  healed = true;
  await play(s, ["t5"], "t4");
  const five = carried(s.model.requests[5]!);
  expect(inOrder(five, ["Fixture summary: the tide was checked.", "Intent 2.", "Intent 3.", "Intent 4."])).toBe(true);
  expect(five).not.toContain("Intent 1.");
  expect(await sessions.get(S1)).toMatchObject({ turns: 5 });

  // On disk, every entry follows one written before it, the summary among them.
  const lines = await entries(s);
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.parent !== null) expect(seen.has(line.parent)).toBe(true);
    seen.add(line.id);
  }
  expect(lines.filter((line) => line.type === "compacted").map((line) => line.turn)).toEqual(["t4"]);

  // A turn read from disk alone carries it all.
  await play(s, ["t6"], "t5");
  expect(inOrder(carried(s.model.requests[6]!), ["Fixture summary: the tide was checked.", "Intent 2.", "Intent 3.", "Intent 4.", "Intent 5."])).toBe(true);
});
