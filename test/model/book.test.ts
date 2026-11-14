// The connections as the Connections page keeps them, through the host's two documents: a key kept
// apart from its connection and never shown, only whether it is set and its last four characters;
// what can't be saved said in words; what was stored for one server never going to another; a
// sign-in's token only to its provider's own address; and documents a hand edit broke never written
// over.

import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectionInput } from "../../src/contract";
import type { Rig } from "./support";
import { MemoryStore, anthropicStream, anthropicTurn, call, eventStream, failed, json, rig } from "./support";

const KEY = "sk-ant-api03-Ilse0123456789abcdefWXYZ";
const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";
const OPENAI_KEY = "sk-proj-0123456789abcdefghijklmnop";
const ROUTER_KEY = "sk-or-v1-0123456789abcdefghijklmn";
const GATEWAY = "gw-token-Okoro0123456789abcdef";
const ASK = [{ role: "user" as const, content: "Where is Ilse?", timestamp: 1 }];

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** What a save, or anything else, answered: its words when it refused. */
async function wordsOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    (answer) => `answered ${JSON.stringify(answer)}`,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("the connections", () => {
  test("keep a key apart from its connection, and show only that it is set and its last four characters", async () => {
    r = rig();
    const view = await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect(view).toMatchObject({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", default: true, key: { set: true, last4: "WXYZ" } });
    const list = await r.layer.api.list();
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(list.providers.map((p) => p.id)).toEqual(["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "groq", "mistral", "openai-compatible", "anthropic-compatible"]);
    expect(JSON.stringify(r.store.connectionsDoc)).not.toContain(KEY);
    expect(r.store.secretsDoc).toEqual({ v: 1, keys: { id1: KEY }, signins: {} });
  });

  test("are read back by a layer made again over the same documents", async () => {
    const store = new MemoryStore();
    r = rig({ store });
    await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", effort: "low", headers: { "x-team": "harbour" }, serialTools: true, messageThreads: true, retries: 4, limits: { "claude-sonnet-4-5": { contextWindow: 100_000 } } }, KEY);
    await r.done();
    r = rig({ store });
    expect((await r.layer.api.list()).connections).toEqual([
      { id: "id1", name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", effort: "low", serialTools: true, messageThreads: true, retries: 4, limits: { "claude-sonnet-4-5": { contextWindow: 100_000 } }, headers: [{ name: "x-team", set: true }], default: true, key: { set: true, last4: "WXYZ" } },
    ]);
  });

  test("the default is the first one saved until another is chosen, and none once it is taken away", async () => {
    r = rig();
    const first = await r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const second = await r.layer.api.save({ name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1/", model: "served-model" });
    expect(second.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect((await r.layer.api.list()).default).toBe(first.id);
    await r.layer.api.setDefault(second.id);
    expect((await r.layer.api.limits(null)).contextWindow).toBeNull();
    await r.layer.api.remove(second.id);
    expect((await r.layer.api.list()).default).toBeNull();
    await expect(r.layer.api.limits(null)).rejects.toThrow("There is no default connection");
    expect((await r.layer.api.list()).connections.map((c) => c.id)).toEqual([first.id]);
  });

  test("take a key away when asked to, and from a connection that no longer signs with one", async () => {
    r = rig();
    const fields: ConnectionInput = { name: "Claude", provider: "anthropic", auth: "key" };
    const saved = await r.layer.api.save(fields, KEY);
    expect((await r.layer.api.save({ ...fields, id: saved.id })).key).toEqual({ set: true, last4: "WXYZ" });
    expect((await r.layer.api.save({ ...fields, id: saved.id }, null)).key).toEqual({ set: false, last4: null });
    await r.layer.api.save({ ...fields, id: saved.id }, KEY);
    expect((await r.layer.api.save({ ...fields, id: saved.id, auth: "signin" })).key).toBeNull();
    expect(JSON.stringify(r.store.secretsDoc)).not.toContain(KEY);
  });

  test("say in words what they can't save, and save none of it", async () => {
    r = rig();
    const tries: [ConnectionInput, string][] = [
      [{ name: "", provider: "anthropic", auth: "key" }, "Give the connection a name."],
      [{ name: "X", provider: "bedrock", auth: "key" }, `"bedrock" isn't a provider that is offered.`],
      [{ name: "X", provider: "deepseek", auth: "signin" }, "DeepSeek connections can't use a sign-in."],
      [{ name: "X", provider: "openai-compatible", auth: "none" }, "An OpenAI-compatible connection needs the server's address."],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "not an address" }, "That isn't an address: give one such as https://example.com/v1."],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "ftp://files.example.com" }, "An address starts with http:// or https://, not ftp://."],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "https://proxy.example.com/v1?team=harbour" }, `Give the address without what follows "?" or "#": https://proxy.example.com/v1`],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "https://okoro:hunter2@proxy.example.com/v1" }, "An address can't hold a name or a password: give the key in its own field, or a header."],
      [{ name: "X", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080", api: "anthropic-messages" }, "OpenAI-compatible connections speak openai-completions or openai-responses, not anthropic-messages."],
      [{ name: "X", provider: "anthropic", auth: "key", limits: { "claude-sonnet-4-5": { contextWindow: -5 } } }, "A model's window and longest reply are whole numbers of tokens above 0."],
      [{ name: "X", provider: "anthropic", auth: "key", retries: 1.5 }, "Retries are a whole number: 0 for none."],
      // A whole header pasted where its name goes: the words don't repeat it, credential and all.
      [{ name: "X", provider: "anthropic", auth: "key", headers: { "x-api-key: sk-pasted-0123456789abcdef": "x" } }, "A header's name is a single word, such as x-team, with no space or colon in it: give its value in its own field."],
      [{ name: "X", provider: "anthropic", auth: "key", headers: { "x-team": "harbour\r\nx-api-key: other" } }, `The header "x-team" can't hold a line break.`],
      [{ id: "gone", name: "X", provider: "anthropic", auth: "key" }, "That connection is no longer there: reload the page."],
    ];
    for (const [input, words] of tries) expect(await wordsOf(r.layer.api.save(input))).toBe(words);
    await expect(r.layer.api.save({ name: "X", provider: "anthropic", auth: "key" }, "  ")).rejects.toThrow("A key can't be empty");
    await expect(r.layer.api.save({ name: "X", provider: "anthropic", auth: "key" }, "sk-0123")).rejects.toThrow("A key needs 8 characters at least");
    await expect(r.layer.api.setDefault("gone")).rejects.toThrow("That connection is no longer there");
    expect((await r.layer.api.list()).connections).toEqual([]);
    expect(r.store.writes).toEqual([]);
  });

  test("a key of 8 characters or more, and a header's value of any length, are taken out of what a server says back", async () => {
    // A server that refuses every call and says back the key and the headers it was sent, as some do.
    r = rig({ script: (sent) => failed(401, { error: { message: `Unknown key ${sent.headers.authorization ?? ""} with token ${sent.headers["x-gateway-token"] ?? ""} for ${sent.headers["x-portkey-provider"] ?? ""}.`, type: "invalid_request_error" } }) });
    const saved = await r.layer.api.save({ name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model", headers: { "x-portkey-provider": "openai", "x-gateway-token": "gw-01234" } }, "sk-01234");
    const tested = await r.layer.api.test(saved.id);
    expect(r.sent.map((s) => [s.headers.authorization, s.headers["x-gateway-token"], s.headers["x-portkey-provider"]])).toEqual([["Bearer sk-01234", "gw-01234", "openai"]]);
    expect(tested).toMatchObject({ ok: false, error: "401: Unknown key Bearer [secret] with token [secret] for openai. (invalid_request_error)" });
  });

  test("documents a layer can't read stop it in words, and are never written over", async () => {
    const store = new MemoryStore();
    store.connectionsDoc = { version: "another app's", connections: [] };
    r = rig({ store });
    await expect(r.layer.api.list()).rejects.toThrow("The saved connections aren't a list this build reads: fix or remove them, then start again.");
    await expect(r.layer.api.save({ name: "Claude", provider: "anthropic", auth: "key" }, KEY)).rejects.toThrow("aren't a list this build reads");
    await expect(r.layer.agentModel({ connectionId: null, model: null })).rejects.toThrow("aren't a list this build reads");
    expect(store.writes).toEqual([]);
  });

  test("a saved connection a save would refuse is left out, with a line in the log that says why", async () => {
    const store = new MemoryStore();
    store.connectionsDoc = { v: 1, default: "c1", connections: [{ id: "c1", name: "Local", provider: "openai-compatible", auth: "none", model: "served-model" }, { id: "c2", name: 7 }] };
    r = rig({ store });
    expect((await r.layer.api.list()).connections).toEqual([]);
    expect(r.logs).toEqual(['left out the saved connection "Local": An OpenAI-compatible connection needs the server\'s address.', "left out a saved connection this build can't read"]);
    expect(store.writes).toEqual([]);
  });
});

describe("what was stored for one server goes to no other", () => {
  test("a new origin for a connection's address takes its key and its headers' values away; another path at the same origin keeps them", async () => {
    r = rig({ script: () => json({ data: [{ id: "served-model" }] }) });
    const fields = { name: "Proxy", provider: "openai-compatible", auth: "key", model: "served-model" } as const;
    const saved = await r.layer.api.save({ ...fields, baseUrl: "https://proxy.example.com/v1", headers: { "x-gateway-token": GATEWAY } }, SERVER_KEY);
    expect(await r.layer.api.save({ ...fields, id: saved.id, baseUrl: "https://proxy.example.com/v2" })).toMatchObject({ key: { set: true, last4: "mnop" }, headers: [{ name: "x-gateway-token", set: true }] });
    expect(await r.layer.api.save({ ...fields, id: saved.id, baseUrl: "https://elsewhere.example/v1" })).toMatchObject({ key: { set: false, last4: null }, headers: [{ name: "x-gateway-token", set: false }] });
    expect(await r.layer.api.models(saved.id)).toEqual([{ id: "served-model", name: "served-model" }]);
    expect((await call(await r.layer.agentModel({ connectionId: saved.id, model: null }), ASK)).errorMessage).toBe('The connection "Proxy" has no key: add one on the Connections page.');
    expect(r.sent.map((s) => s.url)).toEqual(["https://elsewhere.example/v1/models"]);
    expect(JSON.stringify(r.sent)).not.toContain(SERVER_KEY);
    expect(JSON.stringify(r.sent)).not.toContain(GATEWAY);
    expect(JSON.stringify(r.store.secretsDoc)).not.toContain(SERVER_KEY);
    expect(JSON.stringify(r.store.connectionsDoc)).not.toContain(GATEWAY);
  });

  test("a connection whose provider changes keeps no key: an OpenAI key never goes to OpenRouter", async () => {
    r = rig();
    const saved = await r.layer.api.save({ name: "Mine", provider: "openai", auth: "key", model: "gpt-5" }, OPENAI_KEY);
    expect((await r.layer.api.save({ id: saved.id, name: "Mine", provider: "openrouter", auth: "key", model: "openai/gpt-5" })).key).toEqual({ set: false, last4: null });
    expect((await call(await r.layer.agentModel({ connectionId: null, model: null }), ASK)).errorMessage).toBe('The connection "Mine" has no key: add one on the Connections page.');
    expect(r.sent).toEqual([]);
    expect(JSON.stringify(r.store.secretsDoc)).not.toContain(OPENAI_KEY);
    // A key that comes with the change is the new provider's own.
    expect((await r.layer.api.save({ id: saved.id, name: "Mine", provider: "openrouter", auth: "key" }, ROUTER_KEY)).key).toEqual({ set: true, last4: "klmn" });
  });

  test("a connection that signs in goes to its provider's own address: one given another is refused when saved, and left out when read", async () => {
    r = rig();
    expect(await wordsOf(r.layer.api.save({ name: "Claude sign-in", provider: "anthropic", auth: "signin", baseUrl: "https://elsewhere.example", model: "claude-sonnet-4-5" }))).toBe("A connection that signs in to Anthropic goes to Anthropic's own address: leave the address out.");
    await r.done();
    // Written by hand beside a sign-in already held: the connection is left out, and the token goes nowhere.
    const store = new MemoryStore();
    store.connectionsDoc = { v: 1, default: "c1", connections: [{ id: "c1", name: "Claude sign-in", provider: "anthropic", auth: "signin", baseUrl: "https://elsewhere.example", model: "claude-sonnet-4-5" }] };
    store.secretsDoc = { v: 1, keys: {}, signins: { anthropic: { type: "oauth", access: "sk-ant-oat01-held-0123456789abcdef", refresh: "sk-ant-ort01-held-0123456789abcdef", expires: 4_102_444_800_000 } } };
    r = rig({ store });
    expect((await r.layer.api.list()).connections).toEqual([]);
    expect(r.logs).toContain(`left out the saved connection "Claude sign-in": A connection that signs in to Anthropic goes to Anthropic's own address: leave the address out.`);
    expect(await r.layer.api.test("c1")).toMatchObject({ ok: false, error: "This call's connection is no longer there: pick another on the Connections page." });
    expect(r.sent).toEqual([]);
  });
});

describe("a connection's headers", () => {
  test("the page sees each header's name and whether it has a value, never the value; a save keeps, changes or takes each away as it says", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) });
    const fields = { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" } as const;
    const saved = await r.layer.api.save({ ...fields, headers: { "x-gateway-token": GATEWAY, "x-team": "harbour" } }, KEY);
    expect(saved.headers).toEqual([
      { name: "x-gateway-token", set: true },
      { name: "x-team", set: true },
    ]);
    expect(JSON.stringify(await r.layer.api.list())).not.toContain(GATEWAY);
    // Null keeps the value stored under a name; a text changes it; absent keeps them all.
    await r.layer.api.save({ ...fields, id: saved.id, headers: { "x-gateway-token": null, "x-team": "quay" } });
    await r.layer.api.save({ ...fields, id: saved.id });
    await call(await r.layer.agentModel({ connectionId: saved.id, model: null, effort: "off" }), ASK);
    expect([r.sent[0]?.headers["x-gateway-token"], r.sent[0]?.headers["x-team"]]).toEqual([GATEWAY, "quay"]);
    // A name left out is taken away, and null takes them all.
    expect((await r.layer.api.save({ ...fields, id: saved.id, headers: { "x-team": null } })).headers).toEqual([{ name: "x-team", set: true }]);
    expect((await r.layer.api.save({ ...fields, id: saved.id, headers: null })).headers).toBeUndefined();
  });
});
