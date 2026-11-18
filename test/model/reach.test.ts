// What leaves with a call goes where its connection says, and nowhere else: no variable of the
// environment signs it, steers it or adds to it; no redirect takes its key or its headers to another
// address, on any provider (one whose calls can't go through the layer's own fetch takes no address
// but its provider's own); and a stream that goes silent once its answer has begun is ended in words
// that say so, while a model slow to begin is left to begin. Each of the layer's waits is its setting,
// read as it is used, and its words name the setting as the list of settings does. Every wait runs on
// the rig's clock.

import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import { SETTINGS } from "rp-harness/helpers";
import type { Scope } from "../../src/contract";
import type { AgentModel } from "../../src/model";
import { failureOf } from "../../src/model/failure";
import { KINDS } from "../../src/model/kinds";
import type { FakeClock } from "../../src/testing/rig";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, call, failed, rig, USER } from "./support";

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

/** An Anthropic connection's agent model, its API answering with `held`; with `scope`, an agent of that run. */
async function heldClaude(made: Rig, scope?: Scope): Promise<AgentModel> {
  const saved = await made.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
  return made.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off", ...(scope !== undefined ? { scope } : {}) });
}

/** Whether a promise has settled once everything that can happen without the clock moving has happened. */
async function settledBy(clock: FakeClock, promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await clock.idle();
  return settled;
}

/** A chat of the user's, whose own config file the tests write. */
const QUAY: Scope = { user: USER, chat: "chat-quay", session: "s1", turn: "t1" };

/** The name a setting has in the exported list. */
function listedName(key: string): string {
  const name = SETTINGS.find((def) => def.key === key)?.name;
  if (name === undefined) throw new Error(`${key} is not a listed setting.`);
  return name;
}

/**
 * Each of the layer's three waits run until it runs out, held to end at `waits` (in milliseconds)
 * and not a millisecond before: a stream gone silent for an agent of `scope` (none: no chat in view),
 * a connection's test its provider never answers, a sign-in left open. Gives the words of each.
 */
async function waitsRunOut(made: Rig, waits: { silent: number; provider: number; signIn: number }, scope?: Scope): Promise<{ silent: string; provider: string; signIn: string }> {
  const agent = await heldClaude(made, scope);
  const stream = await agent.streamFn(agent.model, normalizeContext({ messages: ASK }), {});
  const events = stream[Symbol.asyncIterator]();
  await silentHeld.send(event(...ANSWER.slice(0, 3)));
  await untilText(events);
  const answer = stream.result();
  made.clock.advance(waits.silent - 1);
  expect({ wait: "silent", settled: await settledBy(made.clock, answer) }).toEqual({ wait: "silent", settled: false });
  made.clock.advance(1);
  const silent = (await answer).errorMessage ?? "";

  const connection = (await made.layer.api.list(USER)).connections[0]!.id;
  const testing = made.layer.api.test(USER, connection);
  await made.clock.idle();
  made.clock.advance(waits.provider - 1);
  expect({ wait: "provider", settled: await settledBy(made.clock, testing) }).toEqual({ wait: "provider", settled: false });
  made.clock.advance(1);
  const tested = await testing;
  const provider = tested.ok ? "answered" : tested.error;

  const flow = await made.layer.api.signIn(USER).start("anthropic");
  made.clock.advance(waits.signIn - 1);
  expect((await made.layer.api.signIn(USER).state("anthropic")).flow).toBe(flow.flow);
  made.clock.advance(1);
  const signIn = (await made.layer.api.signIn(USER).state("anthropic")).ended ?? "still open";
  return { silent, provider, signIn };
}

