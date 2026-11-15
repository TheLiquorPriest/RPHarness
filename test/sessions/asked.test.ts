// A compaction the host asks for while a turn runs (§11 "Or when you ask for it"): its mark waits
// for the session's next turn and never moves where the session stands, so the running turn's work
// after the ask stays on the path, and a request that names no parent (the session's latest turn)
// carries it.
import { afterEach, expect, test } from "bun:test";
import { gate, type Stage, stage } from "../harness/support";
import { carried, inOrder, material, played, S1, said, TIDE, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

test("a compaction asked for while a turn runs leaves the session where that turn takes it: the next turn, naming no parent, carries what the turn did after the ask", async () => {
  const held = gate();
  const s = (open = await stage({
    config: "compaction:\n  keepTurns: 1\n",
    files: { [TIDE]: "High water at nine.\n" },
    answers: [
      played(1),
      played(2),
      played(3),
      { pieces: [{ hold: held }, { text: "<intent>Intent 4.</intent>" }, { call: "file_read", args: { path: "persistent-workspace/tide.md" } }] },
      said("<reply>Reply 4.</reply>"),
      said("Fixture summary."),
      played(5),
    ],
  }));
  for (const id of ["t1", "t2", "t3"]) expect((await s.turn(turn(id))).outcome.status).toBe("released");
  const four = s.turn(turn("t4"));
  await s.trace.seen((record) => record.scope.turn === "t4" && record.event.kind === "call_started");
  expect(await s.harness.sessions!.compact(S1)).toMatchObject({ compactAsked: true });
  held.open();
  expect((await four).outcome.status).toBe("released");

  expect((await s.turn(turn("t5"))).outcome.status).toBe("released");
  const [summary, five] = s.model.requests.slice(-2);
  expect(inOrder(material(summary!), ["Intent 1.", "Intent 2.", "Intent 3."])).toBe(true);
  expect(inOrder(carried(five!), ["Fixture summary.", "Intent 4.", "High water at nine."])).toBe(true);
});
