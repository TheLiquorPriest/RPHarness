// Each connection's throttle (§13.2, as today's build kept it): the requests sent on it and the
// tokens sent and written over the last minute, and its calls under way at once, across every agent
// of the user's, whatever run or job it is in. On the rig's clock: a call waits for room, and its run
// is told of the wait and how long it was; a call's estimate stands in its minute until its server
// reports what it spent; a call bigger than the whole minute is not made, and its run is told that
// limit on the connection; calls past the count at once wait in line, first come first served, and
// one stopped in line leaves it holding nothing. Everything here is invented.

import { afterEach, expect, test } from "bun:test";
import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Scope } from "../../src/contract";
import type { AgentModel, LayerEvent, LayerOptions } from "../../src/model";
import type { Rig, Sent } from "./support";
import { bodyOf, call, chatStream, chunk, eventStream, rig, textOf, USER } from "./support";

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

const WRITER = { name: "Writer", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" } as const;

/** Where the agents run: a turn's run in two chats, and a job. */
const SCOPES: Scope[] = [
  { user: USER, chat: "harbour", session: "turn-1" },
  { user: USER, chat: "quay", session: "turn-2" },
  { user: USER, chat: "harbour", session: "job-1" },
];

/** The same question every call of a test of tokens asks, so each is estimated alike. */
const QUESTION = "Is the mill open?";

/** A config file's throttle for the connection "Writer", its lines as YAML under the connection. */
function throttled(lines: string): string {
  return `connections:\n  Writer:\n    throttles:\n${lines}`;
}

/** A server's answer, with the tokens it reports spent when `used` is given. */
function answer(used?: number): Response {
  const usage = used === undefined ? [] : [{ ...chunk({}), choices: [], usage: { prompt_tokens: used, completion_tokens: 0, total_tokens: used } }];
  return eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop"), ...usage]));
}

/** One call of an agent's on `text`, with what its run is told. */
function told(agent: AgentModel, text: string, heard: LayerEvent[], signal?: AbortSignal): Promise<AssistantMessage> {
  const options: SimpleStreamOptions & LayerOptions = { heard: (event) => heard.push(event), ...(signal !== undefined ? { signal } : {}) };
  return call(agent, [{ role: "user", content: text, timestamp: 1 }], options);
}

/** What each request sent asked. */
function asked(sent: readonly Sent[]): string[] {
  return sent.map((one) => textOf((bodyOf(one).messages as { content: unknown }[]).at(-1)?.content));
}

const minuteWait = (ms?: number): LayerEvent => ({ kind: "connection_wait", connection: "Writer", for: "minute", ...(ms !== undefined ? { ms } : {}) });
const placeWait = (ms?: number): LayerEvent => ({ kind: "connection_wait", connection: "Writer", for: "place", ...(ms !== undefined ? { ms } : {}) });

test("on the fake clock the requests and tokens per minute hold across the agents of two runs and a job; a call waits for room; a call bigger than the minute is refused, naming the connection", async () => {
  let used: number | undefined;
  const made = (r = rig({ global: throttled("      requestsPerMinute: 2\n"), script: () => answer(used) }));
  const saved = await made.layer.api.save(USER, WRITER);
  const [first, second, job] = await Promise.all(SCOPES.map((scope) => made.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off", scope })));
  if (first === undefined || second === undefined || job === undefined) throw new Error("three agents were asked for");

  // Two requests a minute: the two runs' calls go at once; the job's waits for the minute, and its run is told how long.
  const heard: LayerEvent[][] = [[], [], []];
  await told(first, "the first run", heard[0]!);
  await told(second, "the second run", heard[1]!);
  const waiting = told(job, "the job", heard[2]!);
  await made.clock.idle();
  expect([asked(made.sent), heard]).toEqual([["the first run", "the second run"], [[], [], [minuteWait()]]]);
  made.clock.advance(59_999);
  await made.clock.idle();
  expect(made.sent).toHaveLength(2);
  made.clock.advance(1);
  expect((await waiting).errorMessage).toBeUndefined();
  expect([asked(made.sent), heard[2]]).toEqual([["the first run", "the second run", "the job"], [minuteWait(), minuteWait(60_000)]]);

  // A call bigger than the connection's whole minute is not made, and its run is told the limit on the connection.
  made.clock.advance(60_000);
  made.configs.global = throttled("      tokensPerMinute: 1\n");
  const refused: LayerEvent[] = [];
  const big = await told(first, QUESTION, refused);
  const hit = refused[0];
  if (hit?.kind !== "limit") throw new Error(`a limit was to be heard, not ${JSON.stringify(refused)}`);
  const estimate = hit.hit.value;
  expect(refused).toEqual([{ kind: "limit", hit: { limit: "tokensPerMinute", per: "connection", max: 1, value: estimate, connection: "Writer" } }]);
  expect(big.errorMessage).toBe(`This call comes to about ${estimate} tokens, more than the 1 a minute the connection "Writer" takes, so it was not made. The setting "Tokens a minute on a connection" on the Settings page says how many it takes.`);
  expect(made.sent).toHaveLength(3);

  // A minute of two calls' estimates: two calls of the three agents go at once, and the third waits until the minute has room.
  made.configs.global = throttled(`      tokensPerMinute: ${2 * estimate}\n`);
  const tokens: LayerEvent[][] = [[], [], []];
  await told(first, QUESTION, tokens[0]!);
  await told(second, QUESTION, tokens[1]!);
  const late = told(job, QUESTION, tokens[2]!);
  await made.clock.idle();
  expect([made.sent.length, tokens]).toEqual([5, [[], [], [minuteWait()]]]);
  made.clock.advance(60_000);
  expect((await late).errorMessage).toBeUndefined();
  expect(tokens[2]).toEqual([minuteWait(), minuteWait(60_000)]);

  // What a server reports it spent stands in the minute in place of the estimate: reported small, three calls fit where two estimates did.
  made.clock.advance(60_000);
  used = 1;
  const reported: LayerEvent[][] = [[], [], []];
  for (const [at, agent] of [first, second, job].entries()) expect((await told(agent, QUESTION, reported[at]!)).errorMessage).toBeUndefined();
  expect([made.sent.length, reported]).toEqual([9, [[], [], []]]);
});

test("calls past the connection's count wait in order; a stopped one leaves the line and frees nothing it did not hold", async () => {
  // Each request's answer is held until the test lets it go.
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const made = (r = rig({
    global: throttled("      atOnce: 1\n"),
    script: async (_sent, index) => {
      await gates[index]?.promise;
      return answer();
    },
  }));
  const saved = await made.layer.api.save(USER, WRITER);
  const [one, two, three] = await Promise.all(SCOPES.map((scope) => made.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off", scope })));
  if (one === undefined || two === undefined || three === undefined) throw new Error("three agents were asked for");

  const heard: LayerEvent[][] = [[], [], [], []];
  const stop = new AbortController();
  const first = told(one, "first", heard[0]!);
  await made.clock.idle();
  const second = told(two, "second", heard[1]!);
  const stopped = told(three, "stopped", heard[2]!, stop.signal);
  const fourth = told(one, "fourth", heard[3]!);
  await made.clock.idle();
  expect([asked(made.sent), heard]).toEqual([["first"], [[], [placeWait()], [placeWait()], [placeWait()]]]);

  // Stopped in line: it leaves it, and frees no place, so nothing behind it goes while the first runs.
  stop.abort(new Error("The reply was stopped."));
  expect((await stopped).stopReason).toBe("aborted");
  await made.clock.idle();
  expect(asked(made.sent)).toEqual(["first"]);

  // The place the first frees goes to the first in line, then the next.
  gates[0]?.resolve();
  await first;
  await made.clock.idle();
  expect(asked(made.sent)).toEqual(["first", "second"]);
  gates[1]?.resolve();
  await second;
  await made.clock.idle();
  expect(asked(made.sent)).toEqual(["first", "second", "fourth"]);
  gates[2]?.resolve();
  expect((await fourth).errorMessage).toBeUndefined();
  expect(heard.slice(1)).toEqual([
    [placeWait(), placeWait(0)],
    [placeWait(), placeWait(0)],
    [placeWait(), placeWait(0)],
  ]);

  // Nothing is under way: the next call takes its place at once.
  gates[3]?.resolve();
  const fifth: LayerEvent[] = [];
  expect((await told(two, "fifth", fifth)).errorMessage).toBeUndefined();
  expect([asked(made.sent), fifth]).toEqual([["first", "second", "fourth", "fifth"], []]);
});
