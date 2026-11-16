// Every agent of a turn leaves its own transcript in the turn's folder (§5.3 `transcripts/`, §13.4):
// one line per message its model wrote, per tool call and per result, written by RPH through the
// host's file port, whatever the host's trace keeps. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHARACTER, CHAT, request, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [delegate]\ngiven: [prompt:*]\n---\nFixture lead: you run the turn.\n";
const GM = "---\nname: gm\ndescription: Fixture game master.\nmodel: default\ntools: []\n---\nFixture GM: you rule on the sea.\n";

test("a turn with a GM sub-agent on the folder host, whose trace writes nothing per turn, leaves one transcript per agent in transcripts/", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM },
    answers: [{ pieces: [{ call: "delegate", args: { agent: "gm", brief: "Is the tide high?" }, id: "d-1" }] }, { pieces: [{ text: "The tide is high." }] }, { pieces: [{ text: "<reply>The tide is high, Wren says.</reply>" }] }],
  }));

  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");

  const folder = join(s.dir, "files", "chats", CHARACTER, CHAT, "sessions", "s1", "turns", "t1", "transcripts");
  const names = (await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: folder }))).sort();
  const agents = s.trace.of("agent_started").map((record) => `${record.agent?.definition}-${record.agent?.id}.jsonl`.replace(/[^A-Za-z0-9_.-]/g, "-"));
  expect(names).toEqual([...agents].sort());
  const lines = async (name: string) =>
    (await readFile(join(folder, name), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; text?: string; tool?: string; callId?: string });

  const leadFile = names.find((name) => name.startsWith("lead-"));
  const gmFile = names.find((name) => name.startsWith("gm-"));
  if (leadFile === undefined || gmFile === undefined) throw new Error("A transcript is missing.");
  expect((await lines(leadFile)).map((line) => [line.type, line.tool ?? null])).toEqual([
    ["message", null],
    ["call", "delegate"],
    ["result", "delegate"],
    ["message", null],
  ]);
  expect(await lines(gmFile)).toEqual([expect.objectContaining({ type: "message", text: "The tide is high." })]);
});
