// The words of RPH's own shipped parts and tool guides that the texts lane worded for the wave's code
// (PlanTexts-4): a refused write says where notes go; `write_reply` with no writer says why, in each of
// its three cases; `second_reply` is true in both forms of a reply; a line the code no longer asks for is
// gone; the sign-in line, the tools offered as text, what the player said to an agent at work, a search
// that stopped, and the job tools' lines and guides are each there, plain and asking for nothing; and no
// header of RPH's own parts or tools holds a field nothing reads. Each row is the shipped file's own
// line, rendered as the harness renders it. Every name is invented.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { LinesPart, TemplatePart } from "../../src/files/api";
import { SHIPPED_GUIDANCE } from "../../src/harness/shipped";
import { shippedParts, shippedTool } from "./support";

async function lines(): Promise<LinesPart> {
  const part = await shippedParts().part("tool-notices");
  if (part?.format !== "lines") throw new Error("tool-notices is not a lines part");
  return part;
}

const WRITABLE = ["persistent-workspace/", "sessions/s-1/turns/t-1/scratch/", "sessions/s-1/turns/t-1/output/"];

test("each refused line says where notes go, naming the notes folder, and names no path of its own or any the player owns", async () => {
  const part = await lines();
  for (const reason of ["yours", "generated", "mounted", "outside", "link", "invalid"]) {
    const name = `refused_${reason}`;
    const template = part.lines.get(name);
    expect({ name, fields: template?.fields.filter((field) => field !== "path" && field !== "writable") }).toEqual({ name, fields: [] });
    const said = part.line(name, { path: "plan.md", writable: WRITABLE }) ?? "";
    expect({ name, notes: said.includes("persistent-workspace/"), mentioned: said.includes("Notes go in") }).toEqual({ name, notes: true, mentioned: true });
    // A path that is not there is not called the player's own.
    expect(said).not.toContain("player's own");
  }
});

test("no_writer is true in each of its three cases: no writer named, a writer no definition has, a writer whose definition is switched off", async () => {
  const part = await lines();
  expect(part.line("no_writer", {})).toBe("No reply was written: your definition names no agent to write it.");
  expect(part.line("no_writer", { writer: "narrator", missing: true })).toBe("No reply was written: narrator, the agent your definition names to write it, has no definition.");
  expect(part.line("no_writer", { writer: "narrator", off: true })).toBe("No reply was written: narrator, the agent your definition names to write it, is switched off.");
  // A definition that does not load is its own case, and any other left-out part is said plainly rather than not at all.
  expect(part.line("no_writer", { writer: "narrator", broken: true })).toContain("does not load");
  expect(part.line("no_writer", { writer: "narrator" })).toContain("cannot be used");
});

test("a writer stopped with too little left under a limit for an answer is told what was left, the least room, and that its call was not made", async () => {
  const hit = { limit: "tokens", is: { tokens: true }, per: "job", max: 300, value: 279, floor: 256, left: 21 };
  expect((await lines()).line("not_written_floor", { writer: "narrator", limit: true, hit })).toBe(
    "narrator gave no reply: of its limit of 300 on tokens per job, 21 was left once its next call's prompt was counted, less than the least room an answer is given (256 tokens), so its call was not made.",
  );
});

test("second_reply is true of the tags' form and of the two-step form: it names neither", async () => {
  const said = (await lines()).line("second_reply", {}) ?? "";
  expect(said).toBe("The reply for this turn has already gone out. Nothing more goes to the chat.");
  expect(said).not.toMatch(/tag|file|draft|<|two-step/i);
});

test("a line the code no longer asks for is gone: not_now", async () => {
  expect((await lines()).lines.has("not_now")).toBe(false);
});

test("the lines this lane words say what is so and ask for nothing", async () => {
  const part = await lines();
  const worded = ["refused_yours", "refused_generated", "refused_mounted", "refused_outside", "refused_link", "refused_invalid", "no_writer", "second_reply"];
  for (const name of worded) {
    const said = part.line(name, { path: "plan.md", writable: WRITABLE, writer: "narrator", off: true }) ?? "";
    expect({ name, said: said.length > 0, unfilled: said.includes("{{"), asks: /\b(must|should|always|please)\b/i.test(said) }).toEqual({ name, said: true, unfilled: false, asks: false });
  }
});

