// A change to any part of an opening block reaches the session (§5.2, §10.2, R-119, R-128): the
// lead's next briefing gives each changed part's whole current text (the reply contract as rendered
// for the session's form, never the copy the block was made with) or says it is off; "Apply now"
// makes the block afresh for the first run that starts after the press, while a run already going
// keeps its own, and the block made afresh stands over a restart; and an agent that goes on past an
// edit of a file it reads is told the new text in its next message. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Scope, TurnRequest } from "../../src/contract";
import { SHIPPED_GUIDANCE } from "../../src/harness/shipped";
import { createHarness } from "../../src/index";
import { scriptedModel } from "../../src/testing/rig";
import { CHAT, type RecordedRequest, request, type Stage, stage, textOf, USER, WatchedSink } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const S1: Scope = { user: USER, chat: CHAT, session: "s1" };
const CHAT_DIR = "chats/wren-hale/lighthouse/";
const REPLY = { pieces: [{ text: "<reply>Wren counts the candles.</reply>" }] };
const lead = (words: string, tools = "file_read") => `---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [${tools}]\ngiven: [prompt:*, briefing]\n---\nFixture lead: ${words}\n`;

function turn(id: string, parent?: string): TurnRequest {
  return request(id, { lead: "lead", ...(parent !== undefined ? { parent } : {}) });
}

/** The lead's first request of each of two turns of one session, with `between` done after the first. */
async function twoTurns(files: Record<string, string>, between: (dir: string) => Promise<void>): Promise<{ first: RecordedRequest; second: RecordedRequest }> {
  const s = (open = await stage({ files, answers: [REPLY, REPLY] }));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  await between(join(s.dir, "files"));
  expect((await s.turn(turn("t2", "t1"))).outcome.status).toBe("released");
  return { first: s.model.requests[0]!, second: s.model.requests[1]! };
}

test("a reply contract edited mid-session: the next briefing gives its new text and says the block's copy no longer stands, and never repeats the old one", async () => {
  const shipped = (await Bun.file(join(SHIPPED_GUIDANCE, ".prompts", "reply-contract.md")).text()).trimEnd();
  const { second } = await twoTurns({ ".agents/lead.md": lead("you run the turn."), ".prompts/reply-contract.md": `${shipped}\nFixture old contract line.\n` }, async (dir) => {
    await writeFile(join(dir, ".prompts/reply-contract.md"), `${shipped}\nFixture new contract line.\n`);
  });

  // The opening block holds still for the session: the cached front keeps the contract it was made with.
  expect(textOf(second.messages[0]!)).toContain("Fixture old contract line.");
  const briefing = textOf(second.messages.at(-1)!);
  expect(briefing).toContain("@global/.prompts/reply-contract.md was changed since this session opened. The copy in the opening block no longer stands.");
  expect(briefing).toContain("Fixture new contract line.");
  expect(briefing).not.toContain("Fixture old contract line.");
});

test("a tool guide switched off is named off", async () => {
  const { first, second } = await twoTurns({ ".agents/lead.md": lead("you run the turn."), ".tools/files.md": "---\ndescription: Fixture guide to the file tools.\n---\nFixture files guide.\n" }, async (dir) => {
    await writeFile(join(dir, CHAT_DIR, "config.yml"), "off: [tools/files]\n");
  });

  expect(textOf(first.messages[0]!)).toContain("Fixture files guide.");
  expect(textOf(second.messages.at(-1)!)).toContain("@global/.tools/files.md has been switched off since this session opened.");
});

