// Nothing in code holds a step of a turn (§3.4, §6.8, §10.3, §10.9): the intent record is kept and
// shown, never waited for, so a host that takes it slowly delays no tool and no reply; no reply tool
// refuses in the call before a compaction; RPH words nothing about pictures, and where a request
// cannot carry one it tells the host; and a request that carries no prompt leaves the prompt's
// record as it was. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, PromptMessage, TurnEvents } from "../../src/contract";
import { SHIPPED_GUIDANCE } from "../../src/helpers";
import { textHash } from "../../src/prompt/text";
import { play, played, S1, SAVE, SAVE_RULE, said, TIDE, turn } from "../sessions/support";
import { CHAT, gate, PROMPT, request, type Stage, stage, USER, WatchedSink } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** The host, its taking of each intent record held until `taken` opens. */
function slowHost(taken: Promise<void>): (inner: TurnEvents) => TurnEvents {
  return (inner) => ({
    ...inner,
    intent: async (scope, text) => {
      await taken;
      return inner.intent(scope, text);
    },
  });
}

test("a host that takes the intent record slowly does not delay the first tool call or the reply's first piece", async () => {
  const taken = gate();
  const s = (open = await stage({
    events: slowHost(taken.opened),
    answers: [
      { pieces: [{ text: "<intent>Wants: the tide table.</intent>" }, { call: "todo", args: { items: [{ text: "read the tide", done: false }] } }] },
      { pieces: [{ text: "<reply>High water at nine.</reply>" }] },
    ],
  }));
  const sink = new WatchedSink(s.clock);

  const playing = s.turn(request("t1", { lead: "lead" }), sink);
  // The tool ran and the reply reached the player, the host still holding the record.
  await s.trace.seen((record) => record.event.kind === "todo");
  await sink.until(() => sink.finished.length > 0);
  expect(taken.isOpen).toBe(false);
  expect(sink.text).toBe("High water at nine.");
  expect(s.trace.of("released")).toHaveLength(1);
  taken.open();

  expect((await playing).outcome).toMatchObject({ status: "released", reply: "High water at nine." });
  expect(s.told.map((told) => told.kind)).toEqual(["intent", "released", "ended"]);
});

test("the intent event comes before the first tool_started event in the trace", async () => {
  const taken = gate();
  const s = (open = await stage({
    events: slowHost(taken.opened),
    answers: [{ pieces: [{ text: "<intent>Wants: the tide table.</intent>" }, { call: "todo", args: { items: [{ text: "read the tide", done: false }] } }, { text: "<reply>High water at nine.</reply>" }] }, { pieces: [{ text: "Done." }] }],
  }));

  const playing = s.turn(request("t1", { lead: "lead" }));
  await s.trace.seen((record) => record.event.kind === "tool_started");
  const kinds = s.trace.records.map((record) => record.event.kind);
  expect(kinds.indexOf("intent")).toBeGreaterThanOrEqual(0);
  expect(kinds.indexOf("intent")).toBeLessThan(kinds.indexOf("tool_started"));
  taken.open();
  expect((await playing).outcome.status).toBe("released");
});

test("a reply released in the save-before-compaction call is released once, and the turn goes on", async () => {
  const s = (open = await stage({
    config: "compaction:\n  keepTurns: 2\n",
    files: { [SAVE_RULE]: SAVE, [TIDE]: "High water at nine.\n" },
    answers: [
      played(1),
      played(2),
      played(3),
      // The call before compaction releases a finished file.
      { pieces: [{ call: "reply_release", args: { path: "persistent-workspace/tide.md" } }] },
      said("Fixture summary."),
      // The turn's own work, after the compaction: its reply in tags is a second one, answered by the file's line, once.
      played(4),
      said("Fixture: the reply went out already."),
    ],
  }));
  await play(s, ["t1", "t2", "t3"]);
  await s.harness.sessions!.compact(S1);

  const { outcome, sink } = await s.turn(turn("t4", { parent: "t3" }));

  expect(outcome).toMatchObject({ status: "released", form: "file", reply: "High water at nine.\n" });
  expect(sink.text).toBe("High water at nine.\n");
  expect(sink.finished).toHaveLength(1);
  const t4 = s.trace.records.filter((record) => record.scope.turn === "t4");
  const kinds = t4.map((record) => record.event.kind);
  expect(kinds.filter((kind) => kind === "released")).toHaveLength(1);
  expect(s.told.filter((told) => told.kind === "released" && told.scope.turn === "t4")).toHaveLength(1);
  // Released before the compaction, and the turn's own work made its calls after it.
  expect(kinds.indexOf("released")).toBeLessThan(kinds.indexOf("compacted"));
  expect(kinds.indexOf("compacted")).toBeLessThan(kinds.lastIndexOf("call_started"));
  expect(s.model.requests).toHaveLength(3 + 4);
});