/** The held stream `waitsRunOut`'s silent call is answered with; every later request is never answered. */
let silentHeld = heldStream();
/** A rig whose first call is answered by a new `silentHeld`, and whose other requests are never answered. */
function waitsRig(options: Parameters<typeof rig>[0] = {}): Rig {
  silentHeld = heldStream();
  let answered = false;
  return rig({
    script: () => {
      if (answered) return new Promise<Response>(() => undefined);
      answered = true;
      return silentHeld.response;
    },
    ...options,
  });
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
    const listing = await made.layer.api.save(USER, { name: "Moved", provider: "openai-compatible", auth: "key", ...moved }, SERVER_KEY);
    const redirected = "the server answered with a redirect to another address, which isn't followed, so that the connection's key and headers never go with it: give the connection the address it moved to.";
    await expect(made.layer.api.models(USER, listing.id)).rejects.toThrow(`The server didn't list its models: ${redirected}`);
    expect((await call(await made.layer.agentModel({ user: USER, connectionId: listing.id, model: null, effort: "off" }), ASK)).errorMessage).toBe(`The call wasn't made: ${redirected}`);
    const offered = KINDS.filter((kind) => kind.ownAddress !== true);
    expect(offered.map((kind) => kind.id)).toEqual(["anthropic", "openai", "openrouter", "deepseek", "xai", "groq", "mistral", "openai-compatible", "anthropic-compatible"]);
    for (const kind of offered) {
      const saved = await made.layer.api.save(USER, { name: kind.name, provider: kind.id, auth: "key", ...moved }, SERVER_KEY);
      const before = asked;
      const answer = await call(await made.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" }), ASK);
      // The call went out, met the redirect, and went no further.
      expect([kind.id, answer.stopReason, asked - before]).toEqual([kind.id, "error", 1]);
    }
    expect(reached).toEqual([]);
  });

  test("a provider whose calls can't go through the layer's own fetch, which would follow one, takes no address but its own", async () => {
    r = rig();
    await expect(r.layer.api.save(USER, { name: "Gemini", provider: "google", auth: "key", baseUrl: "https://proxy.example.com/v1beta", model: "gemini-2.5-flash" }, SERVER_KEY)).rejects.toThrow(
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
    expect(answer.errorMessage).toBe('The model went silent: nothing came from its server for 5 minutes after its answer began, so the stream was ended. The setting "Silent answer ends after" on the Settings page says how long an answer may go silent.');
    // What had come before the silence is kept: the answer's first block, never ended.
    expect(answer.content).toEqual([{ type: "text", text: "The mill is closed." }]);
  });

  test("a model slow to begin is left to begin within its wait, a keep-alive counts as life once it has begun, and the wait is the one its setting gives", async () => {
    const held = heldStream();
    r = rig({ script: () => held.response, global: "calls:\n  silentAfterSeconds: 30\n" });
    const agent = await heldClaude(r);
    const stream = await agent.streamFn(agent.model, normalizeContext({ messages: ASK }), {});
    const events = stream[Symbol.asyncIterator]();
    // The call is open and the model still reads its prompt: only the wait for its answer to begin holds it, four minutes into five.
    await held.send(event(...ANSWER.slice(0, 1)) + PING);
    r.clock.advance(4 * 60_000);
    expect(r.clock.pending).toBe(1);
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

  test("a call sent that has had no first piece of its answer for its wait is ended, as a call that timed out, in words that say so; a wait of none waits for ever", async () => {
    const held = heldStream();
    r = rig({ script: () => held.response });
    const agent = await heldClaude(r);
    const stream = await agent.streamFn(agent.model, normalizeContext({ messages: ASK }), {});
    // The provider takes the call and sends its start and keep-alives, and nothing of an answer.
    await held.send(event(...ANSWER.slice(0, 1)) + PING);
    r.clock.advance(5 * 60_000);
    const answer = await stream.result();
    expect([answer.stopReason, answer.errorMessage]).toEqual(["error", 'The model gave no answer: nothing of one came for 5 minutes after the call was sent, so the call was ended. The setting "Unanswered call ends after" on the Settings page says how long a call may wait for its answer to begin.']);
    expect(failureOf(answer.errorMessage ?? "", { silent: true }).kind).toBe("timeout");
    await r.done();

    const open = heldStream();
    r = rig({ script: () => open.response, global: "calls:\n  unansweredAfterSeconds: ~\n" });
    const patient = await heldClaude(r);
    await patient.streamFn(patient.model, normalizeContext({ messages: ASK }), {});
    await open.send(event(...ANSWER.slice(0, 1)));
    r.clock.advance(60 * 60_000);
    expect(r.clock.pending).toBe(0);
  });

  test("a wait of none sets no limit at all: set so in the global file, or in a chat's over a global wait, for that chat's agents", async () => {
    const none = "calls:\n  silentAfterSeconds: ~\n  unansweredAfterSeconds: ~\n";
    for (const configs of [{ global: none }, { global: "calls:\n  silentAfterSeconds: 30\n  unansweredAfterSeconds: 30\n", chats: { [QUAY.chat]: none } }]) {
      const faux = fauxProvider({ provider: "groq", models: [{ id: "faux-1" }], tokenSize: { min: 1, max: 1 } });
      faux.setResponses([fauxAssistantMessage("The mill is closed.")]);
      const made = rig({ providers: [faux.provider], ...configs });
      const saved = await made.layer.api.save(USER, { name: "Groq", provider: "groq", auth: "key", model: "faux-1" }, "gsk_0123456789abcdefghij");
      const agent = await made.layer.agentModel({ user: USER, scope: QUAY, connectionId: saved.id, model: null, effort: "off" });
      const stream = await agent.streamFn(agent.model, normalizeContext({ messages: ASK }), {});
      // What waits while the answer streams.
      const waiting: number[] = [];
      for await (const _ of stream) waiting.push(made.clock.pending);
      await made.done();
      expect({ configs, timers: Math.max(...waiting) }).toEqual({ configs, timers: 0 });
    }
  });
});

describe("each wait is its setting", () => {
  test("set in the global file, a silent stream, a slow test call and an open sign-in end at the set time on the fake clock and not before; a chat's own silent wait holds for that chat's agents", async () => {
    r = waitsRig({ global: "calls:\n  silentAfterSeconds: 40\n  providerWaitSeconds: 20\n  signInOpenSeconds: 70\n", chats: { [QUAY.chat]: "calls:\n  silentAfterSeconds: 15\n" } });
    const shared = await waitsRunOut(r, { silent: 40_000, provider: 20_000, signIn: 70_000 });
    expect(shared).toEqual({
      silent: 'The model went silent: nothing came from its server for 40 seconds after its answer began, so the stream was ended. The setting "Silent answer ends after" on the Settings page says how long an answer may go silent.',
      provider: 'The provider didn\'t answer within 20 seconds. The setting "Provider wait" on the Settings page says how long to wait for it.',
      signIn: 'The Anthropic sign-in didn\'t finish: The sign-in was left open longer than 70 seconds. The setting "Sign-in stays open" on the Settings page says how long a sign-in stays open. Start it again.',
    });
    await r.done();
    // A chat's file sets the silent wait for its own agents; the waits with no chat in view are the global file's still.
    r = waitsRig({ global: "calls:\n  silentAfterSeconds: 40\n  providerWaitSeconds: 20\n  signInOpenSeconds: 70\n", chats: { [QUAY.chat]: "calls:\n  silentAfterSeconds: 15\n  providerWaitSeconds: 5\n" } });
    const chat = await waitsRunOut(r, { silent: 15_000, provider: 20_000, signIn: 70_000 }, QUAY);
    expect(chat.silent).toStartWith("The model went silent: nothing came from its server for 15 seconds");
    // The chat's provider wait is read from no file of a chat's: it is passed over, and said so.
    expect(r.settingsLog).toContain("A setting is set in a file it is not read from; the value there is passed over.");
  });

  test("the words of each wait that ran out carry the name its setting has in the exported list", async () => {
    r = waitsRig();
    const words = await waitsRunOut(r, { silent: 5 * 60_000, provider: 60_000, signIn: 10 * 60_000 });
    expect(words.silent).toContain(`The setting "${listedName("calls.silentAfterSeconds")}" on the Settings page`);
    expect(words.provider).toContain(`The setting "${listedName("calls.providerWaitSeconds")}" on the Settings page`);
    expect(words.signIn).toContain(`The setting "${listedName("calls.signInOpenSeconds")}" on the Settings page`);
  });
});

describe("a provider that never answers", () => {
  test("a connection's test says so after the provider wait, naming that setting", async () => {
    r = rig({ script: () => new Promise<Response>(() => undefined), global: "calls:\n  providerWaitSeconds: 90\n" });
    const saved = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const testing = r.layer.api.test(USER, saved.id);
    await r.clock.idle();
    r.clock.advance(90_000);
    expect(await testing).toEqual({ ok: false, ms: 90_000, error: 'The provider didn\'t answer within 90 seconds. The setting "Provider wait" on the Settings page says how long to wait for it.' });
  });

  test("a test that is answered says by which model, and sends the text it was given", async () => {
    r = rig({ script: () => new Response(anthropicStream(anthropicTurn({ model: "claude-sonnet-4-5-20250929", text: "Ready." })), { status: 200, headers: { "content-type": "text/event-stream" } }) });
    const saved = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect(await r.layer.api.test(USER, saved.id)).toMatchObject({ ok: true, model: "claude-sonnet-4-5-20250929" });
    expect(JSON.stringify(r.sent[0]?.body)).toContain("Answer with one word.");
    await r.done();
    r = rig({ script: () => failed(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }) });
    const refused = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect(await r.layer.api.test(USER, refused.id)).toMatchObject({ ok: false, error: "401: invalid x-api-key (authentication_error)" });
  });
});

