// A budget holds a run to the limits the user set (§10.11): a call's answer room is the least of every
// bound on it and of the tokens left under every limit on what it writes, here and in every budget
// above; under the floor no call is made and the tightest limit is named. Every limit reached is
// given, its own and those above, so no limit hides another (AuLane-PlanHarnessCore-1-1): a spent
// limit before a calls limit, which holds only the next call (R-194). A turn's later run counts on
// from what its earlier runs spent (READINGS N-22).
import { describe, expect, test } from "bun:test";
import type { Usage } from "../../src/contract";
import { Budget, emptyUsage } from "../../src/loop";

const author = { id: "author", definition: "author" };
const job = { id: "job-agent", definition: "archivist" };

function spent(fields: Partial<Usage>): Usage {
  return { ...emptyUsage(), ...fields };
}

describe("a call's room", () => {
  test("a call's room is the least of the model's longest reply, the answer per call and every budget's tokens out left; under the floor no call is made and the limit is named", () => {
    const day = new Budget("day", { tokens: 100_000 }, undefined, { used: spent({ input: 90_000, output: 4_000 }) });
    const turn = new Budget("turn", { tokensOut: 20_000 }, day);
    const agent = new Budget("agent", { tokensOut: 9_000 }, turn);
    agent.count(spent({ calls: 1, input: 1_000, output: 3_000 }));
    // Agent: 6,000 out left; turn: 17,000; the day: 100,000 - (91,000 + 7,000) - the prompt's 500 = 1,500.
    expect(agent.room(author, { prompt: 500, floor: 256, bounds: [8_192, undefined, 4_000] })).toEqual({ room: 1_500 });
    // A bound tighter than every budget's room is the room.
    expect(agent.room(author, { prompt: 500, floor: 256, bounds: [1_024, undefined, undefined] })).toEqual({ room: 1_024 });
    // No bound and no limit on what is written: nothing bounds the answer.
    expect(new Budget("agent", { calls: 3 }).room(author, { prompt: 500, floor: 256, bounds: [undefined] })).toEqual({ room: undefined });
    // The next prompt leaves the day under the floor: no call, the day's cap named with what it would stand at.
    expect(agent.room(author, { prompt: 1_900, floor: 256, bounds: [8_192] })).toEqual({ hit: { limit: "tokens", per: "day", max: 100_000, value: 99_900 } });
    // The agent's own limit the tightest under the floor: it is the one named, with whose it is.
    const near = new Budget("agent", { tokensOut: 3_200 }, new Budget("turn", { tokensOut: 20_000 }));
    near.count(spent({ calls: 1, output: 3_000 }));
    expect(near.room(author, { prompt: 0, floor: 256, bounds: [] })).toEqual({ hit: { limit: "tokensOut", per: "agent", max: 3_200, value: 3_000, agent: author } });
  });

  test("a turn's later run counts on from what its earlier runs spent", () => {
    const earlier = spent({ calls: 39, input: 50_000, output: 9_800 });
    const turn = new Budget("turn", { calls: 40, tokensOut: 10_000 }, undefined, { used: earlier });
    expect(turn.room(author, { prompt: 0, floor: 256, bounds: [] })).toEqual({ hit: { limit: "tokensOut", per: "turn", max: 10_000, value: 9_800 } });
    turn.count(spent({ calls: 1 }));
    expect(turn.reached(author).map((hit) => hit.limit)).toEqual(["calls"]);
    expect(earlier.calls).toBe(40);
  });
});

describe("the limits reached", () => {
  test("at its calls limit and past its token limit, no tool starts and the limit named is the one that stopped it", () => {
    const turn = new Budget("turn", { calls: 40, tokensOut: 2_000 });
    const agent = new Budget("agent", { calls: 1 }, turn);
    agent.count(spent({ calls: 1 }));
    // The calls limit alone holds the next call, not this call's tools.
    expect(agent.reached(author)).toEqual([{ limit: "calls", per: "agent", max: 1, value: 1, agent: author }]);
    expect(agent.reached(author).find((hit) => hit.limit !== "calls")).toBeUndefined();
    agent.count(spent({ input: 3_000, output: 2_100 }));
    const hits = agent.reached(author);
    // Both are given; the spent one first, so it holds the tools and is the limit named.
    expect(hits).toEqual([
      { limit: "tokensOut", per: "turn", max: 2_000, value: 2_100 },
      { limit: "calls", per: "agent", max: 1, value: 1, agent: author },
    ]);
    expect(hits.find((hit) => hit.limit !== "calls")?.limit).toBe("tokensOut");
  });

  test("a job's call that reaches its calls limit and spends the day's cap: its tools do not start and the day's cap is named", () => {
    const day = new Budget("day", { tokens: 10_000 }, undefined, { used: spent({ input: 6_000, output: 1_000 }), cachedWeight: 0.1 });
    const run = new Budget("job", { calls: 1 }, day, { cachedWeight: 0.1 });
    const agent = new Budget("agent", {}, run);
    agent.count(spent({ calls: 1, input: 4_000, cacheRead: 2_000, output: 1_500 }));
    // The day: 7,000 before, then 2,000 sent fresh, 2,000 read again at a tenth and 1,500 written.
    const hits = agent.reached(job);
    expect(hits).toEqual([
      { limit: "tokens", per: "day", max: 10_000, value: 10_700 },
      { limit: "calls", per: "job", max: 1, value: 1 },
    ]);
    expect(hits.find((hit) => hit.limit !== "calls")).toEqual({ limit: "tokens", per: "day", max: 10_000, value: 10_700 });
  });
});
