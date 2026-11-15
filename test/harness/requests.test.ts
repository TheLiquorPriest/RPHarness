// What a model call was sent, kept for the floor test and the Turn page (§17.1, the setting
// `trace.requests`): for the calls the setting names, every message of the request in the order
// sent, as role and text, in a file of the turn's folder that the call's `call_started` names; each
// message RPH placed names its block, and a message of the run's own conversation names none. The
// trace itself holds no request text. Every call's `call_started` carries the tokens of its tool
// list as sent and of its opening block, by RPH's own estimate. The lead's blocks are each request's
// fixed context (§10.2): a later call of the turn begins with the whole of the first one's request,
// so the front a provider caches never moves. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { TraceRecord } from "../../src/contract";
import { DEFAULT_SETTINGS } from "../../src/harness/settings";
import { tokensOf } from "../../src/model/tokens";
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

/** A kept request as the file holds it. */
interface Kept {
  messages: { role: string; text: string; block?: string }[];
}

async function kept(s: Stage, path: string): Promise<Kept> {
  const read = await s.env.files.read(request("t1").scope, path);
  if (read.status !== "read") throw new Error(`No request kept at ${path}.`);
  return JSON.parse(read.text) as Kept;
}

/** A kept request's messages as role and text, leaving out the blocks they name. */
function plain(file: Kept): { role: string; text: string }[] {
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
  expect((await all.s.files()).filter((text) => text.startsWith('{"messages":['))).toHaveLength(2);
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
  expect(JSON.stringify(second)).not.toContain('"block":null');
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
