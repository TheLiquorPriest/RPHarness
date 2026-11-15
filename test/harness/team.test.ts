// Sub-agents in a whole turn (§10.5, §13.4): the harness holds `delegate`, `ask_author` and
// `agent_message`; a lead delegates, its sub-agent asks, the lead answers, the sub-agent finishes,
// and the reply goes out; the user's limits on sub-agents come from the turn's settings; a call a
// limit left unfinished is answered in a file's words when the sub-agent goes on; and a stop ends
// every agent of the turn.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { SHIPPED_GUIDANCE } from "../../src/index";
import { gate, request, said, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CHIEF = "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [delegate, agent_message]\ngiven: [prompt:*]\n---\nFixture chief: you run the turn.\n";
const GM = "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: [ask_author]\n---\nFixture GM: rule on what you are asked.\n";
const FILES = { ".agents/chief.md": CHIEF, ".agents/gm.md": GM };

function lastResult(messages: readonly Message[]): string {
  const result = messages.filter((message) => message.role === "toolResult").at(-1);
  return result === undefined ? "" : textOf(result);
}

test("a lead delegates, its sub-agent asks, the lead answers, the sub-agent finishes, and the reply goes out", async () => {
  const s = (open = await stage({
    files: FILES,
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump to the far ledge." }, id: "d-1" }] },
      { pieces: [{ text: "Measuring." }, { call: "ask_author", args: { question: "How wide is the gap?", searched: "the scene notes" }, id: "a-1" }] },
      { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Twenty feet." }, id: "m-1" }] },
      { pieces: [{ text: "At twenty feet the jump fails." }] },
      { pieces: [{ text: "<reply>She falls short of the far ledge.</reply>" }] },
    ],
  }));

  const { outcome, sink } = await s.turn(request("t1", { lead: "chief" }));

  expect(outcome).toMatchObject({ status: "released", reply: "She falls short of the far ledge." });
  expect(sink.text).toBe("She falls short of the far ledge.");
  const requests = s.model.requests;
  expect(requests).toHaveLength(5);
  // The lead holds the two tools its definition lists; the sub-agent the one its own lists.
  expect(requests[0]!.tools.map((tool) => tool.name).sort()).toEqual(["agent_message", "delegate"]);
  expect(requests[1]!.tools.map((tool) => tool.name)).toEqual(["ask_author"]);
  expect(textOf(requests[1]!.messages.at(-1)!)).toContain("Rule on the jump to the far ledge.");
  // The question came back as the answer to delegate, marked as a question.
  expect(lastResult(requests[2]!.messages)).toContain("How wide is the gap?");
  expect(s.trace.of("tool_ended").find((record) => record.event.callId === "d-1")?.event.result.marks).toEqual(["question"]);
  // The lead's answer went on with the same agent, as its question's answer; what it said last came back to the lead.
  expect(requests[3]!.messages.slice(0, requests[1]!.messages.length)).toEqual(requests[1]!.messages);
  expect(lastResult(requests[3]!.messages)).toBe("Twenty feet.");
  expect(lastResult(requests[4]!.messages)).toContain("At twenty feet the jump fails.");
  const stretches = s.trace.records.filter((record) => record.agent.id === "gm-1" && (record.event.kind === "agent_started" || record.event.kind === "agent_ended"));
  expect(stretches.map((record) => [record.event.kind, record.event.kind === "agent_ended" ? record.event.status : record.parent?.call])).toEqual([
    ["agent_started", "d-1"],
    ["agent_ended", "asked"],
    ["agent_started", "m-1"],
    ["agent_ended", "done"],
  ]);
  expect(s.told.map((told) => told.kind)).toEqual(["released", "ended"]);
});

test("the turn's settings hold its sub-agents: with no depth allowed, delegate starts nobody, and the trace says which limit", async () => {
  const s = (open = await stage({
    config: "limits:\n  turn:\n    depth: 0\n",
    files: FILES,
    answers: [{ pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-1" }] }, { pieces: [{ text: "<reply>She waits at the edge.</reply>" }] }],
  }));

  const { outcome } = await s.turn(request("t1", { lead: "chief" }));

  expect(outcome.status).toBe("released");
  expect(s.model.requests).toHaveLength(2);
  expect(s.trace.of("limit").map((record) => record.event.hit)).toEqual([{ limit: "depth", per: "turn", max: 0, value: 1 }]);
  expect(s.trace.of("agent_started").map((record) => record.agent.definition)).toEqual(["chief"]);
  expect(lastResult(s.model.requests[1]!.messages)).not.toBe("");
});

test("a stop ends the lead and the sub-agent at work under it, and no further call is made", async () => {
  const more = gate();
  const s = (open = await stage({
    files: FILES,
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-1" }] },
      { pieces: [{ text: "Measuring" }, { hold: more }, { text: " the gap." }], ignoreAbort: true },
      { pieces: [{ text: "<reply>never</reply>" }] },
    ],
  }));
  const stop = new AbortController();

  const turn = s.turn(request("t1", { lead: "chief" }), undefined, stop.signal);
  await s.trace.seen((record) => record.agent.id === "gm-1" && record.event.kind === "call_started");
  stop.abort();
  const { outcome, sink } = await turn;
  const records = s.trace.records.length;
  more.open();
  await s.clock.idle();

  expect(outcome).toMatchObject({ status: "stopped", released: false });
  expect(s.trace.of("agent_ended").map((record) => [record.agent.definition, record.event.status]).sort()).toEqual([
    ["chief", "stopped"],
    ["gm", "stopped"],
  ]);
  expect(s.model.requests).toHaveLength(2);
  expect(s.trace.records).toHaveLength(records);
  expect(sink.errors).toEqual([{ code: "stopped" }]);
});

test("a sub-agent stopped at its time limit while a tool ran: when the lead's message sets it going again, that call is answered as unfinished, in a file's words", async () => {
  const never = gate();
  const s = (open = await stage({
    files: { ".agents/chief.md": CHIEF, ".agents/gm.md": "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: [world_query]\nlimits: { time: 5 }\n---\nFixture GM: rule on what you are asked.\n" },
    tools: { world_query: { tier: "read", description: "Fixture: a read that never comes back.", run: async () => (await never.opened, said("too late")) } },
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-1" }] },
      { pieces: [{ text: "Measuring." }, { call: "world_query", id: "q-1" }] },
      { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Go on without the reading." }, id: "m-1" }] },
      { pieces: [{ text: "Without the reading, the jump fails." }] },
      { pieces: [{ text: "<reply>She falls short of the far ledge.</reply>" }] },
    ],
  }));

  const turn = s.turn(request("t1", { lead: "chief" }));
  await s.trace.seen((record) => record.event.kind === "tool_started" && record.event.callId === "q-1");
  s.clock.advance(5_000);
  const { outcome } = await turn;
  never.open();

  expect(outcome.status).toBe("released");
  expect(s.trace.of("agent_ended").filter((record) => record.agent.id === "gm-1").map((record) => record.event.status)).toEqual(["limit", "done"]);
  // The sub-agent's second request: the call its limit cut short has an answer, and it is not the tool's late one.
  const unfinished = s.model.requests[3]!.messages.find((message) => message.role === "toolResult" && message.toolCallId === "q-1");
  expect(unfinished === undefined ? "" : textOf(unfinished)).not.toBe("");
  expect(unfinished === undefined ? "" : textOf(unfinished)).not.toContain("too late");
});

const SCRIBE = "---\nname: scribe\ndescription: Fixture lead that hands the reply to a writer.\nmodel: default\ntools: [write_reply, reply_release, agent_message]\ngiven: [prompt:*]\nwriter: narrator\n---\nFixture scribe: you run the turn.\n";
const NARRATOR = "---\nname: narrator\ndescription: Fixture writer.\nmodel: default\ntools: [delegate, ask_author]\n---\nFixture narrator: tell what you are briefed to tell.\n";

test("the writer stands in the team as a sub-agent does: what it starts is held to the depth the player allows, and its question comes back to the agent that called write_reply, which answers it", async () => {
  const s = (open = await stage({
    config: "limits:\n  turn:\n    depth: 1\n",
    files: { ...FILES, ".agents/scribe.md": SCRIBE, ".agents/narrator.md": NARRATOR },
    answers: [
      { pieces: [{ call: "write_reply", args: { brief: "Tell the leap and how it ends." }, id: "w-1" }] },
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-1" }, { call: "ask_author", args: { question: "Does she make the far ledge?", searched: "the brief" }, id: "a-1" }] },
      // The scribe answers the writer by the handle its question came back under.
      (req) => ({ pieces: [{ call: "agent_message", args: { agent: lastResult(req.messages).split(" ")[0]!, message: "She falls short." }, id: "m-1" }] }),
      { pieces: [{ text: "She falls short of the far ledge." }] },
      { pieces: [{ call: "reply_release", args: {}, id: "r-1" }] },
      { pieces: [{ text: "Done." }] },
    ],
  }));

  const { outcome, sink } = await s.turn(request("t1", { lead: "scribe" }));

  expect(outcome).toMatchObject({ status: "released", form: "narrator", reply: "She falls short of the far ledge." });
  expect(sink.text).toBe("She falls short of the far ledge.");
  // What the writer started would stand two deep, past the one the player allows.
  expect(s.trace.of("limit").map((record) => record.event.hit)).toEqual([{ limit: "depth", per: "turn", max: 1, value: 2 }]);
  expect(answerTo(s, "d-1")).toBe("gm was not started: it would stand 2 deep, and the player allows 1.");
  expect(s.trace.of("agent_started").map((record) => record.agent.definition)).toEqual(["scribe", "narrator", "narrator"]);
  // Its question came back as write_reply's answer, marked, and the scribe's message went on with it.
  expect(answerTo(s, "w-1")).toContain("Does she make the far ledge?");
  expect(s.trace.of("tool_ended").find((record) => record.event.callId === "w-1")?.event.result.marks).toEqual(["question"]);
  expect(answerTo(s, "m-1")).toContain("She falls short of the far ledge.");
});

/** The answer a call got, as the model read it in a later request. */
function answerTo(s: Stage, callId: string): string {
  for (const req of s.model.requests) {
    const found = req.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
    if (found !== undefined) return textOf(found);
  }
  return "";
}

/** A writer of the fixture's own: it tells what it is briefed to tell. */
const BARD = "---\nname: bard\ndescription: Fixture writer.\nmodel: default\ntools: []\n---\nFixture bard: tell what you are briefed to tell.\n";
/** `write_reply` described with a `writer:` header of its own, which decides nothing. */
const WRITE_REPLY_NAMING = "---\ndescription: Fixture write_reply, whose header names a writer.\nwriter: narrator\narguments:\n  brief: What the writer is to tell.\n  live: True to send the reply as it is written.\n---\nFixture: hands the telling of the reply to a writer.\n";

test("the caller's definition's writer: key decides who writes; a writer: header on .tools/write_reply.md decides nothing", async () => {
  const herald = "---\nname: herald\ndescription: Fixture lead whose definition names no writer.\nmodel: default\ntools: [write_reply]\ngiven: [prompt:*]\n---\nFixture herald: you run the turn.\n";
  const s = (open = await stage({
    files: { ".agents/scribe.md": SCRIBE.replace("writer: narrator", "writer: bard"), ".agents/herald.md": herald, ".agents/narrator.md": NARRATOR, ".agents/bard.md": BARD, ".tools/write_reply.md": WRITE_REPLY_NAMING },
    answers: [
      { pieces: [{ call: "write_reply", args: { brief: "Tell the leap.", live: true, closing: true }, id: "w-1" }] },
      { pieces: [{ text: "She clears the gap by a hand." }] },
      { pieces: [{ call: "write_reply", args: { brief: "Tell the leap." }, id: "w-2" }] },
      { pieces: [{ text: "<reply>She waits for the tide.</reply>" }] },
    ],
  }));

  const first = await s.turn(request("t1", { lead: "scribe" }));
  expect(first.outcome).toMatchObject({ status: "released", form: "narrator-live", reply: "She clears the gap by a hand." });
  // The writer the scribe's definition names wrote, not the one the tool's file names.
  expect(s.trace.of("agent_started").map((record) => record.agent.definition)).toEqual(["scribe", "bard"]);

  const second = await s.turn(request("t2", { lead: "herald" }));
  expect(second.outcome).toMatchObject({ status: "released", form: "tags", reply: "She waits for the tide." });
  // A caller whose definition names no writer has none, whatever the tool's file says.
  expect(s.trace.of("agent_started").map((record) => record.agent.definition)).toEqual(["scribe", "bard", "herald"]);
  expect(s.trace.of("tool_ended").find((record) => record.event.callId === "w-2")?.event.result.error).toBe(true);
});

test("a writer: naming a definition switched off: write_reply answers with the no_writer line, true for that case; nothing fails", async () => {
  const shipped = await Bun.file(join(SHIPPED_GUIDANCE, ".prompts", "tool-notices.md")).text();
  if (!/^no_writer: /m.test(shipped)) throw new Error("RPH's own tool notices have no no_writer line.");
  // The line worded true for each case, as the file's own words will be.
  const notices = shipped.replace(/^no_writer: .*$/m, "no_writer: {{#off}}{{writer}}, the writer your definition names, is switched off; it cannot write the reply.{{/off}}{{^off}}There is no agent definition named {{writer}} to write the reply.{{/off}}");
  const s = (open = await stage({
    config: "off: [agents/bard]\n",
    files: { ".agents/scribe.md": SCRIBE.replace("writer: narrator", "writer: bard"), ".agents/bard.md": BARD, ".prompts/tool-notices.md": notices },
    answers: [{ pieces: [{ call: "write_reply", args: { brief: "Tell the leap." }, id: "w-1" }] }, { pieces: [{ text: "<reply>She waits for the tide.</reply>" }] }],
  }));

  const { outcome } = await s.turn(request("t1", { lead: "scribe" }));

  expect(outcome).toMatchObject({ status: "released", form: "tags", reply: "She waits for the tide." });
  expect(answerTo(s, "w-1")).toBe("bard, the writer your definition names, is switched off; it cannot write the reply.");
  expect(s.trace.of("agent_started").map((record) => record.agent.definition)).toEqual(["scribe"]);
  expect(s.logged.filter((line) => line.level === "error")).toEqual([]);
});

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of records.\nmodel: default\ntools: [file_write]\n---\nFixture keeper: keep the lighthouse log.\n";
const WARDEN = "---\nname: warden\ndescription: Fixture lead that can drop what its sub-agents wrote.\nmodel: default\ntools: [delegate, agent_drop]\ngiven: [prompt:*]\n---\nFixture warden: you run the turn.\n";

test("the agent that started a sub-agent drops what it wrote: the host is told, the writes are gone, and the call is answered in the file's words", async () => {
  const s = (open = await stage({
    files: { ".agents/keeper.md": KEEPER, ".agents/warden.md": WARDEN },
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "keeper", brief: "Log the storm." }, id: "d-1" }] },
      { pieces: [{ call: "file_write", args: { path: "persistent-workspace/log.md", op: "write", text: "The storm broke at nine.\n" } }] },
      { pieces: [{ text: "Logged." }] },
      { pieces: [{ call: "agent_drop", args: { agent: "keeper-1" }, id: "x-1" }, { call: "agent_drop", args: { agent: "keeper-9" }, id: "x-2" }] },
      { pieces: [{ text: "<reply>The log stays blank.</reply>" }] },
    ],
  }));

  const { outcome } = await s.turn(request("t1", { lead: "warden" }));

  expect(outcome.status).toBe("released");
  expect(s.told.filter((told) => told.kind === "dropStaged").map((told) => told.payload)).toEqual([{ id: "keeper-1", definition: "keeper", parent: expect.any(String) }]);
  expect(await s.env.files.read(request("t1").scope, "persistent-workspace/log.md")).toMatchObject({ status: "missing" });
  expect(answerTo(s, "x-1")).toBe("What keeper-1 wrote this turn was dropped.");
  expect(answerTo(s, "x-2")).toBe("No agent you started this turn goes by keeper-9.");
});
