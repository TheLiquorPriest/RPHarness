// `gap_check` over the folder host's seed: one search across the chat, the lore and the host's own
// searchers; what was searched and what came back saved in the turn's `queries/` folder, named in
// the answer, and told to the host; a place that could not be searched never counted as empty.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GapCheck, GapQuery, Searcher, TurnEvents } from "../../../src/contract";
import { type Bench, bench, type Extra, SCOPE, textOf } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(() => b.close());

/** The host's environment with these searchers, and a record of the gap checks it is told of. */
function host(searchers: Searcher[]): { extra: Extra; told: GapCheck[] } {
  const told: GapCheck[] = [];
  const events: TurnEvents = {
    ...b.host.events,
    gapCheck: async (scope, check) => {
      told.push(check);
      await b.host.events.gapCheck(scope, check);
    },
  };
  return { extra: { env: { ...b.host, searchers, events } }, told };
}

/** The evidence file the answer names, read back as the agents see it. */
async function evidence(answer: string): Promise<GapCheck> {
  const path = /saved as (\S+\.json)\./.exec(answer)?.[1];
  expect(path).toBeDefined();
  const read = await b.host.files.read(SCOPE, path!);
  expect(read.status).toBe("read");
  return JSON.parse(read.status === "read" ? read.text : "{}") as GapCheck;
}

describe("gap_check", () => {
  test("searches the chat and the lore by the names and words given, saves what came back in the turn's queries folder, names it, and tells the host", async () => {
    const { extra, told } = host([]);
    const answer = textOf(await b.call("gap_check", { topic: "drowned bell", terms: ["the bronze bell"] }, { extra }));

    const saved = await evidence(answer);
    expect(saved.topic).toBe("drowned bell");
    expect(saved.terms).toEqual(["the bronze bell"]);
    expect(saved.searched.map((s) => s.where)).toEqual(["chat", "lore"]);
    expect(saved.searched[0]!.hits.map((h) => h.ref)).toContain("kit-m3");
    expect(saved.searched[1]!.hits.map((h) => h.ref)).toEqual(expect.arrayContaining(["w-7", "e-102"]));
    expect(answer).toContain("kit-m3");
    expect(answer).toContain("w-7");
    expect(told).toHaveLength(1);
    expect(told[0]!.id).toBe(saved.id);
    expect(answer).toContain(told[0]!.saved!);
    expect(told[0]!.saved!.startsWith(`sessions/${SCOPE.session}/turns/${SCOPE.turn}/queries/`)).toBe(true);
  });

  test("each searcher the host offers is searched too, with the topic, the terms and the agent the check is for, and is named in the evidence", async () => {
    const asked: GapQuery[] = [];
    const story: Searcher = {
      name: "story",
      search: async (_scope, query) => {
        asked.push(query);
        return [{ ref: "thread/bell", title: "The bell's silence", snippet: "The bell has not rung in forty years.", how: "words" }];
      },
    };
    const { extra } = host([story]);
    // An agent that plays a character: the host's searcher, as its lore does, gives only what the character may know (§9.4).
    const wren = { id: "character-1", definition: "character", parent: "lead", plays: "Wren" };
    const answer = textOf(await b.call("gap_check", { topic: "drowned bell", terms: ["bronze bell"], limit: 5 }, { extra, agent: wren }));

    expect(asked).toEqual([{ topic: "drowned bell", terms: ["bronze bell"], limit: 5, reader: wren }]);
    const saved = await evidence(answer);
    expect(saved.searched.map((s) => s.where)).toEqual(["chat", "lore", "story"]);
    expect(saved.searched[2]!.hits).toEqual([{ ref: "thread/bell", title: "The bell's silence", snippet: "The bell has not rung in forty years.", how: "words" }]);
    expect(answer).toContain("thread/bell");
  });

  test("a topic nothing holds comes back empty from every place, and that is saved as the evidence of the gap", async () => {
    const { extra, told } = host([]);
    const result = await b.call("gap_check", { topic: "quillfeather" }, { extra });

    expect(result.error).toBeUndefined();
    const saved = await evidence(textOf(result));
    expect(saved.searched).toEqual([
      { where: "chat", hits: [] },
      { where: "lore", hits: [] },
    ]);
    expect(told).toHaveLength(1);
  });

  test("a place that could not be searched is said, and left out of what was searched rather than saved as empty", async () => {
    const broken: Searcher = {
      name: "state",
      search: async () => {
        throw new Error("the state index is rebuilding");
      },
    };
    const { extra } = host([broken]);
    const answer = textOf(await b.call("gap_check", { topic: "quillfeather" }, { extra }));

    expect(answer).toContain("the state index is rebuilding");
    const saved = await evidence(answer);
    expect(saved.searched.map((s) => s.where)).toEqual(["chat", "lore"]);
  });

  test("a check with no topic searches nothing and saves nothing", async () => {
    const { extra, told } = host([]);
    const result = await b.call("gap_check", { topic: "  " }, { extra });

    expect(result.error).toBe(true);
    expect(told).toEqual([]);
  });
});