/** Every line of RPH's shipped guidance, with its file. */
async function shippedLines(): Promise<{ file: string; line: string }[]> {
  const out: { file: string; line: string }[] = [];
  for (const file of await readdir(SHIPPED_GUIDANCE, { recursive: true })) {
    const text = await readFile(join(SHIPPED_GUIDANCE, file), "utf8").catch(() => undefined);
    if (text !== undefined) for (const line of text.split("\n")) out.push({ file, line });
  }
  return out;
}

test("a picture in a system message on the folder host: the request carries none, the trace's prompt_notices names the message and the count, and RPH's shipped guidance holds no line about pictures", async () => {
  const picture = { type: "image" as const, data: "Zml4dHVyZQ==", mimeType: "image/png" };
  const prompt: PromptMessage[] = [{ role: "system", content: [{ type: "text", text: "Fixture preset: write in the second person." }, picture] }, ...PROMPT.slice(1, -1), { role: "user", content: [{ type: "text", text: "I show Wren the map." }, picture] }];
  const s = (open = await stage({ answers: [{ pieces: [{ text: "<reply>Wren studies the map.</reply>" }] }] }));

  const { outcome } = await s.turn(request("t1", { lead: "lead", prompt }));

  expect(outcome.status).toBe("released");
  const sent = s.model.requests[0]!.messages;
  // The user's picture goes as it came; the system message's has no place to go.
  const pictures = sent.flatMap((message, at) => (typeof message.content === "string" ? [] : message.content.flatMap((part) => (part.type === "image" ? [{ at, role: message.role }] : []))));
  expect(pictures).toEqual([{ at: expect.any(Number), role: "user" }]);
  expect(sent.some((message) => message.role === "system" && JSON.stringify(message.content).includes("Zml4dHVyZQ=="))).toBe(false);
  expect(s.trace.of("prompt_notices").flatMap((record) => record.event.pictures ?? [])).toEqual([{ message: 0, count: 1 }]);
  // Nothing about the picture reaches the agent from RPH: no word of pictures in what it was sent.
  expect(sent.some((message) => /pictur/i.test(JSON.stringify(message.content)))).toBe(false);
  // RPH's own files say nothing of a picture left out: a line that names pictures only counts them. A file's `description:` header is for the person who reads the page, not sent to an agent.
  const named = (await shippedLines()).filter(({ line }) => /pictur|image/i.test(line) && !line.startsWith("description:"));
  expect(named.filter(({ line }) => /left|leav|drop|omit|remov|strip|cannot|can't|could not|carr|unable|not (?:be )?(?:sent|shown)/i.test(line))).toEqual([]);
});

/** Where the folder host keeps the located slices of a turn of the stage's chat. */
function locatedFile(s: Stage, turnId: string): string {
  return join(s.dir, "host", "chats", CHAT, "turns", turnId, "located.json");
}

/** What the chat's newest turns' prompts held, as RPH keeps it in the host's store under the chat, by the key its prompt memory gives. */
async function promptRecords(s: Stage): Promise<JsonValue | undefined> {
  const scope = request("t1").scope;
  return s.env.store.get(scope, `prompt/turns/${textHash(`${USER}\n${CHAT}`)}`);
}

test("a continue with an empty prompt leaves the turn's located slices, and the next turn's comparison, as they were", async () => {
  const s = (open = await stage({
    answers: [{ pieces: [{ text: "<reply>No boat tonight.</reply>" }] }, { pieces: [{ text: "Fixture: the records agree with the reply." }] }, { pieces: [{ text: "<reply>Dawn comes grey.</reply>" }] }],
  }));
  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  const located = await readFile(locatedFile(s, "t1"), "utf8");
  const records = await promptRecords(s);
  expect(records).toBeDefined();
  // A run of the same turn with no prompt, as a host asks one to settle the turn's records: straight to the harness, the host's record of what it was given left alone.
  const noticed = s.trace.of("prompt_notices").length;
  const settle = await s.harness.answer(request("t1", { lead: "lead", kind: "continue", prompt: [], owesReply: false }), new WatchedSink(s.clock), new AbortController().signal);
  expect(settle).toMatchObject({ status: "no-reply", released: false });
  expect(await readFile(locatedFile(s, "t1"), "utf8")).toBe(located);
  expect(await promptRecords(s)).toEqual(records);
  expect(s.trace.of("prompt_notices")).toHaveLength(noticed);

  // The next turn is compared with the turn's prompt as it was: the same prompt, so its whole front held.
  expect((await s.turn(request("t2", { lead: "lead", parent: "t1" }))).outcome.status).toBe("released");
  const next = JSON.parse(await readFile(locatedFile(s, "t2"), "utf8")) as { front: { length: number; brokenBy?: string } };
  const whole = PROMPT.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);
  expect(next.front).toEqual({ length: whole });
});