/** The header fields of a part or a tool file that something reads: its description and format, a tool's arguments and what it is doing for a person, and the fields code reads of one part by name. */
const READ: Record<string, true> = { description: true, format: true, arguments: true, doing: true, yes: true, record: true, views: true, tags: true, intent_file: true };

function headerOf(text: string): Record<string, unknown> {
  if (!text.startsWith("---\n")) return {};
  return Bun.YAML.parse(text.slice(4, text.indexOf("\n---\n", 4))) as Record<string, unknown>;
}

test("no header of RPH's own parts or tools holds a field nothing reads, and write_reply names no writer", () => {
  const unread: string[] = [];
  for (const folder of [".prompts", ".tools"]) {
    for (const file of readdirSync(join(SHIPPED_GUIDANCE, folder))) {
      const text = readFileSync(join(SHIPPED_GUIDANCE, folder, file), "utf8");
      for (const field of Object.keys(headerOf(text))) if (READ[field] !== true && !text.includes(`{{${field}`) && !text.includes(`{{#${field}`)) unread.push(`${folder}/${file}: ${field}`);
    }
  }
  expect(unread).toEqual([]);
  expect(Object.keys(headerOf(readFileSync(join(SHIPPED_GUIDANCE, ".tools", "write_reply.md"), "utf8")))).toEqual(["description", "doing", "arguments"]);
});

test("RPH ships no agent definition: its own layer is parts, rules and tools, and a host's folder holds its lead", () => {
  expect(existsSync(join(SHIPPED_GUIDANCE, ".agents"))).toBe(false);
});

/** Words that ask an agent to do something of its turn: a line that says what is so holds none of them. */
const ASKS = /\b(must|should|always|never|please|make sure|remember to)\b/i;

async function template(name: string): Promise<TemplatePart> {
  const part = await shippedParts().part(name);
  if (part?.format !== "template") throw new Error(`${name} is not a template`);
  return part;
}

test("the sign-in line is the one line Anthropic requires at the head of a sign-in's call, with a description beside it", async () => {
  const part = await template("signin-line");
  expect(part.render().text.trim()).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  expect(typeof part.header["description"]).toBe("string");
});

test("the mark of a system message sent in place, the mark of a message whose role no API places, and the text of a connection's test are there, each with a description beside it", async () => {
  expect((await template("system-note")).render({ text: "The tide turns." }).text.trimEnd()).toBe("System note:\nThe tide turns.");
  expect((await template("role-note")).render({ role: "tool", text: "The tide turns." }).text.trimEnd()).toBe('Message with the role "tool":\nThe tide turns.');
  expect((await template("connection-test")).render().text.trim()).toBe("Reply with one word: ready.");
  for (const name of ["system-note", "role-note", "connection-test"]) expect({ name, described: typeof (await template(name)).header["description"] }).toEqual({ name, described: "string" });
});

test("tools offered as text: the way to call one, each tool with what it takes, a later change, one of its own calls and what its calls answered", async () => {
  const part = await template("tools-as-text");
  const lookup = { name: "lookup", description: "Looks a thing up.", parameters: '{"type":"object"}' };
  const note = { name: "note", description: "Keeps a note.", parameters: '{"type":"object"}' };
  const offered = part.render({ offered: { tools: [lookup, note] } }).text;
  expect(offered).toContain('<tool_call>{"name": "the tool\'s name", "arguments": {"an argument": "its value"}}</tool_call>');
  expect(offered).toContain("lookup: Looks a thing up.\nArguments (JSON Schema): {\"type\":\"object\"}");
  expect(offered).toContain("note: Keeps a note.");
  expect(offered).toContain("A message with no block calls nothing.");
  expect(part.render({ added: { tools: [note] } }).text).toContain("From here on you can also use these tools, called the same way:\n\nnote: Keeps a note.");
  expect(part.render({ removed: { names: ["lookup", "note"] } }).text).toBe("From here on these tools can no longer be used: lookup, note.\n");
  expect(part.render({ call: { json: '{"name":"lookup","arguments":{"what":"the bell"}}' } }).text.trim()).toBe('<tool_call>{"name":"lookup","arguments":{"what":"the bell"}}</tool_call>');
  const answered = part.render({ answers: { results: [{ name: "lookup", text: "High water at six." }, { name: "note", text: "No such note.", error: true }] } }).text;
  expect(answered).toContain('<tool_result name="lookup">\nHigh water at six.\n</tool_result>');
  expect(answered).toContain('<tool_result name="note" error="true">\nNo such note.\n</tool_result>');
  for (const text of [offered, answered]) expect({ unfilled: text.includes("{{"), asks: ASKS.test(text) }).toEqual({ unfilled: false, asks: false });
});

