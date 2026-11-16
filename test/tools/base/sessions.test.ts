// `archive_search` over the chat's earlier sessions, which RPH keeps for every host. Invented.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Bench, bench, SCOPE, textOf } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
  const lines = (session: string, text: string): string =>
    [
      { type: "session", version: 1, id: session, user: SCOPE.user, chat: SCOPE.chat, at: 1 },
      { type: "turn", id: "e1", parent: null, at: 2, turn: "t1", kind: "message", lead: "lead" },
      { type: "message", id: "e2", parent: "e1", at: 3, turn: "t1", call: 0, text, stop: "stop" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n";
  const earlier = { ...SCOPE, session: "s-earlier" };
  await b.host.files.write(earlier, "sessions/s-earlier/s-earlier.jsonl", { op: "write", text: lines("s-earlier", "Ruling: the drowned bell may only be raised at the spring tide, never in winter.") }, "harness");
  await b.host.files.write(SCOPE, `sessions/${SCOPE.session}/${SCOPE.session}.jsonl`, { op: "write", text: lines(SCOPE.session, "The drowned bell is talked of in the open session.") }, "harness");
});
afterAll(() => b.close());

test("a ruling written in an earlier session is found by its words and read in full by its ref; the open session is not searched; with no host stores, archive_search still answers from sessions", async () => {
  const found = textOf(await b.call("archive_search", { query: "drowned bell spring" }));
  expect(found).toContain("sessions/s-earlier/s-earlier.jsonl#e2");
  expect(found).not.toContain(`${SCOPE.session}.jsonl`);
  const read = textOf(await b.call("archive_search", { ref: "sessions/s-earlier/s-earlier.jsonl#e2" }));
  expect(read).toContain("never in winter.");
});
