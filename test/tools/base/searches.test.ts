// `archive_search` and `web_search`: each held only while the host offers a searcher for it; the
// host's other stores searched and read in full by a hit's ref; the web searched under the
// player's own setting for what acts outside. The stores and the web here are invented.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApprovalsPort, StoreItem, StoresPort, WebSearchPort } from "../../../src/contract";
import { type Bench, bench, type Extra, LEAD, textOf, turnGate } from "./support";

let b: Bench;
beforeAll(async () => {
  b = await bench();
});
afterAll(() => b.close());

const ITEMS: StoreItem[] = [
  { ref: "databank/tides", store: "databank", title: "Tide tables of Vell", text: "High water comes at the sixth bell; low water six hours on." },
  { ref: "memory/arc-3", store: "memory", title: "The bell arc", text: "Tamsin swore to raise the drowned bell before the harbor freezes." },
];

const STORES: StoresPort = {
  list: async () => [
    { name: "databank", line: "Fixture: files the player attached." },
    { name: "memory", line: "Fixture: what the chat application remembers." },
  ],
  search: async (_scope, query) =>
    ITEMS.filter((item) => (query.stores === undefined || query.stores.includes(item.store)) && item.text.toLowerCase().includes(query.text.toLowerCase()))
      .slice(0, query.limit)
      .map((item) => ({ ref: item.ref, title: item.title, snippet: item.text.slice(0, 40), how: "words" as const })),
  read: async (_scope, ref) => ITEMS.find((item) => item.ref === ref),
};

const WEB: WebSearchPort = {
  enabled: async () => true,
  search: async (_scope, query) => [{ ref: "https://example.org/bronze-bells", title: `Bronze bells and the sea (${query.text})`, snippet: "Bronze keeps for centuries under salt water.", how: "words" }],
};

describe("which of the two an agent can hold", () => {
  test("both are held whatever the host offers", () => {
    for (const tools of [b.tools(), b.tools({ env: { ...b.host, stores: STORES }, web: WEB })]) {
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("web_search");
      expect(names).toContain("archive_search");
    }
  });

  test("off: the line and no search; switched on: the next call searches", async () => {
    let on = false;
    const asked: string[] = [];
    const web: WebSearchPort = { enabled: async () => on, search: async (scope, query) => (asked.push(query.text), WEB.search(scope, query)) };
    const off = await b.call("web_search", { query: "bells" }, { extra: { web } });
    const none = await b.call("web_search", { query: "bells" }, { extra: {} });
    on = true;
    const searched = textOf(await b.call("web_search", { query: "bells" }, { extra: { web } }));
    expect([off.error, none.error]).toEqual([true, true]);
    expect(textOf(off)).toContain("Web search is off");
    expect(asked).toEqual(["bells"]);
    expect(searched).toContain("https://example.org/bronze-bells");
  });
});

describe("archive_search", () => {
  const extra = (): Extra => ({ env: { ...b.host, stores: STORES } });

  test("finds what the host's other stores hold by its words, and a hit's ref reads it in full", async () => {
    const found = textOf(await b.call("archive_search", { query: "drowned bell" }, { extra: extra() }));
    const read = textOf(await b.call("archive_search", { ref: "memory/arc-3" }, { extra: extra() }));

    expect(found).toContain("memory/arc-3");
    expect(found).not.toContain("databank/tides");
    expect(read).toContain(ITEMS[1]!.text);
    expect(read).toContain(ITEMS[1]!.title);
  });

  test("searches only the stores named, and a store the host does not have is said with the ones it has", async () => {
    const only = textOf(await b.call("archive_search", { query: "bell", stores: ["databank"] }, { extra: extra() }));
    const unknown = await b.call("archive_search", { query: "bell", stores: ["diary"] }, { extra: extra() });

    expect(only).toContain("databank/tides");
    expect(only).not.toContain("memory/arc-3");
    expect(unknown.error).toBe(true);
    expect(textOf(unknown)).toContain("diary");
    expect(textOf(unknown)).toContain("databank, memory");
  });

  test("a ref with nothing behind it is said, not thrown", async () => {
    const result = await b.call("archive_search", { ref: "memory/arc-99" }, { extra: extra() });

    expect(result.error).toBe(true);
    expect(textOf(result)).toContain("memory/arc-99");
  });
});

describe("web_search", () => {
  test("gives the pages the host's web searcher found, each with its address", async () => {
    const answer = textOf(await b.call("web_search", { query: "bronze bell salt water" }, { extra: { web: WEB } }));

    expect(answer).toContain("https://example.org/bronze-bells");
    expect(answer).toContain("Bronze bells and the sea (bronze bell salt water)");
  });

  test("it acts outside, so a player who allows nothing outside gets it refused before it runs", async () => {
    const lanes: string[] = [];
    const approvals: ApprovalsPort = {
      permission: async (_scope, lane) => {
        lanes.push(lane);
        return lane === "external" ? "never" : "auto";
      },
      ask: async () => ({ go: true }),
    };
    const gate = await turnGate(b, { approvals, tools: b.tools({ web: WEB }) });

    const before = await gate.before({ agent: LEAD, callId: "call-web", tool: "web_search", args: { query: "bells" } }, new AbortController().signal);

    expect(lanes).toEqual(["external"]);
    expect(before.refuse?.error).toBe(true);
  });
});
