// Every search and read of a turn is saved under the turn's `queries/` (§5.3), beside the gap
// checks, named by agent, call and tool, whether the tool is RPH's own or the host's, so another
// agent, a query, the live view and he can see what each agent looked at. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHARACTER, CHAT, type ChatFixture, request, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [lore_search, chat_read, world_query]\ngiven: [prompt:*]\n---\nFixture lead: you run the turn.\n";
const CHAT_PATH: ChatFixture[] = [
  { id: "m1", role: "user", name: "Reader", text: "I climb the stairs to the lamp room." },
  { id: "m2", role: "assistant", name: "Wren Hale", text: "Wren is polishing the brass of the lamp." },
];

test("a lore_search, a chat_read and a host world_query each leave their result in queries/", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD },
    chat: CHAT_PATH,
    tools: { world_query: { tier: "read", family: "world", description: "Fixture: asks the world.", parameters: { properties: { what: { type: "string" } }, required: ["what"] }, run: async () => ({ content: [{ type: "text", text: "The lamp room holds one lamp and a brass rail." }] }) } },
    answers: [
      {
        pieces: [
          { call: "lore_search", args: { query: "drowned bell" }, id: "q-lore" },
          { call: "chat_read", args: { last: 2 }, id: "q-chat" },
          { call: "world_query", args: { what: "the lamp room" }, id: "q-world" },
        ],
      },
      { pieces: [{ text: "<reply>The bell is under the water.</reply>" }] },
    ],
  }));
  await mkdir(join(s.dir, "host", "lore"), { recursive: true });
  await writeFile(join(s.dir, "host", "lore", "bell.json"), JSON.stringify({ id: "bell", source: "harbour-book", title: "The drowned bell", keys: ["bell"], text: "A bronze bell lies under the harbour; it rings in storms." }));

  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

  const folder = join(s.dir, "files", "chats", CHARACTER, CHAT, "sessions", "s1", "turns", "t1", "queries");
  const lead = s.trace.of("agent_started").find((record) => record.agent.definition === "lead")?.agent;
  if (lead === undefined) throw new Error("The lead did not start.");
  const saved = async (call: string, tool: string) => readFile(join(folder, `lead-${lead.id}.${call}.${tool}.md`.replace(/[^A-Za-z0-9._-]/g, "_")), "utf8");
  const answered = (call: string) => s.trace.of("tool_ended").find((record) => record.event.callId === call)?.event.result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) ?? [];

  expect(await saved("q-lore", "lore_search")).toContain("drowned bell");
  expect(await saved("q-chat", "chat_read")).toContain("polishing the brass");
  expect(await saved("q-world", "world_query")).toBe("The lamp room holds one lamp and a brass rail.");
  // Each is what the tool answered, whole.
  expect(await saved("q-chat", "chat_read")).toBe(answered("q-chat").join("\n"));
});