describe("a secret in a provider's words", () => {
  test("a five-character header value in a provider's error words never reaches the words that leave the layer", async () => {
    const TOKEN = "q7Rk2";
    // A gateway that refuses the call and says back the short token it was sent, as a word of its own and inside a longer one.
    r = rig({ script: (sent) => failed(403, { error: { message: `Gateway token ${sent.headers["x-gateway-token"] ?? ""} is unknown (sent: "${sent.headers["x-gateway-token"] ?? ""}"); try x${TOKEN}y.`, type: "permission_error" } }) });
    const saved = await r.layer.api.save(USER, { name: "Gateway", provider: "openai-compatible", auth: "key", baseUrl: "https://gateway.example.com/v1", model: "served-model", headers: { "x-gateway-token": TOKEN } }, SERVER_KEY);
    const tested = await r.layer.api.test(USER, saved.id);
    expect(r.sent.map((s) => s.headers["x-gateway-token"])).toEqual([TOKEN]);
    // Shorter than calls.minSecretChars, it is taken out where it stands alone; a longer word it is part of is another word.
    expect(tested).toMatchObject({ ok: false, error: `403: Gateway token [secret] is unknown (sent: "[secret]"); try x${TOKEN}y. (permission_error)` });
    // Set lower, the floor has a five-character secret looked for anywhere.
    r.configs.global = "calls:\n  minSecretChars: 5\n";
    expect(await r.layer.api.test(USER, saved.id)).toMatchObject({ ok: false, error: `403: Gateway token [secret] is unknown (sent: "[secret]"); try x[secret]y. (permission_error)` });
  });
});
