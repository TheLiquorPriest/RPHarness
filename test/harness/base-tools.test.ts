// RPH's base tools, held by the harness (§6.8, §10.5): RPH's own lead reads a stretch of the chat
// and runs a gap check whose evidence is kept in the turn's folder; `archive_search` and
// `web_search` are offered only where the host has other stores and a web searcher, and a search
// of the web goes through the host's searcher. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { GapCheck, SearchHit, StoresPort, WebQuery, WebSearchPort } from "../../src/contract";
import { CHARACTER, CHAT, type ChatFixture, request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CHAT_PATH: ChatFixture[] = [
  { id: "m1", role: "user", name: "Reader", text: "I climb the stairs to the lamp room." },
  { id: "m2", role: "assistant", name: "Wren Hale", text: "Wren is already up there, polishing the brass." },
  { id: "m3", role: "user", name: "Reader", text: "I ask Wren whether the supply boat came." },
  { id: "m4", role: "assistant", name: "Wren Hale", text: "The supply boat is two days late, Wren says." },
];

/** The answer a call got, as the model read it in the request after it. */
function answerTo(s: Stage, callId: string): string {
  for (const req of s.model.requests) {
    const found = req.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    if (found !== undefined) return textOf(found);
  }
  return "";
}

/** The gap checks kept in a turn's folder: each file's path as agents see it, and what it holds. */
async function evidence(s: Stage, turn: string): Promise<{ path: string; check: GapCheck }[]> {
  const chat = `${s.dir}/files/chats/${CHARACTER}/${CHAT}`;
  const kept: { path: string; check: GapCheck }[] = [];
  for await (const path of new Bun.Glob(`sessions/s1/turns/${turn}/queries/*.json`).scan({ cwd: chat })) kept.push({ path, check: (await Bun.file(`${chat}/${path}`).json()) as GapCheck });
  return kept;
}

test("RPH's own lead reads a stretch of the chat and runs a gap check: the check's evidence is kept in the turn's folder, the host is told, and the answer says where", async () => {
  const s = (open = await stage({
    chat: CHAT_PATH,
    answers: [
      { pieces: [{ call: "chat_read", args: { last: 2 } }, { call: "gap_check", args: { topic: "supply boat", terms: ["Wren"] } }] },
      { pieces: [{ text: "<reply>Two days late, and the sea still rising.</reply>" }] },
    ],
  }));

  const { outcome } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome.status).toBe("released");
  // The stretch asked for, each message whole, and nothing before it.
  const read = answerTo(s, "call_1_1");
  expect(read).toContain("I ask Wren whether the supply boat came.");
  expect(read).toContain("The supply boat is two days late, Wren says.");
  expect(read).not.toContain("polishing the brass");

  const [kept, ...more] = await evidence(s, "t1");
  expect(more).toEqual([]);
  expect(kept?.check).toMatchObject({ topic: "supply boat", terms: ["Wren"], by: { definition: "lead" } });
  const chatHits = kept?.check.searched.find((place) => place.where === "chat")?.hits.map((hit) => hit.ref) ?? [];
  expect(chatHits).toContain("m4");
  expect(chatHits).not.toContain("m1");
  // The model is told where the evidence is, and the host is told of the check with it.
  expect(answerTo(s, "call_1_2")).toContain(kept?.path ?? "no evidence kept");
  const told = s.told.filter((one) => one.kind === "gapCheck").map((one) => one.payload as GapCheck & { saved?: string });
  expect(told).toHaveLength(1);
  expect(told[0]?.saved).toBe(kept?.path);
});

test("the player's bound on one call holds RPH's lead's read of the chat, and the answer says which stretch it gave", async () => {
  const s = (open = await stage({
    config: "tools:\n  perCall: 2\n",
    chat: CHAT_PATH,
    answers: [{ pieces: [{ call: "chat_read", args: {} }] }, { pieces: [{ text: "<reply>The stairs, and Wren at the brass.</reply>" }] }],
  }));

  const { outcome } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome.status).toBe("released");
  const read = answerTo(s, "call_1_1");
  expect(read).toContain("Messages #0 to #1 of 4. One read gives at most 2.");
  expect(read).toContain("polishing the brass");
  expect(read).not.toContain("I ask Wren whether the supply boat came.");
});

test("the hits a gap check takes from each place when the agent names no limit are the player's setting", async () => {
  const s = (open = await stage({
    config: "tools:\n  gapCheck: 1\n",
    chat: CHAT_PATH,
    answers: [{ pieces: [{ call: "gap_check", args: { topic: "Wren" } }] }, { pieces: [{ text: "<reply>Wren is there.</reply>" }] }],
  }));

  await s.turn(request("t1", { lead: "lead" }));

  const [kept] = await evidence(s, "t1");
  expect(kept?.check.searched.find((place) => place.where === "chat")?.hits).toHaveLength(1);
});

test("a host with no web searcher and no other stores still offers both searches, the web's answering it is off; one with both searches the web through the host's searcher", async () => {
  const bare = (open = await stage({ answers: [{ pieces: [{ call: "web_search", args: { query: "tide" } }] }, { pieces: [{ text: "<reply>Nothing to look up.</reply>" }] }] }));
  await bare.turn(request("t1", { lead: "lead" }));
  const offered = bare.model.requests[0]!.tools.map((tool) => tool.name);
  expect(offered).toEqual(expect.arrayContaining(["chat_read", "chat_search", "lore_read", "lore_search", "gap_check", "skill_load", "suggest", "web_search", "archive_search"]));
  await bare.close();

  const asked: WebQuery[] = [];
  const web: WebSearchPort = {
    enabled: async () => true,
    search: async (_scope, query): Promise<SearchHit[]> => {
      asked.push(query);
      return [{ ref: "https://example.test/storms", title: "Fixture storm table", snippet: "Gales on the fourth night.", how: "words" }];
    },
  };
  const stores: StoresPort = { list: async () => [], search: async () => [], read: async () => undefined };
  const s = (open = await stage({
    web,
    stores,
    answers: [{ pieces: [{ call: "web_search", args: { query: "spring tide storm", limit: 3 } }] }, { pieces: [{ text: "<reply>Gales by the fourth night.</reply>" }] }],
  }));

  const { outcome } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome.status).toBe("released");
  expect(s.model.requests[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["archive_search", "web_search"]));
  expect(asked).toEqual([{ text: "spring tide storm", limit: 3 }]);
  const found = answerTo(s, "call_1_1");
  expect(found).toContain("Fixture storm table");
  expect(found).toContain("https://example.test/storms");
});
