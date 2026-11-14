// What a model call was sent, kept for the floor test and the Turn page (§17.1, the setting
// `trace.requests`): for the calls the setting names, every message of the request in the order
// sent, as role and text, in a file of the turn's folder that the call's `call_started` names. The
// trace itself holds no request text. Every call's `call_started` carries the tokens of its tool
// list as sent and of its opening block, by RPH's own estimate. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { TraceRecord } from "../../src/contract";
import { DEFAULT_CHARS_PER_TOKEN, tokensOf } from "../../src/model/tokens";
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

async function kept(s: Stage, path: string): Promise<unknown> {
  const read = await s.env.files.read(request("t1").scope, path);
  if (read.status !== "read") throw new Error(`No request kept at ${path}.`);
  return JSON.parse(read.text);
}

test("as shipped, an agent's first call is kept beside the transcripts: every message it was sent, in order, as role and text; its call_started names the file, and the trace holds none of the text", async () => {
  const { s, started } = await played();

  expect(started.map((record) => record.event.call)).toEqual([1, 2]);
  const path = started[0]!.event.request!;
  expect(path).toMatch(/^sessions\/s1\/turns\/t1\/transcripts\/lead-[A-Za-z0-9_-]+\.call-1\.json$/);
  expect(started[1]!.event.request).toBeUndefined();
  const first = asSent(s.model.requests[0]!);
  expect(await kept(s, path)).toEqual({ messages: first });
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
  const tools = tokensOf(JSON.stringify(sent[0]!.tools), DEFAULT_CHARS_PER_TOKEN);
  const opening = tokensOf(textOf(sent[0]!.messages[0]!), DEFAULT_CHARS_PER_TOKEN);
  expect(tools).toBeGreaterThan(0);
  expect(opening).toBeGreaterThan(0);
  expect(all.started.map((record) => [record.event.toolTokens, record.event.openingTokens])).toEqual([
    [tools, opening],
    [tools, opening],
  ]);
  const paths = all.started.map((record) => record.event.request!);
  expect(paths[1]).toMatch(/\.call-2\.json$/);
  expect(await kept(all.s, paths[0]!)).toEqual({ messages: asSent(sent[0]!) });
  expect(await kept(all.s, paths[1]!)).toEqual({ messages: asSent(sent[1]!) });
  expect((await all.s.files()).filter((text) => text.startsWith('{"messages":['))).toHaveLength(2);
  await all.s.close();
  open = undefined;

  const none = await played("trace:\n  requests: none\n");
  expect(none.started.map((record) => record.event.request)).toEqual([undefined, undefined]);
  expect(none.started.map((record) => record.event.toolTokens)).toEqual([tools, tools]);
  expect((await none.s.files()).some((text) => text.includes('"messages":['))).toBe(false);
});
