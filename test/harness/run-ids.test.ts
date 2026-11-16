// Every run its own id (C-22): a turn's first run and its continue each take a fresh id from the
// harness's `ids` when they start, as a job's run and a talk's do, so the Live and Turn pages (§14)
// tell the continue from the turn's first run by its id, not by order and time. The turn stays in
// each record's scope, and each run's records are numbered from 1.
import { afterEach, expect, test } from "bun:test";
import type { TraceRecord, TurnRequest } from "../../src/contract";
import { request, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CHIEF = "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [delegate]\ngiven: [prompt:*]\n---\nFixture chief: you run the turn.\n";
const GM = "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: [ask_author]\n---\nFixture GM: rule on what you are asked.\n";

/** A turn as a host sends one, carrying the session on. */
function turn(id: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return request(id, { lead: "chief", carry: "continuing", ...extra });
}

/** The ids of the runs whose records name the turn in their scope, in the order they began. */
function runsOf(records: readonly TraceRecord[], turnId: string): string[] {
  return [...new Set(records.filter((record) => record.scope.turn === turnId).map((record) => record.run))];
}

test("a turn and its continue have two run ids under the turn's scope, each run's records numbered from 1 with no gap, and a sub-agent's records carry its run's id", async () => {
  const s = (open = await stage({
    files: { ".agents/chief.md": CHIEF, ".agents/gm.md": GM },
    answers: [
      { pieces: [{ text: "<reply>The lamp is lit.</reply>" }] },
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump to the far ledge." }, id: "d-1" }] },
      { pieces: [{ text: "At twenty feet the jump fails." }] },
      { pieces: [{ text: "<reply>She falls short of the far ledge.</reply>" }] },
      { pieces: [{ text: "<reply>She catches the rope on the way down.</reply>" }] },
    ],
  }));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  expect((await s.turn(turn("t2", { parent: "t1" }))).outcome.status).toBe("released");
  // The continue, as a host sends it: the same turn, its own parent.
  expect((await s.turn(turn("t2", { kind: "continue", parent: "t1" }))).outcome.status).toBe("released");
  const records = s.trace.records;

  // Two runs under the turn t2, neither named by the turn; each an id the harness's `ids` made, as the stage makes them.
  const [first, continued] = runsOf(records, "t2");
  const [earlier] = runsOf(records, "t1");
  expect(runsOf(records, "t2")).toHaveLength(2);
  for (const run of [first, continued, earlier]) expect(run).toMatch(/^id-\d+$/);
  expect(new Set([first, continued, earlier]).size).toBe(3);

  for (const run of [earlier!, first!, continued!]) {
    const own = records.filter((record) => record.run === run);
    // The turn stays in each record's scope.
    expect(new Set(own.map((record) => record.scope.turn)).size).toBe(1);
    // Numbered from 1, with no gap, each run on its own.
    expect(own.map((record) => record.seq)).toEqual(own.map((_, i) => i + 1));
    // Each run opens with its own start, which says which kind of run of the turn it is.
    expect(own[0]!.event.kind).toBe("run_started");
  }
  const startOf = (run: string) => records.find((record) => record.run === run && record.event.kind === "run_started")?.event;
  expect([startOf(first!), startOf(continued!)]).toMatchObject([{ run: "turn", turn: "new" }, { run: "turn", turn: "continue" }]);

  // The sub-agent the first run's lead started: every record of its work carries that run's id, and so does the call it hangs under.
  const gm = records.filter((record) => record.agent?.id === "gm-1");
  expect(gm.length).toBeGreaterThan(0);
  expect(new Set(gm.map((record) => record.run))).toEqual(new Set([first]));
  expect(gm.find((record) => record.event.kind === "agent_started")?.parent).toMatchObject({ run: first, call: "d-1" });
  // The continue's records are its own: none of the first run's work is filed under its id.
  expect(records.filter((record) => record.run === continued && record.agent?.id === "gm-1")).toEqual([]);
});

test("a turn's log lines name the turn and the run, each under its own name", async () => {
  // The scripted model's window is 64,000 tokens. Past this reserve, the second turn's first call would not fit, and with the
  // newest three turns kept the session has no earlier turn to summarize: that is logged. The drafted author is given the session's carry.
  const answers = ["<intent>Intent one.</intent><reply>Reply one.</reply>", "<intent>Intent two.</intent><reply>Reply two.</reply>"].map((text) => ({ pieces: [{ text }] }));
  const s = (open = await stage({ drafted: true, config: "compaction:\n  reserve: 63999\n", answers }));
  expect((await s.turn(request("t1", { carry: "continuing" }))).outcome.status).toBe("released");
  expect((await s.turn(request("t2", { carry: "continuing", parent: "t1" }))).outcome.status).toBe("released");
  const run = s.trace.of("run_started").find((record) => record.scope.turn === "t2")!.run;
  const tight = s.logged.filter((line) => line.message.startsWith("A call would not fit") && line.fields?.["turn"] === "t2");
  expect(tight).toHaveLength(1);
  expect(tight[0]!.fields).toMatchObject({ turn: "t2", run });
  expect(run).not.toBe("t2");
});
