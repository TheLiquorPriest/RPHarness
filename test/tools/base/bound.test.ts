// The most one call takes (the user's `tools.perCall`): what a base tool asks the host for, what it
// keeps of what comes back, and what it saves and tells the host are held to it, whatever the agent
// asks; a read that stops at it says which stretch it gave. Everything here is invented.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatHit, ChatPort, ChatQuery, GapCheck, GapQuery, HistoryRange, LoreHit, LorePort, LoreQuery, SearchHit, Searcher, StoresPort, StoresQuery, TurnEvents, WebQuery, WebSearchPort } from "../../../src/contract";
import { KIT_SEED } from "../../../src/testing/kit";
import { type Bench, bench, type Extra, SCOPE, textOf } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(() => b.close());

const MESSAGES = KIT_SEED.messages;

/** Hits a host gives, more than any call here asks for, whatever the limit it was asked with. */
const PLENTY = 7;

/** The bench's chat, recording each stretch read and each search; a search gives `PLENTY` hits whatever its limit. */
function chatPort(): { chat: ChatPort; reads: HistoryRange[]; searches: ChatQuery[] } {
  const inner = b.host.chat;
  const reads: HistoryRange[] = [];
  const searches: ChatQuery[] = [];
  const chat: ChatPort = {
    info: (scope) => inner.info(scope),
    position: (scope, id) => inner.position(scope, id),
    read: (scope, range) => {
      reads.push(range);
      return inner.read(scope, range);
    },
    search: async (_scope, query): Promise<ChatHit[]> => {
      searches.push(query);
      return Array.from({ length: PLENTY }, (_, at) => ({ id: `fixture-hit-${at}`, index: at, role: "user", name: "Tamsin", snippet: `fixture snippet ${at}`, how: "words" }));
    },
  };
  return { chat, reads, searches };
}

/** The bench's lore, recording each read and search; a search gives `PLENTY` hits whatever its limit. */
function lorePort(): { lore: LorePort; reads: string[][]; searches: LoreQuery[] } {
  const inner = b.host.lore;
  const reads: string[][] = [];
  const searches: LoreQuery[] = [];
  const lore: LorePort = {
    read: (scope, ids, reader) => {
      reads.push([...ids]);
      return inner.read(scope, ids, reader);
    },
    search: async (_scope, query): Promise<LoreHit[]> => {
      searches.push(query);
      return Array.from({ length: PLENTY }, (_, at) => ({ id: `e-90${at}`, source: "Fixture book", title: `Fixture entry ${at}`, snippet: `fixture lore snippet ${at}`, how: "words" }));
    },
    activated: (scope) => inner.activated(scope),
  };
  return { lore, reads, searches };
}

/** `PLENTY` hits of a search that is not the chat's or the lore's. */
function hits(prefix: string): SearchHit[] {
  return Array.from({ length: PLENTY }, (_, at) => ({ ref: `${prefix}-${at}`, title: `Fixture ${prefix} ${at}`, snippet: `fixture ${prefix} snippet ${at}`, how: "words" }));
}