test("what the player said to an agent at work is told as his; an answer of nothing, or of pictures alone, says so", async () => {
  const part = await lines();
  expect(part.line("said", { words: "Keep it short." })).toBe("The player said to you while you were at work: Keep it short.");
  expect(part.line("empty_answer", { tool: "lookup" })).toBe("lookup answered with nothing.");
  expect(part.line("pictures_answer", { tool: "lookup" })).toBe("lookup answered with these pictures alone.");
});

test("a tool of the player's own that ran out of time, answered too much or not JSON, failed by its code or its address's status, or sends a secret that is not set says so", async () => {
  const part = await lines();
  expect(part.line("timed_out", { tool: "tides", seconds: 30 })).toBe("tides did not answer within 30 seconds, so it was stopped. It may have done its work, or not.");
  expect(part.line("answer_cut", { tool: "tides", bytes: 65536 })).toBe("tides answered with more than 65536 bytes, the most that is read, so its answer was not read.");
  expect(part.line("not_json", { tool: "tides", said: "<html>" })).toBe("tides answered with something that is not JSON: <html>");
  expect(part.line("command_exit", { tool: "tides", code: 2, said: "no such file" })).toBe("tides failed: its command ended with code 2. It said: no such file");
  expect(part.line("http_status", { tool: "tides", status: 503 })).toBe("tides failed: its address answered 503.");
  expect(part.line("secret_unset", { tool: "tides", secret: "tides-key", header: "Authorization" })).toBe("tides was not run: the secret tides-key it sends as Authorization is not set. The player sets it on the Connections page.");
  expect(part.line("server_failed", { tool: "tides_now", server: "tides" })).toBe("tides_now was not run: its server tides could not be started or reached.");
  expect(part.line("server_stopped", { tool: "tides_now", server: "tides" })).toBe("tides_now did not finish: its server tides stopped during the call. It is started again at the next call.");
});

test("a tool that needs a chat, called in a job that belongs to none, says it did nothing and why", async () => {
  const part = await lines();
  expect(part.line("no_chat", { tool: "chat_read" })).toBe("chat_read did nothing: this job belongs to no chat, so there is no chat for it to read or write.");
});

test("a call a spent limit kept from starting says it did not run, apart from one stopped part-way; the two notes beside a tool's own answer say what could not be done and that the answer stands", async () => {
  const part = await lines();
  const never = part.line("not_started", { tool: "file_write" }) ?? "";
  expect(never).toBe("file_write did not run: a limit was already spent when it was called, so it never started.");
  expect(never).not.toMatch(/may have done|work/i);
  expect(part.line("unfinished", { tool: "file_write" })).toContain("It may have done its work, or not.");
  expect(part.line("rule_unasked", { tool: "lookup" })).toBe("A rule on what lookup answered could not be asked. The answer stands as it is.");
  expect(part.line("not_kept", { tool: "lookup" })).toBe("The whole of lookup's answer could not be kept, so no file holds what was left out.");
  // "never started" is the fact itself, so the check is for words that ask.
  for (const name of ["not_started", "rule_unasked", "not_kept"]) expect({ name, asks: /\b(must|should|please|make sure|remember to)\b/i.test(part.line(name, { tool: "lookup" }) ?? ""), unfilled: (part.line(name, { tool: "lookup" }) ?? "").includes("{{") }).toEqual({ name, asks: false, unfilled: false });
});

