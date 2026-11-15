// What a model call was sent, kept for the floor test and the Turn page (§5.3 l.495, §17.1, the
// setting `trace.requests`): for the calls the setting names, every message of the request in the
// order sent, in a file of the turn's folder that the call's `call_started` names, as pointers into
// the turn's own files (the prompt's views, `briefing.md`) where a message's text is in one, and
// rebuilt from them exactly as sent (`Harness.rebuildRequest`); each message RPH placed names its
// block, and a message of the run's own conversation names none; each tool declared names the file
// its description came from. The trace itself holds no request text. Every call's `call_started`
// carries the tokens of its tool list as sent and of its opening block, by RPH's own estimate. The
// lead's blocks are each request's fixed context (§10.2): a later call of the turn begins with the
// whole of the first one's request, so the front a provider caches never moves. `briefing.md` is
// what the lead was told at its run's start (§5.3 l.489). Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { RebuiltRequest, TraceRecord } from "../../src/contract";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import { tokensOf } from "../../src/model/tokens";
import { S1, SAVE, SAVE_RULE, SAVE_TEXT, played as playedTurn, turn } from "../sessions/support";
import { PROMPT, type RecordedRequest, request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

type Started = TraceRecord & { event: Extract<TraceRecord["event"], { kind: "call_started" }> };

/** A turn of two calls by RPH's own lead: a note on its list, then the reply. */
async function played(config?: string): Promise<{ s: Stage; started: Started[] }> {
  const s = (open = await stage({
    ...(config !== undefined ? { config } : {}),
    answers: [{ pieces: [{ call: "todo", args: { items: [{ text: "look at the sea", done: false }] } }] }, { pieces: [{ text: "<reply>The sea is grey and high.</reply>" }] }],
  }));
  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  return { s, started: s.trace.of("call_started") };
}

/** A request as the model received it, each message as role and text. */
function asSent(req: RecordedRequest): { role: string; text: string }[] {
  return req.messages.map((message) => ({ role: message.role, text: textOf(message) }));
}

/** A kept request rebuilt from the turn's folder, which must be what was sent by the hash it keeps. */
async function kept(s: Stage, path: string): Promise<RebuiltRequest> {
  const rebuilt = await s.harness.rebuildRequest(request("t1").scope, path);
  if (rebuilt === undefined) throw new Error(`No request kept at ${path}.`);
  expect(rebuilt.same).toBe(true);
  return rebuilt;
}

/** A kept request's file as it is on disk. */
interface KeptFile {
  sent: string;
  messages: ({ role: string; block?: string; text: string } | { role: string; block?: string; from: { file: string; at: number; length: number } })[];
  tools: { name: string; file?: string }[];
}

async function onDisk(s: Stage, path: string): Promise<{ text: string; file: KeptFile }> {
  const read = await s.env.files.read(request("t1").scope, path);
  if (read.status !== "read") throw new Error(`No request kept at ${path}.`);
  return { text: read.text, file: JSON.parse(read.text) as KeptFile };
}

/** A kept request's messages as role and text, leaving out the blocks they name. */
function plain(file: RebuiltRequest): { role: string; text: string }[] {
  return file.messages.map(({ role, text }) => ({ role, text }));
}

/** The path of the request kept for an agent's call. */
function keptFor(s: Stage, agent: string, call: number): string {
  const started = s.trace.of("call_started").find((record) => record.agent.id === agent && record.event.call === call);
  const path = started?.event.request;
  if (path === undefined) throw new Error(`No request kept for ${agent}'s call ${call}.`);
  return path;
}

test("as shipped, an agent's first call is kept beside the transcripts: every message it was sent, in order, as role and text; its call_started names the file, and the trace holds none of the text", async () => {
  const { s, started } = await played();

  expect(started.map((record) => record.event.call)).toEqual([1, 2]);
  const path = started[0]!.event.request!;
  expect(path).toMatch(/^sessions\/s1\/turns\/t1\/transcripts\/lead-[A-Za-z0-9_-]+\.call-1\.json$/);
  expect(started[1]!.event.request).toBeUndefined();
  const first = asSent(s.model.requests[0]!);
  expect(plain(await kept(s, path))).toEqual(first);
  // The prompt the chat application sent is in it whole, in its order and with its roles.
  const prompt = PROMPT.map((message) => ({ role: message.role, text: String(message.content) }));
  const at = first.findIndex((message) => message.text === prompt[0]!.text);
  expect(first.slice(at, at + prompt.length)).toEqual(prompt);
  // No text of the request is in the trace.
  const trace = JSON.stringify(s.trace.records);
  for (const message of prompt) expect(trace).not.toContain(message.text);
});

test("every call carries the tokens of its tool list as sent and of its opening block; `all` keeps every call's request, `none` keeps none", async () => {
  const all = await played("trace:\n  requests: all\n");
  const sent = all.s.model.requests;
  const tools = tokensOf(JSON.stringify(sent[0]!.tools), DEFAULT_SETTINGS.tokens.charsPerToken);
  const opening = tokensOf(textOf(sent[0]!.messages[0]!), DEFAULT_SETTINGS.tokens.charsPerToken);
  expect(tools).toBeGreaterThan(0);
  expect(opening).toBeGreaterThan(0);
  expect(all.started.map((record) => [record.event.toolTokens, record.event.openingTokens])).toEqual([
    [tools, opening],
    [tools, opening],
  ]);
  const paths = all.started.map((record) => record.event.request!);
  expect(paths[1]).toMatch(/\.call-2\.json$/);
  expect(plain(await kept(all.s, paths[0]!))).toEqual(asSent(sent[0]!));
  expect(plain(await kept(all.s, paths[1]!))).toEqual(asSent(sent[1]!));
  expect((await all.s.files()).filter((text) => text.startsWith('{"sent":'))).toHaveLength(2);
  await all.s.close();
  open = undefined;

  const none = await played("trace:\n  requests: none\n");
  expect(none.started.map((record) => record.event.request)).toEqual([undefined, undefined]);
  expect(none.started.map((record) => record.event.toolTokens)).toEqual([tools, tools]);
  expect((await none.s.files()).some((text) => text.includes('"messages":['))).toBe(false);
});

test("the lead's second call begins with the whole of his first call's request, the prompt in it once, whole and in order, after the opening block and its frame; then his own work", async () => {
  const { s } = await played("trace:\n  requests: all\n");
  const [first, second] = s.model.requests.map(asSent);

  expect(second!.slice(0, first!.length)).toEqual(first!);
  expect(second!.slice(first!.length).map((message) => message.role)).toEqual(["assistant", "toolResult"]);
  const prompt = PROMPT.map((message) => ({ role: message.role, text: String(message.content) }));
  const at = first!.findIndex((message) => message.text === prompt[0]!.text);
  expect(first!.slice(0, at).map((message) => message.role)).toEqual(["system", "system"]);
  expect(first!.slice(at, at + prompt.length)).toEqual(prompt);
  expect(first!.filter((message) => message.text === prompt[0]!.text)).toHaveLength(1);
});

const NOTES = "chats/wren-hale/lighthouse/persistent-workspace/notes.md";
const CHIEF = "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [todo, delegate]\ngiven: [prompt:*, session:carry, briefing, file:persistent-workspace/notes.md]\n---\nFixture chief: you run the turn.\n";
const GM = "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: [todo]\n---\nFixture GM: rule on what you are asked.\n";

test("the lead's first kept request names each block: opening, frame, prompt, session:carry, briefing, and a given part by its name; a message of the run's own has none", async () => {
  const s = (open = await stage({
    config: "trace:\n  requests: all\n",
    files: { ".agents/chief.md": CHIEF, [NOTES]: "Fixture note: the boat is two days late." },
    answers: [
      { pieces: [{ text: "<intent>Fixture intent: the boat.</intent><reply>No boat tonight.</reply>" }] },
      { pieces: [{ call: "todo", args: { items: [{ text: "look at the sea", done: false }] } }] },
      { pieces: [{ text: "<reply>The sea is grey and high.</reply>" }] },
    ],
  }));
  expect((await s.turn(request("t1", { lead: "chief", carry: "continuing" }))).outcome.status).toBe("released");
  expect((await s.turn(request("t2", { lead: "chief", carry: "continuing", parent: "t1" }))).outcome.status).toBe("released");

  const lead = s.trace.of("call_started").filter((record) => record.event.request?.includes("/turns/t2/") === true)[0]!.agent.id;
  const first = await kept(s, keptFor(s, lead, 1));
  expect(plain(first)).toEqual(asSent(s.model.requests[1]!));
  const named = ["opening", "frame", ...PROMPT.map(() => "prompt"), "session:carry", "briefing", "file:persistent-workspace/notes.md"];
  expect(first.messages.map((message) => message.block)).toEqual(named);
  expect(first.messages.at(-1)!.text).toContain("Fixture note: the boat is two days late.");
  // The second call carries the first's blocks as they were, then the run's own work, which names none.
  const second = await kept(s, keptFor(s, lead, 2));
  expect(second.messages.map((message) => message.block)).toEqual([...named, undefined, undefined]);
  expect(second.messages.slice(-2).map((message) => message.role)).toEqual(["assistant", "toolResult"]);
  expect((await onDisk(s, keptFor(s, lead, 2))).text).not.toContain('"block":null');
});

test("a sub-agent's kept request names its opening and its brief; its own work names none", async () => {
  const s = (open = await stage({
    config: "trace:\n  requests: all\n",
    files: { ".agents/chief.md": CHIEF, ".agents/gm.md": GM },
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump to the far ledge." } }] },
      { pieces: [{ call: "todo", args: { items: [{ text: "measure the gap", done: false }] } }] },
      { pieces: [{ text: "At twenty feet the jump fails." }] },
      { pieces: [{ text: "<reply>She falls short of the far ledge.</reply>" }] },
    ],
  }));
  expect((await s.turn(request("t1", { lead: "chief" }))).outcome.status).toBe("released");

  const first = await kept(s, keptFor(s, "gm-1", 1));
  expect(first.messages.map((message) => message.block)).toEqual(["opening", "brief"]);
  expect(first.messages[1]!.text).toContain("Rule on the jump to the far ledge.");
  const second = await kept(s, keptFor(s, "gm-1", 2));
  expect(second.messages.map((message) => message.block)).toEqual(["opening", "brief", undefined, undefined]);
});

