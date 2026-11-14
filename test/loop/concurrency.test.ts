// Claim c (§18.1 row 0.2, §13.3 "how the loop behaves on Bun with eight agents at once"): eight
// agents in two runs at once, every event carrying its own agent and run, none crossing.
import { describe, expect, test } from "bun:test";
import type { JsonValue, Scope } from "../../src/contract";
import { RunTrace } from "../../src/loop";
import { FakeClock, type Piece, type Reply, rigAgent, said, TraceRecorder, tool, user } from "./support";

const RUNS = ["run-east", "run-west"] as const;
const PER_RUN = 4;

/** Each agent writes its own name into everything it writes, at its own pace, so a crossed piece shows. */
function script(id: string, pace: number): Reply[] {
  const pieces: Piece[] = [];
  for (let n = 1; n <= 4; n += 1) pieces.push({ text: `[${id}] piece ${n}. ` }, { wait: pace });
  pieces.push({ call: "echo", args: { note: id } });
  return [{ pieces }, { pieces: [{ text: `[${id}] done` }] }];
}

describe("eight agents at once", () => {
  test("every event carries its own agent and run, and none crosses", async () => {
    const clock = new FakeClock();
    const calls: { agent: string; run: string; note: JsonValue }[] = [];
    // One tool shared by all eight: only its context can tell it who called.
    const echo = tool("echo", async (args, ctx) => {
      calls.push({ agent: ctx.agent.id, run: ctx.run, note: typeof args === "object" && args !== null && !Array.isArray(args) ? (args["note"] ?? null) : null });
      return said(`echo for ${ctx.agent.id}`);
    });
    const rigs = RUNS.flatMap((run, r) => {
      const recorder = new TraceRecorder();
      const scope: Scope = { user: "user-a", chat: `chat-${r}`, session: `session-${r}`, turn: run };
      const trace = new RunTrace(recorder, scope, run, clock);
      return Array.from({ length: PER_RUN }, (_, a) => {
        const id = `${run}-agent-${a}`;
        return { id, run, ...rigAgent({ id, definition: `def-${a}` }, script(id, 1 + ((a * 3 + r) % 5)), { clock, recorder, trace, tools: [echo] }) };
      });
    });

    const outcomes = await clock.settle(Promise.all(rigs.map((rig) => rig.runner.start({ messages: [user(`Go, ${rig.id}.`)] }).done)));

    expect(outcomes.map((outcome) => [outcome.agent.id, outcome.status, outcome.text])).toEqual(rigs.map((rig) => [rig.id, "done", `[${rig.id}] done`]));
    // The shared tool was told the right agent and run every time.
    expect(calls).toHaveLength(8);
    for (const call of calls) {
      expect(call.note).toBe(call.agent);
      expect(call.agent.startsWith(call.run)).toBe(true);
    }
    for (const run of RUNS) {
      const recorder = rigs.find((rig) => rig.run === run)!.recorder;
      // Numbered from 1 with no gap across the run's four agents.
      expect(recorder.records.map((record) => record.seq)).toEqual(recorder.records.map((_, at) => at + 1));
      for (const record of recorder.records) {
        expect(record.run).toBe(run);
        expect(record.scope.turn).toBe(run);
        const own = record.agent.id;
        expect(own.startsWith(run)).toBe(true);
        const text = JSON.stringify(record.event);
        // Every agent name a record mentions is its own.
        expect(text.match(/run-(east|west)-agent-\d/g)?.every((name) => name === own) ?? true).toBe(true);
      }
      for (const delta of recorder.deltas) {
        expect(delta.run).toBe(run);
        expect((delta.text ?? "").startsWith(`[${delta.agent}]`)).toBe(true);
      }
      // The four agents of the run were at work together: their records interleave.
      const order = recorder.records.map((record) => record.agent.id);
      const switches = order.filter((id, at) => at > 0 && id !== order[at - 1]).length;
      expect(switches).toBeGreaterThan(PER_RUN * 2);
    }
    // Each transcript holds its own agent's words only.
    for (const rig of rigs) {
      const words = JSON.stringify(rig.runner.transcript);
      expect(words.match(/run-(east|west)-agent-\d/g)?.every((name) => name === rig.id)).toBe(true);
    }
    // All eight were working at once: every agent started before any ended.
    const all = rigs.flatMap((rig) => rig.recorder.records.filter((record) => record.agent.id === rig.id));
    const lastStart = Math.max(...all.filter((record) => record.event.kind === "agent_started").map((record) => record.at));
    const firstEnd = Math.min(...all.filter((record) => record.event.kind === "agent_ended").map((record) => record.at));
    expect(lastStart).toBeLessThan(firstEnd);
  });
});