test("a call past an answer's count and a message past a sub-agent's count each say the count, that the call or the agent was not run, and ask for nothing", async () => {
  const part = await lines();
  const call = part.line("past_answer_count", { tool: "file_write", max: 3 }) ?? "";
  expect(call).toBe("file_write was not run: the count of tool calls in one answer is 3, and this call is past it.");
  const message = part.line("past_message_count", { agent: "mapper", max: 1 }) ?? "";
  expect(message).toBe("mapper was not run: the count of messages it is sent after its first answer is 1, and this one is past it.");
  for (const text of [call, message]) expect({ unfilled: text.includes("{{"), asks: /\b(must|should|please|make sure|remember to)\b/i.test(text) }).toEqual({ unfilled: false, asks: false });
});

test("a search that stopped says how it stopped, with its numbers, and how that kind of search is narrowed", async () => {
  const part = await lines();
  const by = { list: { list: true }, glob: { glob: true }, grep: { grep: true } };
  for (const [kind, flag] of Object.entries(by)) {
    const limit = part.line("stopped_limit", { ...flag, max: 200 }) ?? "";
    expect({ kind, said: limit.includes("200 results"), narrows: /path|glob|pattern/.test(limit) }).toEqual({ kind, said: true, narrows: true });
  }
  expect(part.line("stopped_limit", { list: true, max: 200 })).not.toMatch(/pattern/);
  expect(part.line("stopped_limit", { grep: true, max: 200 })).toContain("a closer pattern");
  expect(part.line("stopped_large", { files: 3, bytes: 1048576 })).toContain("3 files over 1048576 bytes were not searched");
  expect(part.line("stopped_cut", { lines: 4, chars: 400 })).toContain("4 of these lines were cut to 400 characters");
  expect(part.line("stopped_time", { grep: true, ms: 5000 })).toContain("after 5000 milliseconds");
  for (const name of ["stopped_limit", "stopped_large", "stopped_cut", "stopped_time"]) expect({ name, unfilled: (part.line(name, { grep: true, max: 1, files: 1, bytes: 1, lines: 1, chars: 1, ms: 1 }) ?? "").includes("{{") }).toEqual({ name, unfilled: false });
});

test("a write's answer says what the file now reads: its text after a write or an append, the lines an edit changed with their numbers, or where lines were taken out", async () => {
  const part = await lines();
  expect(part.line("now_text", { path: "notes/plan.md", lines: 3 })).toBe("notes/plan.md now reads (3 lines):");
  expect(part.line("now_stretch", { path: "notes/plan.md", from: 2, to: 3 })).toBe("Lines 2 to 3 of notes/plan.md now read:");
  expect(part.line("now_line", { line: 2, text: "Rope: one coil." })).toBe("2: Rope: one coil.");
  expect(part.line("now_removed", { path: "notes/plan.md", lines: 2, at: 3 })).toBe("The lines were taken out of notes/plan.md. It now has 2 lines; the cut is at line 3.");
  expect((await shippedTool("file_write")).description).toContain("shows what the file now says");
});