/** A file of the agents' tree, as text. */
async function textAt(s: Stage, path: string): Promise<string> {
  const read = await s.env.files.read(request("t1").scope, path);
  if (read.status !== "read") throw new Error(`No file at ${path}.`);
  return read.text;
}

/** The handle of the lead whose first call is kept in the turn's folder, by the order its runs began. */
function leadIn(s: Stage, turnId: string, run = 0): string {
  const started = s.trace.of("call_started").filter((record) => record.event.request?.includes(`/turns/${turnId}/`) === true && record.agent.parent === undefined && record.event.call === 1);
  const agent = started[run]?.agent.id;
  if (agent === undefined) throw new Error(`No lead's first call kept in ${turnId}.`);
  return agent;
}

/** Two turns of the chief, the second carrying the first on: its lead's first request holds every block. */
async function carried(extra: string[] = []): Promise<Stage> {
  const s = (open = await stage({
    files: { ".agents/chief.md": CHIEF, [NOTES]: "Fixture note: the boat is two days late." },
    answers: [{ pieces: [{ text: "<intent>Fixture intent: the boat.</intent><reply>No boat tonight.</reply>" }] }, { pieces: [{ text: "<reply>The sea is grey and high.</reply>" }] }, ...extra.map((reply) => ({ pieces: [{ text: `<reply>${reply}</reply>` }] }))],
  }));
  expect((await s.turn(request("t1", { lead: "chief", carry: "continuing" }))).outcome.status).toBe("released");
  expect((await s.turn(request("t2", { lead: "chief", carry: "continuing", parent: "t1" }))).outcome.status).toBe("released");
  return s;
}

