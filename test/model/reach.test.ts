// What leaves with a call goes where its connection says, and nowhere else: no variable of the
// environment signs it, steers it or adds to it; no redirect takes its key or its headers to another
// address, on any provider (one whose calls can't go through the layer's own fetch takes no address
// but its provider's own); and a stream that goes silent once its answer has begun is ended in words
// that say so, while a model slow to begin is left to begin. Every wait runs on the rig's clock.

import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import type { AgentModel } from "../../src/model";
import { KINDS } from "../../src/model/kinds";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, call, failed, rig } from "./support";

const KEY = "sk-ant-api03-Ilse0123456789abcdefWXYZ";
const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";
const GATEWAY = "gw-token-Okoro0123456789abcdef";
const ASK: Message[] = [{ role: "user", content: "Is the mill open?", timestamp: 1 }];

let r: Rig | undefined;
const after: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of after.splice(0).reverse()) await undo();
  await r?.done();
  r = undefined;
});

/** A response whose body the test writes as it goes: each `send` resolves once the reader has taken everything sent so far. */
function heldStream(): { response: Response; send(text: string): Promise<void>; end(): void } {
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  let taken: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        control = c;
      },
      pull() {
        taken?.();
        taken = undefined;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    send(text) {
      const { promise, resolve } = Promise.withResolvers<void>();
      taken = resolve;
      control?.enqueue(new TextEncoder().encode(text));
      return promise;
    },
    end() {
      control?.close();
    },
  };
}

/** A whole Anthropic answer of `text`, as its events: [start, block start, first piece, …the rest]. */
const ANSWER = anthropicTurn({ text: "The mill is closed." });
const event = (...events: Record<string, unknown>[]): string => anthropicStream(events);
/** A keep-alive Anthropic sends while a call is open, which pi-ai passes on as nothing. */
const PING = event({ type: "ping" });

/** An Anthropic connection's agent model, its API answering with `held`. */
async function heldClaude(made: Rig): Promise<AgentModel> {
  const saved = await made.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
  return made.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" });
}

/** Reads a call's events until its first piece of text has come. */
async function untilText(events: AsyncIterator<AssistantMessageEvent>): Promise<void> {
  for (;;) {
    const next = await events.next();
    if (next.done === true || next.value.type === "text_delta") return;
  }
}

describe("the environment", () => {
  test("what the SDKs would read in it for themselves is taken out as the layer is made, in one line of the log that names it and never its value", () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-ant-env-0123456789abcdef", OPENAI_ORG_ID: "org-env-0123456789", PI_OAUTH_CALLBACK_HOST: "0.0.0.0", PATH: "/usr/bin", LANG: "en_GB.UTF-8" };
    r = rig({ env });
    expect(env).toEqual({ PATH: "/usr/bin", LANG: "en_GB.UTF-8" });
    expect(r.logs).toEqual(["took out of the environment what would sign or steer model calls and sign-ins: ANTHROPIC_CUSTOM_HEADERS, OPENAI_ORG_ID, PI_OAUTH_CALLBACK_HOST"]);
  });
});

describe("redirects", () => {
  test("no call of any provider that takes an address follows one, nor a list of models: the key and the headers stay with the address they were given for", async () => {
    const reached: string[] = [];
    /** How many requests the server that moved has been sent. */
    let asked = 0;
    const away = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (reached.push(`${req.method} ${new URL(req.url).pathname}`), new Response("{}")) });
    const mover = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => ((asked += 1), new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${away.port}${new URL(req.url).pathname}` } })) });
    after.push(() => {
      away.stop(true);
      mover.stop(true);
    });
    const made = rig({ fetch: globalThis.fetch });
    r = made;
    const moved = { baseUrl: `http://127.0.0.1:${mover.port}/v1`, model: "served-model", headers: { "x-gateway-token": GATEWAY }, limits: { "served-model": { contextWindow: 100_000, maxTokens: 4_096 } } };
    const listing = await made.layer.api.save({ name: "Moved", provider: "openai-compatible", auth: "key", ...moved }, SERVER_KEY);
    const redirected = "the server answered with a redirect to another address, which isn't followed, so that the connection's key and headers never go with it: give the connection the address it moved to.";
    await expect(made.layer.api.models(listing.id)).rejects.toThrow(`The server didn't list its models: ${redirected}`);
    expect((await call(await made.layer.agentModel({ connectionId: listing.id, model: null, effort: "off" }), ASK)).errorMessage).toBe(`The call wasn't made: ${redirected}`);
    const offered = KINDS.filter((kind) => kind.ownAddress !== true);
    expect(offered.map((kind) => kind.id)).toEqual(["anthropic", "openai", "openrouter", "deepseek", "xai", "groq", "mistral", "openai-compatible", "anthropic-compatible"]);
    for (const kind of offered) {
      const saved = await made.layer.api.save({ name: kind.name, provider: kind.id, auth: "key", ...moved }, SERVER_KEY);
      const before = asked;
      const answer = await call(await made.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" }), ASK);
      // The call went out, met the redirect, and went no further.
      expect([kind.id, answer.stopReason, asked - before]).toEqual([kind.id, "error", 1]);
    }
    expect(reached).toEqual([]);
  });

  test("a provider whose calls can't go through the layer's own fetch, which would follow one, takes no address but its own", async () => {
    r = rig();
    await expect(r.layer.api.save({ name: "Gemini", provider: "google", auth: "key", baseUrl: "https://proxy.example.com/v1beta", model: "gemini-2.5-flash" }, SERVER_KEY)).rejects.toThrow(
      "A Google Gemini connection goes to its provider's own address: its calls can't be kept from following a redirect, which would take its key elsewhere. Leave the address out.",
    );
    expect(r.store.writes).toEqual([]);
  });
});

