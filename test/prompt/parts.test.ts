// The words of RPH's own shipped parts and tool guides that the texts lane worded for the wave's code
// (PlanTexts-4): a refused write says where notes go; `write_reply` with no writer says why, in each of
// its three cases; `second_reply` is true in both forms of a reply; a line the code no longer asks for is
// gone; the sign-in line, the tools offered as text, what the player said to an agent at work, a search
// that stopped, and the job tools' lines and guides are each there, plain and asking for nothing; and no
// header of RPH's own parts or tools holds a field nothing reads. Each row is the shipped file's own
// line, rendered as the harness renders it. Every name is invented.

import { readdirSync, readFileSync } from "node:fs";
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

/** The header fields of a part or a tool file that something reads: its description and format, a tool's arguments, and the fields code reads of one part by name. */
const READ: Record<string, true> = { description: true, format: true, arguments: true, yes: true, record: true, views: true, tags: true, intent_file: true };

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
  expect(Object.keys(headerOf(readFileSync(join(SHIPPED_GUIDANCE, ".tools", "write_reply.md"), "utf8")))).toEqual(["description", "arguments"]);
});

test("every definition RPH ships names its model and its effort", () => {
  for (const file of readdirSync(join(SHIPPED_GUIDANCE, ".agents"))) {
    const header = headerOf(readFileSync(join(SHIPPED_GUIDANCE, ".agents", file), "utf8"));
    expect({ file, model: typeof header.model, effort: typeof header.effort }).toEqual({ file, model: "string", effort: "string" });
  }
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

test("the mark of a system message sent in place and the text of a connection's test are there, each with a description beside it", async () => {
  expect((await template("system-note")).render({ text: "The tide turns." }).text.trimEnd()).toBe("System note:\nThe tide turns.");
  expect((await template("connection-test")).render().text.trim()).toBe("Reply with one word: ready.");
  for (const name of ["system-note", "connection-test"]) expect({ name, described: typeof (await template(name)).header["description"] }).toEqual({ name, described: "string" });
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
    ["day_limit", { value: 6, max: 6 }, "No job was started: 6 jobs were started today, and the player allows 6."],
    ["day_limit", { value: 3, max: 3, connection: "Main" }, "No job was started: 3 jobs were started today on Main, and the player allows 3."],
    ["run_limit", { value: 2, max: 2 }, "No job was started: this turn has started 2 jobs, and the player allows 2."],
    ["run_limit", { value: 1, max: 1, job: true }, "No job was started: this job has started 1 jobs, and the player allows 1."],
    ["day_tokens", { value: 900, max: 800 }, "No job was started: what jobs sent and wrote today counts as 900 tokens, and the player allows 800."],
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
