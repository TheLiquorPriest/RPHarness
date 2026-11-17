// The user's rules and instruction files proved through real turns (§5.2, §5.4, §13.3, §17.2): a
// reminder stops the moment the file it needs is switched off, within the run; a stream rule on
// thinking cuts the call and the agent goes on; `interrupt: never` reminds after the message; a
// pattern on a tool's arguments without `hold:` returns its text with the result, and the tool ran;
// thinking reaches the live view as it streams; an edited instruction file reaches the next
// briefing; the files added for a swipe and after a delete are in that turn's briefing. Everything
// here is invented.
import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LiveItem, TurnRequest } from "../../src/contract";
import { request, type Stage, stage, textOf, USER } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CHAT_DIR = "chats/wren-hale/lighthouse/";
const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [file_read]\nreads: [TURN]\ngiven: [prompt:*, briefing]\n---\nFixture lead: you run the turn.\n";
const TURN_FILE = "Fixture turn: keep the record ahead of the window.\n";
const REPLY = { pieces: [{ text: "<reply>Wren counts the candles.</reply>" }] };
const READ = { pieces: [{ call: "file_read", args: { path: "persistent-workspace/tide.md" }, id: "r-1" }] };
const rule = (name: string, header: string, text: string) => ({ [`.rules/${name}.md`]: `---\ndescription: Fixture ${name}.\nagents: [lead]\n${header}---\n${text}\n` });

function turn(id: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return request(id, { lead: "lead", ...extra });
}

/** The rules fired in the stage's trace, as `<rule> <action>`. */
function fired(s: Stage): string[] {
  return s.trace.of("rule_fired").map((record) => `${record.event.firing.rule} ${record.event.firing.action}`);
}

test("TURN.md switched off between two calls of the lead: history-leaving does not fire at the run's end", async () => {
  const leaving = rule("history-leaving", "needs: TURN\nat: run-end\nrepeat: once per turn\n", "Fixture: the record is behind the window.");
  const files = { ".agents/lead.md": LEAD, "TURN.md": TURN_FILE, ...leaving };

  // In force, it fires at the run's end and the lead is given one more call.
  const kept = (open = await stage({ files, answers: [READ, REPLY, { pieces: [{ text: "Noted." }] }] }));
  expect((await kept.turn(turn("t1"))).outcome.status).toBe("released");
  expect(fired(kept)).toEqual(["history-leaving follow-up"]);
  expect(kept.model.requests).toHaveLength(3);
  await kept.close();

  // Switched off while the lead's second call is answered: the run's end reads the files as they stand.
  let s: Stage | undefined;
  s = open = await stage({
    files,
    answers: [
      READ,
      async () => {
        await writeFile(join(s!.dir, "files", CHAT_DIR, "config.yml"), "stack: { off: [TURN] }\n");
        return REPLY;
      },
    ],
  });
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  expect(fired(s)).toEqual([]);
  expect(s.model.requests).toHaveLength(2);
});

test("a stream rule on thinking cuts the call and the agent goes on", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ...rule("no-guessing", "scope: [thinking]\ncondition: 'I might guess'\n", "Fixture: do not guess at a name.") },
    answers: [{ pieces: [{ thinking: "I might guess the keeper's name." }, { text: "<reply>A guess.</reply>" }] }, REPLY],
  }));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");

  expect(s.trace.of("rule_fired").map((record) => record.event.firing)).toEqual([expect.objectContaining({ rule: "no-guessing", action: "cut", watched: "thinking" })]);
  expect(s.model.requests).toHaveLength(2);
  expect(textOf(s.model.requests[1]!.messages.at(-1)!)).toContain("Fixture: do not guess at a name.");
});

