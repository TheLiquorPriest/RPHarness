// A job's own work as its session file keeps it, read back to go on: a message a rule cut, or one
// its provider broke off, left the transcript as it ran, so it is not read back either.
import { expect, test } from "bun:test";
import { SessionLog } from "../../src/sessions/file";
import { keptWork } from "../../src/sessions/work";
import { scriptedModel } from "../../src/testing/rig";
import { textOf } from "../harness/support";

test("a message a rule cut, or one that broke off, is not read back into the work", () => {
  const log = new SessionLog([
    { type: "message", id: "e1", parent: null, at: 0, turn: "job-1", call: 1, text: "Something moves, and a shiver ran down her spine.", stop: "cut" },
    { type: "message", id: "e2", parent: "e1", at: 1, turn: "job-1", call: 2, text: "Something mo", stop: "error", error: "The connection was closed or reset." },
    { type: "message", id: "e3", parent: "e2", at: 2, turn: "job-1", call: 3, text: "Something moves; the cold reaches her first.", stop: "stop" },
  ]);

  const work = keptWork(log, "job-1", scriptedModel([]).model, () => undefined);

  expect(work.map((message) => [message.role, textOf(message)])).toEqual([["assistant", "Something moves; the cold reaches her first."]]);
});