describe("a stream that goes silent", () => {
  test("is ended once its answer has begun and nothing more comes for the wait, in words that say so", async () => {
    const held = heldStream();
    r = rig({ script: () => held.response });
    const agent = await heldClaude(r);
    const stream = await agent.streamFn(agent.model, normalizeContext({ messages: ASK }), {});
    const events = stream[Symbol.asyncIterator]();
    await held.send(event(...ANSWER.slice(0, 3)));
    await untilText(events);
    r.clock.advance(5 * 60_000);
    const answer = await stream.result();
    expect(answer.stopReason).toBe("error");
    expect(answer.errorMessage).toBe('The model went silent: nothing came from its server for 5 minutes after its answer began, so the stream was ended. The setting "Silent answer ends after" says how long an answer may go silent.');
    // What had come before the silence is kept: the answer's first block, never ended.
    expect(answer.content).toEqual([{ type: "text", text: "The mill is closed." }]);
  });

  test("a model slow to begin is left to begin, a keep-alive counts as life, and the wait is the one the layer is given", async () => {
    const held = heldStream();
    r = rig({ script: () => held.response, silentMs: 30_000, settingWords: (wait) => `The harbour's "${wait}"` });
    const agent = await heldClaude(r);
    const stream = await agent.streamFn(agent.model, normalizeContext({ messages: ASK }), {});
    const events = stream[Symbol.asyncIterator]();
    // The call is open and the model still reads its prompt: nothing waits on it yet, however long that takes.
    await held.send(event(...ANSWER.slice(0, 1)) + PING);
    r.clock.advance(10 * 30_000);
    expect(r.clock.pending).toBe(0);
    await held.send(event(...ANSWER.slice(1, 3)));
    await untilText(events);
    // Twenty seconds in a keep-alive comes, and twenty seconds after it the wait looks again: the stream is alive.
    r.clock.advance(20_000);
    await held.send(PING);
    r.clock.advance(20_000);
    expect(r.clock.pending).toBe(1);
    await held.send(event(...ANSWER.slice(3)));
    held.end();
    const answer = await stream.result();
    expect(answer.stopReason).toBe("stop");
    expect(answer.content).toEqual([{ type: "text", text: "The mill is closed." }]);
    // The call's end lets its wait go.
    expect(r.clock.pending).toBe(0);
  });

  test("a wait of none, or of what isn't a length, sets no limit at all", async () => {
    for (const silentMs of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const faux = fauxProvider({ provider: "groq", models: [{ id: "faux-1" }], tokenSize: { min: 1, max: 1 } });
      faux.setResponses([fauxAssistantMessage("The mill is closed.")]);
      const made = rig({ providers: [faux.provider], silentMs });
      const saved = await made.layer.api.save({ name: "Groq", provider: "groq", auth: "key", model: "faux-1" }, "gsk_0123456789abcdefghij");
      const agent = await made.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" });
      const stream = await agent.streamFn(agent.model, normalizeContext({ messages: ASK }), {});
      // What waits while the answer streams.
      const waiting: number[] = [];
      for await (const _ of stream) waiting.push(made.clock.pending);
      await made.done();
      expect({ wait: String(silentMs), timers: Math.max(...waiting) }).toEqual({ wait: String(silentMs), timers: 0 });
    }
  });
});

describe("a provider that never answers", () => {
  test("a connection's test says so after the provider wait, naming that setting", async () => {
    r = rig({ script: () => new Promise<Response>(() => undefined), askMs: 90_000 });
    const saved = await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const testing = r.layer.api.test(saved.id);
    await r.clock.idle();
    r.clock.advance(90_000);
    expect(await testing).toEqual({ ok: false, ms: 90_000, error: 'The provider didn\'t answer within 90 seconds. The setting "Provider wait" says how long to wait for it.' });
  });

  test("a test that is answered says by which model, and sends the text it was given", async () => {
    r = rig({ script: () => new Response(anthropicStream(anthropicTurn({ model: "claude-sonnet-4-5-20250929", text: "Ready." })), { status: 200, headers: { "content-type": "text/event-stream" } }) });
    const saved = await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect(await r.layer.api.test(saved.id)).toMatchObject({ ok: true, model: "claude-sonnet-4-5-20250929" });
    expect(JSON.stringify(r.sent[0]?.body)).toContain("Answer with one word.");
    await r.done();
    r = rig({ script: () => failed(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    const refused = await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect(await r.layer.api.test(refused.id)).toMatchObject({ ok: false, error: "401: invalid x-api-key (authentication_error)" });
  });
});