test("`interrupt: never` through the runner reminds after the message", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, ...rule("hedging", "scope: [text]\ncondition: 'the keeper'\ninterrupt: never\n", "Fixture: name what you know of the keeper.") },
    answers: [{ pieces: [{ text: "Asking after the keeper." }, { call: "file_read", args: { path: "persistent-workspace/tide.md" }, id: "r-1" }] }, REPLY],
  }));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");

  expect(fired(s)).toEqual(["hedging remind"]);
  // The message was not cut: its call ran, and the reminder came after it, with the next call.
  expect(s.trace.of("tool_ended").map((record) => record.event.callId)).toContain("r-1");
  const second = s.model.requests[1]!.messages.map((message) => textOf(message));
  const result = second.findIndex((text) => text.includes("tide.md"));
  const reminder = second.findIndex((text) => text.includes("Fixture: name what you know of the keeper."));
  expect(reminder).toBeGreaterThan(result);
});

test("a pattern on a tool's arguments without `hold:` returns its text with the result, and the tool ran", async () => {
  const s = (open = await stage({
    files: { ".agents/lead.md": LEAD, [`${CHAT_DIR}persistent-workspace/tide.md`]: "High water at nine.\n", ...rule("tide-note", "scope: [arguments:file_read]\ncondition: 'tide'\n", "Fixture: the tide table is a week old.") },
    answers: [READ, REPLY],
  }));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");

  expect(fired(s)).toEqual(["tide-note remind"]);
  const answer = s.model.requests[1]!.messages.find((message) => message.role === "toolResult" && message.toolCallId === "r-1");
  const text = textOf(answer!);
  expect(text).toContain("High water at nine.");
  expect(text.indexOf("Fixture: the tide table is a week old.")).toBeGreaterThan(text.indexOf("High water at nine."));
});

test("thinking reaches the live view as it streams", async () => {
  const s = (open = await stage({ files: { ".agents/lead.md": LEAD }, answers: [{ pieces: [{ thinking: "The candles first." }, { text: "<reply>Wren counts the candles.</reply>" }] }] }));
  const items: LiveItem[] = [];
  const stop = s.harness.live.subscribe({ user: USER }, (item) => items.push(item));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  // The hub sends in the microtasks after the run's own step: past them, every item has gone out.
  const { promise: drained, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await drained;
  stop();

  const thought = items.findIndex((item) => item.type === "delta" && item.delta.thinking?.includes("The candles first.") === true);
  const ended = items.findIndex((item) => item.type === "event" && item.record.event.kind === "call_ended");
  expect(thought).toBeGreaterThanOrEqual(0);
  // Sent as it came, before the call it is of ended.
  expect(thought).toBeLessThan(ended);
});

test("an edited instruction file reaches the next briefing in a real turn", async () => {
  const s = (open = await stage({ files: { ".agents/lead.md": LEAD, "TURN.md": TURN_FILE }, answers: [REPLY, REPLY] }));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  await writeFile(join(s.dir, "files", "TURN.md"), "Fixture turn: the record is closed tonight.\n");
  expect((await s.turn(turn("t2", { parent: "t1" }))).outcome.status).toBe("released");

  const briefing = textOf(s.model.requests[1]!.messages.at(-1)!);
  expect(briefing).toContain("@global/TURN.md was changed since this session opened.");
  expect(briefing).toContain("Fixture turn: the record is closed tonight.");
});

test("SWIPE.md is in a swipe's briefing and DELETE.md in the briefing after a delete", async () => {
  const s = (open = await stage({
    config: "stack:\n  added:\n    swipe: [SWIPE]\n    delete: [DELETE]\n",
    files: { ".agents/lead.md": LEAD, "SWIPE.md": "Fixture swipe: play the moment another way.\n", "DELETE.md": "Fixture delete: take the new message on its own terms.\n" },
    answers: [REPLY, REPLY, REPLY],
  }));
  expect((await s.turn(turn("t1"))).outcome.status).toBe("released");
  expect((await s.turn(turn("t1b", { kind: "swipe" }))).outcome.status).toBe("released");
  expect((await s.turn(turn("t2", { parent: "t1b", since: [{ kind: "delete", text: "The player deleted a message." }] }))).outcome.status).toBe("released");

  const briefings = s.model.requests.map((req) => textOf(req.messages.at(-1)!));
  expect(briefings.map((text) => [text.includes("Fixture swipe"), text.includes("Fixture delete")])).toEqual([
    [false, false],
    [true, false],
    [false, true],
  ]);
});