test("the first request file holds no message text that is in assembled-preset-prompt.md or briefing.md", async () => {
  const s = await carried();
  const folder = "sessions/s1/turns/t2/";
  const { text, file } = await onDisk(s, keptFor(s, leadIn(s, "t2"), 1));
  const view = await textAt(s, `${folder}assembled-preset-prompt.md`);
  const briefing = await textAt(s, `${folder}briefing.md`);
  const sent = asSent(s.model.requests[1]!);

  // The prompt points into its view, what the session carried and the briefing into `briefing.md`; the opening block, the frame and the given file are what was added.
  expect(file.messages.map((line) => ("from" in line ? line.from.file : `added:${line.block}`))).toEqual(["added:opening", "added:frame", ...PROMPT.map(() => "assembled-preset-prompt.md"), "briefing.md", "briefing.md", "added:file:persistent-workspace/notes.md"]);
  for (const message of sent) {
    if (!view.includes(message.text) && !briefing.includes(message.text)) continue;
    expect(text).not.toContain(JSON.stringify(message.text).slice(1, -1));
  }
});

test("rebuilding a turn's first requests from the turn folder gives, byte for byte, what the model layer was sent, for the lead, a sub-agent and the narrator", async () => {
  const team = (open = await stage({
    files: { ".agents/chief.md": CHIEF, ".agents/gm.md": GM },
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump to the far ledge." } }] },
      { pieces: [{ text: "At twenty feet the jump fails." }] },
      { pieces: [{ text: "<reply>She falls short of the far ledge.</reply>" }] },
    ],
  }));
  expect((await team.turn(request("t1", { lead: "chief" }))).outcome.status).toBe("released");
  const teamStarted = team.trace.of("call_started");
  expect(teamStarted.filter((record) => record.event.request !== undefined).map((record) => record.agent.definition)).toEqual(["chief", "gm"]);
  for (const [at, record] of teamStarted.entries()) {
    if (record.event.request === undefined) continue;
    const rebuilt = await kept(team, record.event.request);
    expect(plain(rebuilt)).toEqual(asSent(team.model.requests[at]!));
  }
  await team.close();
  open = undefined;

  const drafted = (open = await stage({
    drafted: true,
    answers: [
      { pieces: [{ text: "<intent>Hand the prose over.</intent>" }, { call: "write_reply", args: { brief: "Wren says the boat has not come." } }] },
      { pieces: [{ text: " has not come, Wren says." }] },
      { pieces: [{ call: "reply_release", args: { closing: true } }] },
    ],
  }));
  expect((await drafted.turn(request("t1", { prefill: "The boat", prompt: [...PROMPT, { role: "assistant", content: "The boat" }] }))).outcome.status).toBe("released");
  const draftedStarted = drafted.trace.of("call_started");
  expect(draftedStarted.map((record) => record.event.request !== undefined)).toEqual([true, true, false]);
  for (const [at, record] of draftedStarted.entries()) {
    if (record.event.request === undefined) continue;
    const rebuilt = await kept(drafted, record.event.request);
    expect(plain(rebuilt)).toEqual(asSent(drafted.model.requests[at]!));
    // The prompt is in the narrator's request as in the lead's: pointers, no second copy.
    const { file } = await onDisk(drafted, record.event.request);
    for (const line of file.messages.filter((message) => message.block === "prompt")) expect("from" in line).toBe(true);
  }
});