test("Apply now while the lead's run is going: that run's next request still carries the block it started with; the next turn's first request carries the new block and the definition's new tool list; after a restart the new block stands", async () => {
  let s: Stage | undefined;
  const read = { pieces: [{ call: "file_read", args: { path: "persistent-workspace/tide.md" } }] };
  s = open = await stage({
    files: { ".agents/lead.md": lead("the old words.") },
    answers: [
      read,
      async () => {
        // The owner edits the lead's definition and presses "Apply now" while its run is going.
        await writeFile(join(s!.dir, "files", ".agents/lead.md"), lead("the new words.", "file_read, file_find"));
        await s!.harness.definitions.apply(S1);
        return read;
      },
      REPLY,
      REPLY,
    ],
  });
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  expect((await s.turn(turn("t2", "t1"))).outcome.status).toBe("released");
  const [, , after, next] = s.model.requests;
  const names = (req: RecordedRequest) => req.tools.map((tool) => tool.name);

  // The run under way keeps the block it started with to its end.
  expect(textOf(after!.messages[0]!)).toContain("the old words.");
  expect(names(after!)).not.toContain("file_find");
  // The next run made its block afresh, with the definition's new list.
  expect(textOf(next!.messages[0]!)).toContain("the new words.");
  expect(names(next!)).toContain("file_find");

  // The press and the block made afresh are kept in the session file, in that order.
  const kept = await s.env.files.read(S1, "sessions/s1/s1.jsonl");
  if (kept.status !== "read") throw new Error(`The session file is not there: ${kept.status}`);
  const entries = kept.text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { type: string });
  expect(entries.map((entry) => entry.type).filter((type) => type === "opening" || type === "applied")).toEqual(["opening", "applied", "opening"]);

  // A restart goes on with the block made afresh, not with the files as they stand since.
  await writeFile(join(s.dir, "files", ".agents/lead.md"), lead("the newest words."));
  const model = scriptedModel([REPLY], { clock: s.clock });
  let id = 0;
  const again = createHarness(s.env, { models: { agentModel: async () => model.agentModel() }, ids: () => `again-${(id += 1)}` });
  try {
    const req = turn("t3", "t2");
    await s.host.givePrompt(req.scope, { messages: req.prompt });
    expect((await again.answer(req, new WatchedSink(s.clock), new AbortController().signal)).status).toBe("released");
  } finally {
    await again.close();
  }
  const restarted = textOf(model.requests[0]!.messages[0]!);
  expect(restarted).toContain("the new words.");
  expect(restarted).not.toContain("the newest words.");
});

test("an agent whose work spans an edit of a file it reads is told the file's new text in its next message, as the lead is in its next briefing", async () => {
  const keeper = "---\nname: keeper\ndescription: Fixture keeper.\nmodel: default\ntools: [file_read]\nreads: [ALL-AGENTS]\n---\nFixture keeper: keep the books.\n";
  let s: Stage | undefined;
  s = open = await stage({
    files: { ".agents/lead.md": lead("you run the turn.", "delegate"), ".agents/keeper.md": keeper, "ALL-AGENTS.md": "Fixture rule for all: keep to the log.\n" },
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "keeper", brief: "Keep the books." } }] },
      async () => {
        // The file changes while the keeper's first call is answered.
        await writeFile(join(s!.dir, "files", "ALL-AGENTS.md"), "Fixture rule for all: the log is closed.\n");
        return { pieces: [{ call: "file_read", args: { path: "persistent-workspace/ledger.md" } }] };
      },
      { pieces: [{ text: "The books are kept." }] },
      REPLY,
    ],
  });
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  const [, first, next] = s.model.requests;

  // Its block holds what it started with; its next message says what changed, with the whole new text.
  expect(textOf(first!.messages[0]!)).toContain("keep to the log.");
  expect(textOf(next!.messages[0]!)).toContain("keep to the log.");
  const told = next!.messages.slice(first!.messages.length).map((message) => textOf(message));
  const notice = told.find((text) => text.includes("@global/ALL-AGENTS.md was changed since this session opened."));
  expect(notice).toContain("Fixture rule for all: the log is closed.");
  // Said once: its first request said nothing of it.
  expect(first!.messages.map((message) => textOf(message)).some((text) => text.includes("was changed since"))).toBe(false);
});
