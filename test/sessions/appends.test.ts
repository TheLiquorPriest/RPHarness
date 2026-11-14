// The session file is written in as few appends as the disk allows: the lines made while one append
// is under way go together in the next, in the order they were made, so a host's append (which may
// read the whole file) is paid once per batch and not once per entry.
import { afterEach, expect, test } from "bun:test";
import type { FilesPort, Scope } from "../../src/contract";
import { gate, request, type Stage, stage, USER, CHAT } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const S1: Scope = { user: USER, chat: CHAT, session: "s1" };
const FILE = "sessions/s1/s1.jsonl";
const TIDE = "chats/wren-hale/lighthouse/persistent-workspace/tide.md";

test("the lines a turn makes while an append is under way reach the file together in the next, whole and in order", async () => {
  const held = gate();
  let appends = 0;
  const filesPort = (inner: FilesPort): FilesPort => ({
    layers: (scope) => inner.layers(scope),
    places: (scope) => inner.places(scope),
    find: (scope, query) => inner.find(scope, query),
    read: (scope, path, range) => inner.read(scope, path, range),
    write: async (scope, path, change, by) => {
      if (path === FILE && change.op === "append") {
        appends += 1;
        // The first append (the file's first line and the turn's) waits until the lead's second call.
        if (appends === 1) await held.opened;
      }
      return inner.write(scope, path, change, by);
    },
  });
  const s = (open = await stage({
    filesPort,
    files: { [TIDE]: "High water at nine.\n" },
    answers: [
      { pieces: [{ text: "<intent>Intent one.</intent>" }, { call: "file_read", args: { path: "persistent-workspace/tide.md" } }] },
      () => {
        held.open();
        return { pieces: [{ text: "<reply>Reply one.</reply>" }] };
      },
    ],
  }));
  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

  const read = await s.env.files.read(S1, FILE);
  if (read.status !== "read") throw new Error(`The session file is not there: ${read.status}`);
  const lines = read.text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { type: string; id: string; parent: string | null });
  expect(lines.map((line) => line.type)).toEqual(["session", "turn", "intent", "message", "call", "result", "message"]);
  for (const [i, line] of lines.entries()) if (i > 1) expect(line.parent).toBe(lines[i - 1]!.id);
  // The first append, then what the turn made while it waited, in one; the last message joins it or follows. Never one append per entry.
  expect(appends).toBeLessThanOrEqual(3);
});