test("each line of the job tools is there, in plain words that say what became of the call and ask for nothing", async () => {
  const part = (await shippedParts().part("jobs")) as LinesPart | undefined;
  if (part?.format !== "lines") throw new Error("jobs is not a lines part");
  const rows: [string, Record<string, string | number | boolean>, string][] = [
    ["started", { job: "j-1", agent: "mapper" }, "Job j-1 was started: mapper works on it in the background."],
    ["started", { job: "j-1", agent: "mapper", queued: true }, "Job j-1 was started: mapper works on it in the background once a place is free."],
    ["missing", { agent: "mapper", ref: "file:plan.md" }, "mapper was not given file:plan.md: it could not be found."],
    ["day_limit", { value: 6, max: 6 }, "No job was started: 6 jobs were started in the last day, and 6 is the most allowed."],
    ["day_limit", { value: 3, max: 3, connection: "Main" }, "No job was started: 3 jobs were started in the last day on Main, and 3 is the most allowed."],
    ["run_limit", { value: 2, max: 2 }, "No job was started: this turn has started 2 jobs, and 2 is the most allowed."],
    ["run_limit", { value: 1, max: 1, job: true }, "No job was started: this job has started 1 jobs, and 1 is the most allowed."],
    ["day_tokens", { value: 900, max: 800 }, "No job was started: what jobs sent and wrote in the last day counts as 900 tokens, and 800 is the most allowed."],
    ["off", { agent: "mapper" }, "No job was started: the player has switched jobs off."],
    ["no_task", {}, "No job was started: it needs an agent and a task, or the job to start again."],
    ["no_job", { id: "j-9" }, "There is no job j-9 in this chat."],
    ["not_again", { id: "j-2", state: "running" }, "Job j-2 is running: only a job that was interrupted, failed or cancelled can be started again."],
    ["none", {}, "No job has been started in this chat."],
    ["listed", { id: "j-1", agent: "mapper", state: "done", brief: "Map the harbour." }, "j-1: mapper, done. Map the harbour."],
    ["listed", { id: "j-3", agent: "mapper", state: "queued", repeats: "j-1", brief: "Map the harbour." }, "j-3: mapper, queued, started again from j-1. Map the harbour."],
    ["more", { count: 20 }, "20 are listed; older jobs are left out."],
    ["read", { id: "j-1", agent: "mapper", state: "failed", limit: "tokensOut" }, "Job j-1: mapper, failed, stopped at its limit on tokensOut."],
    ["brief", { brief: "Map the harbour." }, "Task: Map the harbour."],
    ["report", { report: "Two quays." }, "Report: Two quays."],
    ["no_report", {}, "It has no report."],
    ["cancelled", { id: "j-1" }, "Job j-1 was stopped."],
    ["cancel_ended", { id: "j-1", state: "done" }, "Job j-1 had ended already: it is done."],
    ["not_yours", { id: "j-4" }, "Job j-4 was started by the player, and the player stops it."],
    ["carried_on", { limit: "calls", calls: 10, time: 300 }, "You stopped at your limit on calls, and you have been given more. Calls: 10 more. Time: 300 more seconds. Go on from where you stood."],
    ["resumed", {}, "Your work was cut off by a restart, and the player has resumed it. Go on from your last call. A call you were told did not finish may have done its work or not: check before you do it again."],
  ];
  for (const [name, fields, said] of rows) expect({ name, said: part.line(name, fields) }).toEqual({ name, said });
  for (const name of part.names) expect({ name, asks: ASKS.test(part.line(name, { agent: "mapper", id: "j-1", state: "done", brief: "x", report: "x", ref: "x", job: "j-1", value: 1, max: 1, count: 1 }) ?? "") }).toEqual({ name, asks: false });
  expect([...part.names].sort()).toEqual([...new Set(rows.map(([name]) => name))].sort());
});

test("the job tools' guides say what each does, and name the arguments each takes", async () => {
  const guides: [string, string[]][] = [["job_start", ["agent", "brief", "attach", "plays", "returns", "repeats"]], ["job_list", []], ["job_read", ["job"]], ["job_cancel", ["job"]]];
  for (const [name, args] of guides) {
    const guide = await shippedTool(name);
    expect({ name, said: guide.description.length > 0, arguments: Object.keys(guide.arguments) }).toEqual({ name, said: true, arguments: args });
    expect({ name, asks: ASKS.test(guide.description) }).toEqual({ name, asks: false });
  }
  expect((await shippedTool("job_list")).description).toContain("job_read");
  expect((await shippedTool("job_cancel")).description).toContain("the player's to stop");
});

test("a tool no longer offered and arguments that are not JSON are each told as what is so, and arguments that are not JSON are not blamed on a field", async () => {
  const part = await lines();
  expect(part.line("withdrawn", { tool: "world_query" })).toBe("world_query was not run: it is not offered any more. It was among your tools when this session began.");
  expect(part.line("invalid", { tool: "world_query", arguments: '{"id": ', unparsed: true, parameters: '{"type":"object"}' })).toBe('world_query was not run: the arguments you sent are not JSON, so none could be read. It takes {"type":"object"}. What was sent: {"id": ');
  expect(part.line("invalid", { tool: "world_query", arguments: '{"id": 4}', misfits: [{ argument: "id", missing: false }] })).toBe("world_query was not run: the arguments you sent do not fit what it takes. id does not fit.");
  for (const said of [part.line("withdrawn", { tool: "x" }) ?? "", part.line("invalid", { tool: "x", arguments: "{", unparsed: true }) ?? ""]) expect({ said, asks: ASKS.test(said), unfilled: said.includes("{{") }).toEqual({ said, asks: false, unfilled: false });
});