describe("one call's bound", () => {
  test("chat_read stops at the bound from the stretch's start, and says which stretch it gave and that one read gives no more", async () => {
    const whole = textOf(await b.call("chat_read", {}, { extra: { perCall: 2 } }));
    expect(whole).toContain("Messages #0 to #1 of 6. One read gives at most 2.");
    expect(whole).toContain(MESSAGES[0]!.text);
    expect(whole).toContain(MESSAGES[1]!.text);
    expect(whole).not.toContain(MESSAGES[4]!.text);

    const stretch = textOf(await b.call("chat_read", { from: 3, to: 5 }, { extra: { perCall: 2 } }));
    expect(stretch).toContain("Messages #3 to #4 of 6. One read gives at most 2.");
    expect(stretch).not.toContain(MESSAGES[5]!.text);

    // A stretch the bound holds whole is given whole, and says nothing of the bound.
    const short = textOf(await b.call("chat_read", { from: 4, to: 5 }, { extra: { perCall: 2 } }));
    expect(short).toContain("Messages #4 to #5 of 6.");
    expect(short).not.toContain("at most");
  });

  test("chat_read's last few are the newest, as many as the bound", async () => {
    const answer = textOf(await b.call("chat_read", { last: 5 }, { extra: { perCall: 2 } }));
    expect(answer).toContain("Messages #4 to #5 of 6. One read gives at most 2.");
    expect(answer).toContain(MESSAGES[4]!.text);
    expect(answer).toContain(MESSAGES[5]!.text);
    expect(answer).not.toContain(MESSAGES[3]!.text);
  });

  test("a message named by its id is found without asking the host for more than the bound at a time", async () => {
    const { chat, reads } = chatPort();
    const answer = textOf(await b.call("chat_read", { from_id: "kit-m0", to_id: "kit-m1" }, { extra: { perCall: 2, env: { ...b.host, chat } } }));

    expect(answer).toContain("Messages #0 to #1 of 6.");
    expect(answer).toContain(MESSAGES[0]!.text);
    expect(reads.length).toBeGreaterThan(0);
    for (const range of reads) expect(range.to - range.from).toBeLessThanOrEqual(2);
  });

  test("a search's limit is held to the bound before the host is asked, and no more than the bound of what comes back is kept", async () => {
    const { chat, searches: chatAsked } = chatPort();
    const { lore, searches: loreAsked } = lorePort();
    const storesAsked: StoresQuery[] = [];
    const stores: StoresPort = {
      list: async () => [{ name: "databank", line: "Fixture databank." }],
      search: async (_scope, query) => {
        storesAsked.push(query);
        return hits("item");
      },
      read: async () => undefined,
    };
    const webAsked: WebQuery[] = [];
    const web: WebSearchPort = {
      enabled: async () => true,
      search: async (_scope, query) => {
        webAsked.push(query);
        return hits("https://example.test/page");
      },
    };
    const extra: Extra = { perCall: 2, env: { ...b.host, chat, lore, stores }, web };

    const asked = { query: "bell", limit: 50 };
    const answers = await Promise.all([b.call("chat_search", asked, { extra }), b.call("lore_search", asked, { extra }), b.call("archive_search", asked, { extra }), b.call("web_search", asked, { extra })]);

    expect([chatAsked, loreAsked, storesAsked, webAsked].map((queries) => queries.map((query) => query.limit))).toEqual([[2], [2], [2], [2]]);
    for (const answer of answers) expect(textOf(answer).split("\n")).toHaveLength(2);

    // With no limit named the host's own cap is asked for, and the bound still holds what is kept.
    const unlimited = textOf(await b.call("chat_search", { query: "bell" }, { extra }));
    expect(chatAsked.at(-1)?.limit).toBeUndefined();
    expect(unlimited.split("\n")).toHaveLength(2);
  });

  test("lore_read reads no more entries than the bound, and names the ones it left unread", async () => {
    const { lore, reads } = lorePort();
    const answer = textOf(await b.call("lore_read", { ids: ["e-101", "e-102", "w-7"] }, { extra: { perCall: 2, env: { ...b.host, lore } } }));

    expect(reads).toEqual([["e-101", "e-102"]]);
    expect(answer).toContain("The Saltglass Lighthouse");
    expect(answer).toContain("Harbor of Vell");
    expect(answer).toContain("Not read, since one read gives at most 2 entries: w-7.");
  });

  test("the gap check asks every place for no more than the bound, and saves and tells the host no more than that from each", async () => {
    const { chat, searches: chatAsked } = chatPort();
    const { lore, searches: loreAsked } = lorePort();
    const stateAsked: GapQuery[] = [];
    const state: Searcher = {
      name: "state",
      search: async (_scope, query) => {
        stateAsked.push(query);
        return hits("state");
      },
    };
    const told: GapCheck[] = [];
    const events: TurnEvents = {
      ...b.host.events,
      gapCheck: async (scope, check) => {
        told.push(check);
        await b.host.events.gapCheck(scope, check);
      },
    };

    const answer = textOf(await b.call("gap_check", { topic: "drowned bell", limit: 100_000 }, { extra: { perCall: 3, env: { ...b.host, chat, lore, searchers: [state], events } } }));

    expect([chatAsked.map((query) => query.limit), loreAsked.map((query) => query.limit), stateAsked.map((query) => query.limit)]).toEqual([[3], [3], [3]]);
    const path = /saved as (\S+\.json)\./.exec(answer)?.[1];
    const read = await b.host.files.read(SCOPE, path ?? "");
    const saved = JSON.parse(read.status === "read" ? read.text : "{}") as GapCheck;
    expect(saved.searched.map((place) => [place.where, place.hits.length])).toEqual([
      ["chat", 3],
      ["lore", 3],
      ["state", 3],
    ]);
    expect(told.map((check) => check.searched.map((place) => place.hits.length))).toEqual([[3, 3, 3]]);
  });
});