const QUESTION = "Does the lead promise a reward?";
const RULE = `---\ndescription: Fixture - a reward promised.\nagents: [lead]\nscope: [text]\nquestion: ${QUESTION}\n---\nFixture rule: promise nothing.\n`;
const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [todo]\ngiven:\n  - prompt:*\n  - session:carry\n  - briefing\n---\nFixture lead: you run the turn.\n";

test("with trace.requests all, every call of a turn, a judging call and a summary call included, rebuilds byte for byte, and each declared tool names its description's file", async () => {
  let leadCalls = 0;
  const respond = (req: RecordedRequest) => {
    const texts = req.messages.map((message) => textOf(message));
    if (texts.some((text) => text.includes(QUESTION))) return { pieces: [{ text: "No." }] };
    if (texts.some((text) => text.includes(SAVE_TEXT))) return { pieces: [{ call: "todo", args: { items: [{ text: "keep the tide" }] } }] };
    if (req.tools.length === 0) return { pieces: [{ text: "Fixture summary." }] };
    leadCalls += 1;
    return leadCalls <= 3 ? playedTurn(leadCalls) : { pieces: [{ text: "<reply>The tide turns at nine.</reply>" }] };
  };
  const s = (open = await stage({
    config: "trace:\n  requests: all\ncompaction:\n  keepTurns: 2\n",
    files: { ".agents/lead.md": LEAD, [SAVE_RULE]: SAVE, ".rules/fixture-reward.md": RULE },
    answers: Array.from({ length: 20 }, () => respond),
  }));
  for (const [id, parent] of [["t1"], ["t2", "t1"], ["t3", "t2"]] as const) expect((await s.turn(turn(id, parent !== undefined ? { parent } : {}))).outcome.status).toBe("released");
  await s.harness.sessions!.compact(S1);
  expect((await s.turn(turn("t4", { parent: "t3" }))).outcome.status).toBe("released");
  expect(s.trace.of("compacted")).toHaveLength(1);

  const started = s.trace.of("call_started");
  expect(started).toHaveLength(s.model.requests.length);
  const rebuilt: RebuiltRequest[] = [];
  for (const record of started) {
    expect(record.event.request).toBeDefined();
    rebuilt.push(await kept(s, record.event.request!));
  }
  // Every request the model layer was sent, the judge's and the summarizer's among them, is one rebuilt from the turn's folder.
  const asJson = (list: { role: string; text: string }[][]) => list.map((messages) => JSON.stringify(messages)).sort();
  expect(asJson(rebuilt.map(plain))).toEqual(asJson(s.model.requests.map(asSent)));
  expect(rebuilt.filter((req) => req.messages.some((message) => message.text.includes(QUESTION))).length).toBeGreaterThan(0);
  expect(rebuilt.filter((req) => req.tools.length === 0 && req.messages.some((message) => message.text.includes(SAVE_TEXT)) === false && !req.messages.some((message) => message.text.includes(QUESTION)))).toHaveLength(1);
  // Each tool declared names the file its description came from, which is there to read.
  const declared = rebuilt.flatMap((req) => req.tools);
  expect(declared.map((tool) => tool.name)).toContain("todo");
  for (const tool of declared) {
    expect(tool.file).toBeDefined();
    expect(tool.file!).toContain(tool.name);
  }
});

test("briefing.md equals the carried block and the briefing message of the lead's first request; a continue's run leaves a second file beside the first", async () => {
  const s = await carried(["The lamp is lit."]);
  expect((await s.turn(request("t2", { lead: "chief", carry: "continuing", kind: "continue", parent: "t1" }))).outcome.status).toBe("released");
  const folder = "sessions/s1/turns/t2/";
  /** What the lead's first request in a run of t2 holds of what the session carried and the briefing, as the file would hold it. */
  const told = async (run: number): Promise<string> => {
    const first = await kept(s, keptFor(s, leadIn(s, "t2", run), 1));
    const blocks = first.messages.filter((message) => message.block === "session:carry" || message.block === "briefing");
    expect(blocks.map((message) => message.block)).toEqual(["session:carry", "briefing"]);
    return blocks.map((message) => message.text).join("\n\n");
  };

  expect(await textAt(s, `${folder}briefing.md`)).toBe(await told(0));
  const runs = [...new Set(s.trace.records.filter((record) => record.scope.turn === "t2").map((record) => record.run))];
  expect(runs).toHaveLength(2);
  expect(await textAt(s, `${folder}briefing.${runs[1]}.md`)).toBe(await told(1));
});