test("each family of RPH's tools that has no tool of its own name has a guide, and no description of RPH's says when to use its tool", async () => {
  const families = ["agents", "jobs", "chat", "continuity", "lore", "skills", "suggestions", "stores", "web", "files", "reply", "tools"];
  for (const family of families) {
    const guide = await shippedTool(family);
    expect({ family, said: guide.description.length > 0, asks: ASKS.test(guide.description) }).toEqual({ family, said: true, asks: false });
  }
  const tools = readdirSync(join(SHIPPED_GUIDANCE, ".tools")).map((file) => file.replace(/\.md$/, "")).filter((name) => !families.includes(name));
  for (const name of tools) {
    const said = (await shippedTool(name)).description;
    expect({ name, says: /needs no (tool|release)|No read is needed|are found with tool_search/.test(said) }).toEqual({ name, says: false });
  }
  expect((await shippedTool("archive_search")).description).toContain("earlier sessions");
  expect(await lines()).toBeDefined();
  expect((await lines()).line("invalid", { tool: "world_query", misfits: [{ argument: "kind", missing: false, choices: "places, quests" }] })).toBe("world_query was not run: the arguments you sent do not fit what it takes. kind does not fit; it takes one of places, quests.");
});

test("carried lays out an agent's own older work in its run: for a summary call, and as the summary that stands in its place; the turns it carries between turns are laid out as they were", async () => {
  const part = await shippedParts().part("carried");
  if (part?.format !== "template") throw new Error("carried is not a template");
  const work = [{ items: [{ said: "I will look." }, { call: { tool: "roll", args: "{}", result: "A six." } }, { heard: "The player says: wait." }] }];
  const compacting = part.render({ run: true, compacting: true, summary: "Earlier, in short.", turns: work as never }).text;
  expect(compacting.startsWith("# This agent's earlier work in this run, to be summarized\n")).toBe(true);
  for (const said of ["## The summary so far, which these turns follow", "Earlier, in short.", "The agent wrote:\n\nI will look.", "The agent called `roll` with {}.", "The agent was told:\n\nThe player says: wait."]) expect(compacting).toContain(said);
  expect(compacting).not.toMatch(/## Turn|The lead called|You /);
  const held = part.render({ run: true, summary: "In short.", turns: [{ items: [{ said: "Then I wrote." }, { heard: "A file changed." }] }] }).text;
  expect(held).toBe("# Your earlier work in this run, in short\n\nIn short.\n\nYou wrote:\n\nThen I wrote.\n\nYou were told:\n\nA file changed.\n");
  const turns = part.render({ continuing: true, summary: "Before.", turns: [{ n: 1, items: [{ intent: "One." }, { call: { tool: "roll", args: "{}", result: "A two." } }] }] }).text;
  expect(turns).toBe("# Carried from earlier in this scene\n\nWhat you did in this scene's earlier turns, oldest first. This is your own work, already done, and what it read and found still stands. It is not part of the chat.\n\n## Before that, in short\n\nBefore.\n\n## Turn 1\n\nYour intent record:\n\nOne.\n\nYou called `roll` with {}.\nIt answered:\n\nA two.\n");
  const lead = part.render({ compacting: true, turns: [{ n: 1, items: [{ call: { tool: "roll", args: "{}" } }] }] }).text;
  expect(lead).toContain("The lead called `roll`");
});

test("the prompt's shape notices are worded in the notices part and no longer in the map's, and a summary the chat application put in place of messages is told as one", async () => {
  const notices = await shippedParts().part("notices");
  const map = await shippedParts().part("prompt-map");
  if (notices?.format !== "lines" || map?.format !== "lines") throw new Error("notices and prompt-map are lines parts");
  const shape = ["notice_unmapped", "notice_incomplete", "notice_changed", "notice_gone", "notice_unclaimed", "notice_order", "notice_preset"];
  expect(shape.filter((name) => !notices.lines.has(name))).toEqual([]);
  expect(shape.filter((name) => map.lines.has(name))).toEqual([]);
  expect(notices.line("notice_changed", { marker: "style" })).toBe("The text of style, which the map says is fixed, has changed since the turn before.");
  expect(map.line("history_head", { index: 4, id: "m-4", role: "assistant", summarized: true })).toBe("#4 (m-4), assistant, a summary the chat application put in place of messages");
  expect(map.line("layout_piece", { name: "history[4]", length: 900, role: "assistant", history: { index: 4 }, summarized: true })).toBe("history[4] - 900 characters, assistant, chat message #4, a summary the chat application put in place of messages");
  expect(map.line("layout_piece", { name: "style", length: 120, role: "system" })).toBe("style - 120 characters, system");
});

test("each refusal of the owner's edit of the prompt map says what is so and fills in", async () => {
  const map = await shippedParts().part("prompt-map");
  if (map?.format !== "lines") throw new Error("prompt-map is a lines part");
  const fields: Record<string, Record<string, string>> = { edit_unmapped: {}, edit_no_marker: { marker: "style" }, edit_taken: { marker: "style" }, edit_merge_two: {}, edit_not_found: { marker: "style" }, edit_no_words: { marker: "style", words: "At dusk" }, edit_not_neighbours: { marker: "style", other: "persona", between: "card" }, edit_second_part: { marker: "style" } };
  for (const [name, given] of Object.entries(fields)) {
    const said = map.line(name, given) ?? "";
    expect({ name, said: said.length > 0, unfilled: said.includes("{{"), asks: ASKS.test(said) }).toEqual({ name, said: true, unfilled: false, asks: false });
  }
  expect(map.line("edit_no_words", fields["edit_no_words"] ?? {})).toBe('The text of style does not hold "At dusk" past its start, so it cannot be split there.');
});

test("an agent that ended with the reply and an agent given more than its model has room for are each told what is so", async () => {
  const part = await shippedParts().part("delegation");
  if (part?.format !== "lines") throw new Error("delegation is a lines part");
  expect(part.line("ended", { agent: "gm-1" })).toBe("gm-1 ended when this turn's reply went out, so it cannot be messaged now.");
  const said = part.line("too_large", { agent: "gm-1", size: 90000, room: 32000, attachments: [{ name: "chat:history[scene]", tokens: 60000 }, { name: "file:plan.md", tokens: 8000 }] }) ?? "";
  expect(said).toBe("gm-1 was not started: what it is given is 90000 tokens, and its model has room for 32000. chat:history[scene] is 60000 tokens. file:plan.md is 8000 tokens.");
  expect({ asks: ASKS.test(said), unfilled: said.includes("{{") }).toEqual({ asks: false, unfilled: false });
});

test("the briefing says what the session has already looked up and where it is kept, only when the cache holds something", async () => {
  const part = await template("briefing");
  const cache = { folder: "sessions/s-1/cache/", carried: [{ path: "sessions/s-1/turns/t-3/scratch/scene.md" }], lore: [{ id: "e-12", title: "The Gilded Hart", path: "sessions/s-1/cache/lore/e-12.md" }], prompt_map: "sessions/s-1/cache/prompt-map.md", host: [{ path: "sessions/s-1/cache/base/wren.md" }] };
  const said = part.render({ turn: { kind: "reply" }, cache } as never).text;
  expect(said).toContain("## What this session has already looked up\n\nIt is kept in the session's cache folder, sessions/s-1/cache/, to be read from there; nothing writes in it.");
  for (const line of ["- Carried into this turn as it stood: sessions/s-1/turns/t-3/scratch/scene.md", "- Lore entry [e-12] The Gilded Hart, read in full: sessions/s-1/cache/lore/e-12.md", "- The prompt map as this session has it: sessions/s-1/cache/prompt-map.md", "- From the host: sessions/s-1/cache/base/wren.md"]) expect(said).toContain(line);
  expect(part.render({ turn: { kind: "reply" } } as never).text).not.toContain("already looked up");
  expect(ASKS.test(said)).toBe(false);
});

test("the briefing says when the session's file could not be read, whole or in lines, and says nothing when it could", async () => {
  const part = await template("briefing");
  const whole = part.render({ turn: { kind: "reply" }, session_unreadable: { reason: "The host refused it." } } as never).text;
  expect(whole).toContain("## This session's file\n\nIt could not be read: The host refused it. You hold nothing of this session's earlier turns this turn.");
  const partly = part.render({ turn: { kind: "reply" }, session_unreadable: { lines: [4, 9] } } as never).text;
  expect(partly).toContain("Some lines of it could not be read and were passed over");
  expect(partly).toContain("- 4\n- 9");
  expect(part.render({ turn: { kind: "reply" } } as never).text).not.toContain("This session's file");
  expect(ASKS.test(whole + partly)).toBe(false);
});

test("the briefing says what the player's hooks added at the turn's start, under its own heading and only when they added something", async () => {
  const part = await template("briefing");
  const added = part.render({ turn: { kind: "reply" }, rules_due: "A RULE", hooks: "It is dusk by the clock on the wall." } as never).text;
  expect(added).toContain("## From the player's hooks\n\nIt is dusk by the clock on the wall.");
  expect(added.indexOf("A RULE")).toBeLessThan(added.indexOf("From the player's hooks"));
  expect(part.render({ turn: { kind: "reply" } } as never).text).not.toContain("hooks");
  expect(ASKS.test(added)).toBe(false);
});

test("a suggestion past the most the chat holds is told as not kept, and suggest takes a new entry's book, title and keys and an edit's passage as it stands", async () => {
  const base = await shippedParts().part("base-tools");
  if (base?.format !== "lines") throw new Error("base-tools is a lines part");
  const said = base.line("suggest_full", { most: 5 }) ?? "";
  expect(said).toBe("The suggestion was not kept: the chat already has 5 suggestions waiting for the player.");
  expect({ asks: ASKS.test(said), unfilled: said.includes("{{") }).toEqual({ asks: false, unfilled: false });
  expect(Object.keys((await shippedTool("suggest")).arguments)).toEqual(["file", "lore", "new_lore", "text", "reason", "book", "title", "keys", "was"]);
});

test("a search that finds a tool of a family whose guide the agent does not hold gives the guide once and names it after", async () => {
  const part = await shippedParts().part("tool-search");
  if (part?.format !== "lines") throw new Error("tool-search is a lines part");
  const said = part.line("guide", { family: "things", guide: "Each of these names a thing by `item`." }) ?? "";
  expect(said).toBe("How to use the things tools: Each of these names a thing by `item`.");
  expect(part.line("guide_given", { family: "things" })).toBe("The guide to the things tools was given earlier in this session.");
  expect({ asks: ASKS.test(said), unfilled: said.includes("{{") }).toEqual({ asks: false, unfilled: false });
});

test("a sub-agent's question is shown with what it looked up before asking, only when it said something", async () => {
  const part = await template("question");
  expect(part.render({ agent: "gm-1", question: "Which quay?", searched: "Two quays." }).text.trim()).toBe("gm-1 stopped to ask before going on:\n\nWhich quay?\n\nWhat it looked up before asking:\n\nTwo quays.");
  expect(part.render({ agent: "gm-1", question: "Which quay?" }).text).not.toContain("looked up");
});

test("what an agent is given is laid out under its name; given again on a continue, it is only what changed, under a heading that says so", async () => {
  const part = await template("given");
  const first = part.render({ attachments: [{ name: "file:WORLD.md", text: "The harbour." }], missing: ["lore:e-9"] }).text;
  expect(first).toContain("## What you have been given");
  expect(first).toContain("### file:WORLD.md\n\nThe harbour.");
  expect(first).toContain("lore:e-9 could not be found.");
  expect(first).not.toContain("(changed)");
  const again = part.render({ again: true, attachments: [{ name: "file:WORLD.md", text: "The harbour freezes.", changed: true }] }).text;
  expect(again).toContain("## What has changed since you were last given it");
  expect(again).toContain("### file:WORLD.md (changed)\n\nThe harbour freezes.");
  expect(again).not.toContain("What you have been given");
  expect({ asks: ASKS.test(first + again), unfilled: (first + again).includes("{{") }).toEqual({ asks: false, unfilled: false });
});
