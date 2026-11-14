// An earlier attempt shown again (§6.3: swipes are siblings; the player can flip back to an earlier
// attempt on an earlier reply). The host says so (`Harness.turnShown`): that attempt is carried
// again, where the attempt it replaces was, and the turns that followed that one follow it, in the
// session and in a branch made from it.
import { afterEach, expect, test } from "bun:test";
import type { TurnRequest } from "../../src/contract";
import { type Stage, stage } from "../harness/support";
import { carried, inOrder, S1, said, turn } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const answer = (name: string) => said(`<intent>Intent ${name}.</intent><reply>Reply ${name}.</reply>`);

test("an attempt shown again on an earlier reply is carried in the place of the one it replaces, by later turns and by a branch", async () => {
  const s = (open = await stage({ answers: ["1", "2a", "2b", "3", "4", "5", "6"].map(answer) }));
  const play = async (id: string, extra: Partial<TurnRequest> = {}) => expect((await s.turn(turn(id, extra))).outcome.status).toBe("released");
  await play("t1");
  await play("t2a", { parent: "t1" });
  // The player swipes: t2b in t2a's place.
  await play("t2b", { kind: "swipe", parent: "t1" });
  await s.harness.turnLeft({ ...S1, turn: "t2a" });
  await play("t3", { parent: "t2b" });
  await play("t4", { parent: "t3" });
  // The player flips the second reply back to its first attempt; the later replies stay.
  await s.harness.turnLeft({ ...S1, turn: "t2b" });
  await s.harness.turnShown({ ...S1, turn: "t2a" });

  await play("t5", { parent: "t4" });
  const five = carried(s.model.requests[5]!);
  expect(inOrder(five, ["Intent 1.", "Intent 2a.", "Intent 3.", "Intent 4."])).toBe(true);
  expect(five).not.toContain("Intent 2b.");
  expect(await s.harness.sessions!.get(S1)).toMatchObject({ turns: 5 });

  // A branch made at t5 starts as the session stood there.
  await s.harness.sessions!.fork({ ...S1, turn: "t5" }, { ...S1, session: "s2" });
  await play("t6", { scope: { ...S1, session: "s2", turn: "t6" }, parent: "t5" });
  const six = carried(s.model.requests[6]!);
  expect(inOrder(six, ["Intent 1.", "Intent 2a.", "Intent 3.", "Intent 4.", "Intent 5."])).toBe(true);
  expect(six).not.toContain("Intent 2b.");
});
