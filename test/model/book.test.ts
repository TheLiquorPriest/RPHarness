// The connections as the Connections page keeps them, through the host's two documents: a key and its
// headers' values kept with the secrets, apart from the connection, and never shown, only whether
// each is set and whether it waits; what can't be saved said in words; a key and its headers' values
// going only to the place they were given for, and waiting for the host's switches wherever a save or
// a hand edit moved their connection or no place was kept for them; a connection made under a given
// id; a secrets document a host marks as not to be written; a sign-in's token only to its provider's
// own address; a hand edit made while the layer runs used from the next turn and kept by the next
// save; and a document a hand edit broke said in words and never written over.

import { afterEach, describe, expect, test } from "bun:test";
import { placeOf } from "rp-harness/helpers";
import type { ConnectionInput, SecretsDoc, UserScope } from "../../src/contract";
import type { Rig } from "./support";
import { MemoryStore, Switches, anthropicStream, anthropicTurn, bodyOf, call, chatStream, chunk, eventStream, failed, json, rig, USER } from "./support";

const KEY = "sk-ant-api03-Ilse0123456789abcdefWXYZ";
const SERVER_KEY = "sk-proxy-0123456789abcdefghijklmnop";
const OPENAI_KEY = "sk-proj-0123456789abcdefghijklmnop";
const ROUTER_KEY = "sk-or-v1-0123456789abcdefghijklmn";
const GATEWAY = "gw-token-Okoro0123456789abcdef";
const ASK = [{ role: "user" as const, content: "Where is Ilse?", timestamp: 1 }];

/** What the log and a turn's start say of the connection "Proxy", moved to another address than its key and headers' values were given for. */
const MOVED_NOTE = `the key and headers' values of the saved connection "Proxy" were given for another provider or address than it now goes to: kept, and sent nowhere until the connection is switched on there from the server's command line`;
/** What a call on it ends in. */
const MOVED_WAITS = `The connection "Proxy" now goes to another provider or address than its key and headers' values were given for, so the call wasn't made: nothing of them is sent until the connection is switched on there from the server's command line.`;

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
  test("keep a key apart from its connection, and show only that it is set and whether it waits", async () => {
    r = rig();
    const view = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect(view).toMatchObject({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", default: true, key: { set: true, waiting: false } });
    const list = await r.layer.api.list(USER);
    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(list.providers.map((p) => p.id)).toEqual(["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "groq", "mistral", "openai-compatible", "anthropic-compatible"]);
    expect(JSON.stringify(r.store.connectionsDoc)).not.toContain(KEY);
    expect(r.store.secretsDoc).toEqual({ v: 1, keys: { id1: KEY }, signins: {}, places: { id1: '["anthropic",null]' } });
  });

  test("a connection's view holds no character of its key", async () => {
    r = rig();
    const view = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const list = await r.layer.api.list(USER);
    expect([view.key, list.connections[0]?.key]).toEqual([
      { set: true, waiting: false },
      { set: true, waiting: false },
    ]);
    // Not its last four characters, nor any four of them in a row.
    const shown = JSON.stringify([view, list.connections]);
    for (let at = 0; at + 4 <= KEY.length; at += 1) expect(shown).not.toContain(KEY.slice(at, at + 4));
  });

  test("are read back by a layer made again over the same documents", async () => {
    const store = new MemoryStore();
    r = rig({ store });
    await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", effort: "low", headers: { "x-team": "harbour" }, serialTools: true, messageThreads: true, retries: 4, limits: { "claude-sonnet-4-5": { contextWindow: 100_000 } } }, KEY);
    await r.done();
    r = rig({ store });
    expect((await r.layer.api.list(USER)).connections).toEqual([
      { id: "id1", name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", effort: "low", serialTools: true, messageThreads: true, retries: 4, limits: { "claude-sonnet-4-5": { contextWindow: 100_000 } }, headers: [{ name: "x-team", set: true }], default: true, key: { set: true, waiting: false } },
    ]);
  });

  test("the default is the first one saved until another is chosen, and none once it is taken away", async () => {
    r = rig();
    const first = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const second = await r.layer.api.save(USER, { name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1/", model: "served-model" });
    expect(second.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect((await r.layer.api.list(USER)).default).toBe(first.id);
    await r.layer.api.setDefault(USER, second.id);
    expect((await r.layer.api.limits(USER, null)).contextWindow).toBeNull();
    await r.layer.api.remove(USER, second.id);
    expect((await r.layer.api.list(USER)).default).toBeNull();
    await expect(r.layer.api.limits(USER, null)).rejects.toThrow("There is no default connection");
    expect((await r.layer.api.list(USER)).connections.map((c) => c.id)).toEqual([first.id]);
  });

  test("take a key away when asked to, and from a connection that no longer signs with one", async () => {
    r = rig();
    const fields: ConnectionInput = { name: "Claude", provider: "anthropic", auth: "key" };
    const saved = await r.layer.api.save(USER, fields, KEY);
    expect((await r.layer.api.save(USER, { ...fields, id: saved.id })).key).toEqual({ set: true, waiting: false });
    expect((await r.layer.api.save(USER, { ...fields, id: saved.id }, null)).key).toEqual({ set: false, waiting: false });
    await r.layer.api.save(USER, { ...fields, id: saved.id }, KEY);
    expect((await r.layer.api.save(USER, { ...fields, id: saved.id, auth: "signin" })).key).toBeNull();
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
    for (const [input, words] of tries) expect(await wordsOf(r.layer.api.save(USER, input))).toBe(words);
    await expect(r.layer.api.save(USER, { name: "X", provider: "anthropic", auth: "key" }, "  ")).rejects.toThrow("A key can't be empty");
    await expect(r.layer.api.save(USER, { name: "X", provider: "anthropic", auth: "key" }, "sk-0123")).rejects.toThrow("A key needs 8 characters at least");
    await expect(r.layer.api.setDefault(USER, "gone")).rejects.toThrow("That connection is no longer there");
    expect((await r.layer.api.list(USER)).connections).toEqual([]);
    expect(r.store.writes).toEqual([]);
  });

  test("a key, and a header's value of any length, are taken out of what a server says back", async () => {
    // A server that refuses every call and says back the key and the headers it was sent, as some do.
    r = rig({ script: (sent) => failed(401, { error: { message: `Unknown key ${sent.headers.authorization ?? ""} with token ${sent.headers["x-gateway-token"] ?? ""} for ${sent.headers["x-portkey-provider"] ?? ""}.`, type: "invalid_request_error" } }) });
    const saved = await r.layer.api.save(USER, { name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model", headers: { "x-portkey-provider": "openai", "x-gateway-token": "gw-01234" } }, "sk-01234");
    const tested = await r.layer.api.test(USER, saved.id);
    expect(r.sent.map((s) => [s.headers.authorization, s.headers["x-gateway-token"], s.headers["x-portkey-provider"]])).toEqual([["Bearer sk-01234", "gw-01234", "openai"]]);
    // A header's value is the connection's secret whatever it says: "openai", shorter than calls.minSecretChars, is taken out where it stands as a word of its own.
    expect(tested).toMatchObject({ ok: false, error: "401: Unknown key Bearer [secret] with token [secret] for [secret]. (invalid_request_error)" });
  });

  test("documents a layer can't read stop it in words, and are never written over", async () => {
    const store = new MemoryStore();
    store.connectionsDoc = { version: "another app's", connections: [] };
    r = rig({ store });
    await expect(r.layer.api.list(USER)).rejects.toThrow("The saved connections aren't a list this build reads: fix or remove them.");
    await expect(r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key" }, KEY)).rejects.toThrow("aren't a list this build reads");
    await expect(r.layer.agentModel({ user: USER, connectionId: null, model: null })).rejects.toThrow("aren't a list this build reads");
    expect(store.writes).toEqual([]);
  });

  test("a saved connection a save would refuse is left out, with a line in the log that says why", async () => {
    const store = new MemoryStore();
    store.connectionsDoc = { v: 1, default: "c1", connections: [{ id: "c1", name: "Local", provider: "openai-compatible", auth: "none", model: "served-model" }, { id: "c2", name: 7 }] };
    r = rig({ store });
    expect((await r.layer.api.list(USER)).connections).toEqual([]);
    expect(r.logs).toEqual(['left out the saved connection "Local": An OpenAI-compatible connection needs the server\'s address.', "left out a saved connection this build can't read"]);
    expect(store.writes).toEqual([]);
  });
});

describe("what was stored for one server goes to no other", () => {
  test("a key whose connection moved, and a key with no recorded place, are sent nowhere until the switch for the connection's place is on; then they go and the place is recorded", async () => {
    const switches = new Switches();
    const answered = (): Response => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop")]));
    r = rig({ switches, script: answered });
    const fields = { name: "Proxy", provider: "openai-compatible", auth: "key", model: "served-model" } as const;
    const saved = await r.layer.api.save(USER, { ...fields, baseUrl: "https://proxy.example.com/v1", headers: { "x-gateway-token": GATEWAY } }, SERVER_KEY);
    // Another path at the same origin is another place: a save that gives none of them again keeps them there, waiting.
    expect(await r.layer.api.save(USER, { ...fields, id: saved.id, baseUrl: "https://proxy.example.com/v2" })).toMatchObject({ key: { set: true, waiting: true }, headers: [{ name: "x-gateway-token", set: true }] });
    const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" });
    expect((await call(agent, ASK)).errorMessage).toBe(MOVED_WAITS);
    await expect(r.layer.api.models(USER, saved.id)).rejects.toThrow(MOVED_WAITS);
    expect(r.sent).toEqual([]);
    expect(r.store.secretsDoc).toMatchObject({ keys: { [saved.id]: SERVER_KEY }, headers: { [saved.id]: { "x-gateway-token": GATEWAY } }, places: { [saved.id]: placeOf("openai-compatible", "https://proxy.example.com/v1") } });
    // The host's switches were asked for the connection at its new place, which the server switches on.
    const there = { kind: "connection" as const, name: "Proxy", target: placeOf("openai-compatible", "https://proxy.example.com/v2") };
    expect(switches.asked).toContainEqual(there);
    switches.switchOn(USER, there);
    expect((await call(agent, ASK)).errorMessage).toBeUndefined();
    expect([r.sent[0]?.url, r.sent[0]?.headers.authorization, r.sent[0]?.headers["x-gateway-token"]]).toEqual(["https://proxy.example.com/v2/chat/completions", `Bearer ${SERVER_KEY}`, GATEWAY]);
    expect((r.store.secretsDoc as SecretsDoc).places).toEqual({ [saved.id]: there.target });
    expect((await r.layer.api.list(USER)).connections[0]?.key).toEqual({ set: true, waiting: false });
    await r.done();

    // A key kept before places were waits too, until the switch for its connection's place is on.
    const store = new MemoryStore();
    store.connectionsDoc = { v: 1, default: "c1", connections: [{ id: "c1", ...fields, baseUrl: "https://proxy.example.com/v1" }] };
    store.secretsDoc = { v: 1, keys: { c1: SERVER_KEY }, signins: {} };
    const later = new Switches();
    r = rig({ store, switches: later, script: answered });
    const unplaced = await r.layer.agentModel({ user: USER, connectionId: "c1", model: null, effort: "off" });
    expect((await call(unplaced, ASK)).errorMessage).toBe(`The key of the connection "Proxy" was kept before the place it was given for was recorded, so the call wasn't made: nothing of it is sent until the connection is switched on at its place from the server's command line.`);
    expect(r.logs).toEqual([`the key of the saved connection "Proxy" was kept before the place it was given for was recorded: nothing of it is sent until the connection is switched on at its place from the server's command line`]);
    expect([r.sent, store.writes]).toEqual([[], []]);
    later.switchOn(USER, { kind: "connection", name: "Proxy", target: placeOf("openai-compatible", "https://proxy.example.com/v1") });
    expect((await call(unplaced, ASK)).errorMessage).toBeUndefined();
    expect(r.sent[0]?.headers.authorization).toBe(`Bearer ${SERVER_KEY}`);
    expect(store.secretsDoc).toEqual({ v: 1, keys: { c1: SERVER_KEY }, signins: {}, places: { c1: placeOf("openai-compatible", "https://proxy.example.com/v1") } });
  });

  test("the exported placeOf gives the place the book records", async () => {
    r = rig();
    const saved = await r.layer.api.save(USER, { name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1/", model: "served-model" }, SERVER_KEY);
    expect((r.store.secretsDoc as SecretsDoc).places).toEqual({ [saved.id]: placeOf("openai-compatible", "https://proxy.example.com/v1") });
    expect([placeOf("openai-compatible", "https://proxy.example.com/v1/"), placeOf("anthropic", undefined)]).toEqual(['["openai-compatible","https://proxy.example.com/v1"]', '["anthropic",null]']);
  });

  test("a connection whose provider changes keeps its key waiting: an OpenAI key never goes to OpenRouter unswitched", async () => {
    r = rig();
    const saved = await r.layer.api.save(USER, { name: "Mine", provider: "openai", auth: "key", model: "gpt-5" }, OPENAI_KEY);
    expect((await r.layer.api.save(USER, { id: saved.id, name: "Mine", provider: "openrouter", auth: "key", model: "openai/gpt-5" })).key).toEqual({ set: true, waiting: true });
    expect((await call(await r.layer.agentModel({ user: USER, connectionId: null, model: null }), ASK)).errorMessage).toBe(`The connection "Mine" now goes to another provider or address than its key was given for, so the call wasn't made: nothing of it is sent until the connection is switched on there from the server's command line.`);
    expect(r.sent).toEqual([]);
    // A key that comes with the change is the new provider's own, given for its place.
    expect((await r.layer.api.save(USER, { id: saved.id, name: "Mine", provider: "openrouter", auth: "key" }, ROUTER_KEY)).key).toEqual({ set: true, waiting: false });
    expect(r.store.secretsDoc).toEqual({ v: 1, keys: { [saved.id]: ROUTER_KEY }, signins: {}, places: { [saved.id]: '["openrouter",null]' } });
  });

  test("a connection made under a given id from name, provider, address and model, with no key, is listed under that id with no key; a second save under the same id is refused by name", async () => {
    r = rig();
    const copied = { name: "Harbour copy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model" } as const;
    expect(await r.layer.api.save(USER, copied, undefined, "lv-conn-7")).toMatchObject({ id: "lv-conn-7", key: { set: false, waiting: false } });
    expect((await r.layer.api.list(USER)).connections.map((c) => [c.id, c.key])).toEqual([["lv-conn-7", { set: false, waiting: false }]]);
    expect(await wordsOf(r.layer.api.save(USER, { ...copied, name: "Again" }, undefined, "lv-conn-7"))).toBe(`The id "lv-conn-7" is the saved connection "Harbour copy"'s already: a connection is made under an id no other has.`);
    expect((await r.layer.api.list(USER)).connections.map((c) => c.name)).toEqual(["Harbour copy"]);
    // A key added later is recorded with its place.
    await r.layer.api.save(USER, { ...copied, id: "lv-conn-7" }, SERVER_KEY);
    expect(r.store.secretsDoc).toEqual({ v: 1, keys: { "lv-conn-7": SERVER_KEY }, signins: {}, places: { "lv-conn-7": placeOf("openai-compatible", "https://proxy.example.com/v1") } });
  });

  test("over a secrets document marked not to be written, a call on a scripted server carries the key it was handed, and the port is never written", async () => {
    /** A script's port: its secrets filled in memory from the environment, each key with its place. */
    class FromEnvironment extends MemoryStore {
      readonly secretsWritten = false as const;
    }
    const store = new FromEnvironment();
    const fields = { name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model" } as const;
    store.connectionsDoc = { v: 1, default: "c1", connections: [{ id: "c1", ...fields }] };
    const handed = { v: 1, keys: { c1: SERVER_KEY }, signins: {}, places: { c1: placeOf("openai-compatible", "https://proxy.example.com/v1") } };
    store.secretsDoc = structuredClone(handed);
    r = rig({ store, script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop")])) });
    const agent = await r.layer.agentModel({ user: USER, connectionId: "c1", model: null, effort: "off" });
    expect((await call(agent, ASK)).errorMessage).toBeUndefined();
    // A key given in a save is used from memory alone, its place too.
    await r.layer.api.save(USER, { id: "c1", ...fields }, ROUTER_KEY);
    await call(agent, ASK);
    expect(r.sent.map((s) => s.headers.authorization)).toEqual([`Bearer ${SERVER_KEY}`, `Bearer ${ROUTER_KEY}`]);
    expect([store.secretsDoc, store.writes]).toEqual([handed, ["connections"]]);
  });

  test("a connection that signs in goes to its provider's own address: one given another is refused when saved, and left out when read", async () => {
    r = rig();
    expect(await wordsOf(r.layer.api.save(USER, { name: "Claude sign-in", provider: "anthropic", auth: "signin", baseUrl: "https://elsewhere.example", model: "claude-sonnet-4-5" }))).toBe("A connection that signs in to Anthropic goes to Anthropic's own address: leave the address out.");
    await r.done();
    // Written by hand beside a sign-in already held: the connection is left out, and the token goes nowhere.
    const store = new MemoryStore();
    store.connectionsDoc = { v: 1, default: "c1", connections: [{ id: "c1", name: "Claude sign-in", provider: "anthropic", auth: "signin", baseUrl: "https://elsewhere.example", model: "claude-sonnet-4-5" }] };
    store.secretsDoc = { v: 1, keys: {}, signins: { anthropic: { type: "oauth", access: "sk-ant-oat01-held-0123456789abcdef", refresh: "sk-ant-ort01-held-0123456789abcdef", expires: 4_102_444_800_000 } } };
    r = rig({ store });
    expect((await r.layer.api.list(USER)).connections).toEqual([]);
    expect(r.logs).toContain(`left out the saved connection "Claude sign-in": A connection that signs in to Anthropic goes to Anthropic's own address: leave the address out.`);
    expect(await r.layer.api.test(USER, "c1")).toMatchObject({ ok: false, error: "This call's connection is no longer there: pick another on the Connections page." });
    expect(r.sent).toEqual([]);
  });
});

describe("a connection's headers", () => {
  test("the page sees each header's name and whether it has a value, never the value; a save keeps, changes or takes each away as it says", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) });
    const fields = { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" } as const;
    const saved = await r.layer.api.save(USER, { ...fields, headers: { "x-gateway-token": GATEWAY, "x-team": "harbour" } }, KEY);
    expect(saved.headers).toEqual([
      { name: "x-gateway-token", set: true },
      { name: "x-team", set: true },
    ]);
    expect(JSON.stringify(await r.layer.api.list(USER))).not.toContain(GATEWAY);
    // Null keeps the value stored under a name; a text changes it; absent keeps them all.
    await r.layer.api.save(USER, { ...fields, id: saved.id, headers: { "x-gateway-token": null, "x-team": "quay" } });
    await r.layer.api.save(USER, { ...fields, id: saved.id });
    await call(await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" }), ASK);
    expect([r.sent[0]?.headers["x-gateway-token"], r.sent[0]?.headers["x-team"]]).toEqual([GATEWAY, "quay"]);
    // A name left out is taken away, and null takes them all.
    expect((await r.layer.api.save(USER, { ...fields, id: saved.id, headers: { "x-team": null } })).headers).toEqual([{ name: "x-team", set: true }]);
    expect((await r.layer.api.save(USER, { ...fields, id: saved.id, headers: null })).headers).toBeUndefined();
  });
});

describe("headers' values are kept with the secrets", () => {
  test("the connections document keeps each header's name, the secrets its value, under the connection's id; a call sends both", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) });
    const saved = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", headers: { "x-gateway-token": GATEWAY, "x-team": "harbour" } }, KEY);
    expect(r.store.connectionsDoc).toEqual({ v: 1, default: saved.id, connections: [{ id: saved.id, name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", headers: ["x-gateway-token", "x-team"] }] });
    expect(r.store.secretsDoc).toEqual({ v: 1, keys: { [saved.id]: KEY }, signins: {}, headers: { [saved.id]: { "x-gateway-token": GATEWAY, "x-team": "harbour" } }, places: { [saved.id]: '["anthropic",null]' } });
    await call(await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" }), ASK);
    expect([r.sent[0]?.headers["x-gateway-token"], r.sent[0]?.headers["x-team"]]).toEqual([GATEWAY, "harbour"]);
    // They go with their connection.
    await r.layer.api.remove(USER, saved.id);
    expect(r.store.secretsDoc).toEqual({ v: 1, keys: {}, signins: {} });
  });

  test("a document saved the old way, the values in it, is read as it is and moved on its next save, an entry the layer can't read with it", async () => {
    const store = new MemoryStore();
    const typo = "gw-typo-0123456789abcdef";
    store.connectionsDoc = {
      v: 1,
      default: "c1",
      connections: [
        { id: "c1", name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model", headers: { "x-gateway-token": GATEWAY, "x-team": null } },
        { id: "c2", name: "Typo", provider: "openai-compatible", auth: "key", effort: "medium-high", headers: { "x-gateway-token": typo } },
      ],
    };
    store.secretsDoc = { v: 1, keys: { c1: SERVER_KEY }, signins: {}, places: { c1: placeOf("openai-compatible", "https://proxy.example.com/v1") } };
    r = rig({ store, script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop")])) });
    const agent = await r.layer.agentModel({ user: USER, connectionId: "c1", model: null, effort: "off" });
    await call(agent, ASK);
    // The document is read as it is, and a read writes nothing.
    expect(store.writes).toEqual([]);
    await r.layer.api.setDefault(USER, "c1");
    expect(store.connectionsDoc).toEqual({
      v: 1,
      default: "c1",
      connections: [
        { id: "c1", name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", model: "served-model", headers: ["x-gateway-token", "x-team"] },
        { id: "c2", name: "Typo", provider: "openai-compatible", auth: "key", effort: "medium-high", headers: ["x-gateway-token"] },
      ],
    });
    expect(store.secretsDoc).toEqual({
      v: 1,
      keys: { c1: SERVER_KEY },
      signins: {},
      headers: { c1: { "x-gateway-token": GATEWAY }, c2: { "x-gateway-token": typo } },
      places: { c1: placeOf("openai-compatible", "https://proxy.example.com/v1"), c2: '["openai-compatible",null]' },
    });
    // The values went to the secrets before they left the document.
    expect(store.writes).toEqual(["secrets", "connections"]);
    await call(agent, ASK);
    expect(r.sent.map((s) => s.headers["x-gateway-token"])).toEqual([GATEWAY, GATEWAY]);
  });
});

/** A connections document as a person edits it by hand. */
interface HandDoc {
  v: number;
  default: string | null;
  connections: Record<string, unknown>[];
}

/** Changes the connections document behind the layer's back, as a person editing the host's config file does. */
function handEdit(store: MemoryStore, change: (doc: HandDoc) => void): void {
  // The document the layer last wrote, which each test here knows the shape of.
  const doc = structuredClone(store.connectionsDoc) as HandDoc;
  change(doc);
  store.connectionsDoc = doc;
}

/** The document's entry at `index`. */
function entryAt(doc: HandDoc, index: number): Record<string, unknown> {
  const entry = doc.connections[index];
  if (entry === undefined) throw new Error(`the document has no entry ${index}`);
  return entry;
}

describe("a hand edit of the connections, made while the layer runs", () => {
  const answered = (): Response => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." })));

  test("is used from the next turn's first call, the key going with it while the connection goes to the same place", async () => {
    r = rig({ script: answered });
    const saved = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" });
    handEdit(r.store, (doc) => {
      entryAt(doc, 0).model = "claude-opus-4-7";
    });
    // Until a turn starts, the connections as they were read.
    await call(agent, ASK);
    expect(await r.layer.turnStarting(USER)).toEqual([]);
    await call(agent, ASK);
    expect(r.sent.map((s) => [bodyOf(s).model, s.headers["x-api-key"]])).toEqual([
      ["claude-sonnet-4-5", KEY],
      ["claude-opus-4-7", KEY],
    ]);
  });

  test("a save after it writes the hand edit with its own change; an entry the layer can't read goes back as it came", async () => {
    r = rig();
    const claude = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const local = await r.layer.api.save(USER, { name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" });
    const byHand = { id: "by-hand", name: "Groq", provider: "groq", auth: "key", model: "llama-3.3-70b-versatile" };
    const typo = { id: "typo", name: "Typo", provider: "anthropic", auth: "key", effort: "medium-high" };
    handEdit(r.store, (doc) => {
      entryAt(doc, 1).model = "other-model";
      doc.connections.push(byHand, typo);
    });
    await r.layer.api.save(USER, { id: claude.id, name: "Claude", provider: "anthropic", auth: "key", model: "claude-opus-4-7" });
    expect(r.store.connectionsDoc).toEqual({
      v: 1,
      default: claude.id,
      connections: [
        { id: claude.id, name: "Claude", provider: "anthropic", auth: "key", model: "claude-opus-4-7" },
        { id: local.id, name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "other-model" },
        byHand,
        typo,
      ],
    });
    await r.layer.api.setDefault(USER, "by-hand");
    expect(r.store.connectionsDoc).toMatchObject({ default: "by-hand", connections: [{ model: "claude-opus-4-7" }, { model: "other-model" }, byHand, typo] });
    expect((await r.layer.api.list(USER)).connections.map((c) => [c.id, c.key])).toEqual([
      [claude.id, { set: true, waiting: false }],
      [local.id, null],
      ["by-hand", { set: false, waiting: false }],
    ]);
    expect(r.logs).toEqual(["left out a saved connection this build can't read"]);
  });

  test("a document that no longer parses is said in words, once in the log; the connections last read stay in use, and nothing is written over it", async () => {
    r = rig({ script: answered });
    const saved = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" });
    const good = structuredClone(r.store.connectionsDoc);
    r.store.connectionsDoc = { v: 1, connections: "Claude, Local" };
    const words = "The saved connections aren't a list this build reads: fix or remove them. Until then, the connections as last read are used.";
    expect(await r.layer.turnStarting(USER)).toEqual([words]);
    expect(await r.layer.turnStarting(USER)).toEqual([words]);
    expect(r.logs).toEqual([words]);
    expect((await call(agent, ASK)).stopReason).toBe("stop");
    const writes = r.store.writes.length;
    await expect(r.layer.api.save(USER, { name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1" })).rejects.toThrow("The saved connections aren't a list this build reads: fix or remove them.");
    await expect(r.layer.api.setDefault(USER, null)).rejects.toThrow("aren't a list this build reads");
    expect([r.store.connectionsDoc, r.store.writes.length]).toEqual([{ v: 1, connections: "Claude, Local" }, writes]);
    // Mended, with a change of the user's own: the next turn takes it.
    r.store.connectionsDoc = good;
    handEdit(r.store, (doc) => {
      entryAt(doc, 0).model = "claude-opus-4-7";
    });
    expect(await r.layer.turnStarting(USER)).toEqual([]);
    await call(agent, ASK);
    expect(r.sent.map((s) => bodyOf(s).model)).toEqual(["claude-sonnet-4-5", "claude-opus-4-7"]);
  });

  test("a host that can't give the document is said so in the layer's own words, never the host's", async () => {
    class Unreadable extends MemoryStore {
      broken = false;
      override async loadConnections(scope: UserScope): Promise<unknown> {
        if (this.broken) throw new Error(`EACCES: permission denied, open 'models.yml' near x-gateway-token: ${GATEWAY}`);
        return super.loadConnections(scope);
      }
    }
    const store = new Unreadable();
    r = rig({ store });
    await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    store.broken = true;
    expect(await r.layer.turnStarting(USER)).toEqual(["The saved connections couldn't be read: fix what keeps them. Until then, the connections as last read are used."]);
    expect((await r.layer.api.list(USER)).connections.map((c) => c.name)).toEqual(["Claude"]);
    expect(JSON.stringify(r.logs)).not.toContain(GATEWAY);
  });

  test("a connection moved by hand to another provider or address keeps its key and its headers' values, sent nowhere until it is switched on at its new place", async () => {
    const switches = new Switches();
    r = rig({ switches, script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop")])) });
    const fields = { name: "Proxy", provider: "openai-compatible", auth: "key", model: "served-model" } as const;
    const saved = await r.layer.api.save(USER, { ...fields, baseUrl: "https://proxy.example.com/v1", headers: { "x-gateway-token": GATEWAY } }, SERVER_KEY);
    handEdit(r.store, (doc) => {
      entryAt(doc, 0).baseUrl = "https://elsewhere.example/v1";
    });
    expect(await r.layer.turnStarting(USER)).toEqual([MOVED_NOTE]);
    const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" });
    expect((await call(agent, ASK)).errorMessage).toBe(MOVED_WAITS);
    expect(r.sent).toEqual([]);
    expect(r.store.secretsDoc).toMatchObject({ keys: { [saved.id]: SERVER_KEY }, headers: { [saved.id]: { "x-gateway-token": GATEWAY } } });
    expect((await r.layer.api.list(USER)).connections[0]).toMatchObject({ baseUrl: "https://elsewhere.example/v1", headers: [{ name: "x-gateway-token", set: true }], key: { set: true, waiting: true } });
    // Switched on there from the server, they go there.
    switches.switchOn(USER, { kind: "connection", name: "Proxy", target: placeOf("openai-compatible", "https://elsewhere.example/v1") });
    await call(agent, ASK);
    expect([r.sent[0]?.url, r.sent[0]?.headers.authorization, r.sent[0]?.headers["x-gateway-token"]]).toEqual(["https://elsewhere.example/v1/chat/completions", `Bearer ${SERVER_KEY}`, GATEWAY]);
  });

  test("a connection that first appears by hand under an id whose secrets were given for another place sends none of them", async () => {
    const store = new MemoryStore();
    store.connectionsDoc = { v: 1, default: null, connections: [] };
    store.secretsDoc = { v: 1, keys: { c9: SERVER_KEY }, signins: {}, headers: { c9: { "x-gateway-token": GATEWAY } }, places: { c9: placeOf("openai-compatible", "https://proxy.example.com/v1") } };
    r = rig({ store });
    // The first read is done before the edit.
    await r.layer.api.list(USER);
    handEdit(store, (doc) => {
      doc.connections.push({ id: "c9", name: "Copied", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model", headers: ["x-gateway-token"] });
    });
    expect(await r.layer.turnStarting(USER)).toEqual([MOVED_NOTE.replace('"Proxy"', '"Copied"')]);
    expect((await r.layer.api.list(USER)).connections[0]).toMatchObject({ id: "c9", headers: [{ name: "x-gateway-token", set: true }], key: { set: true, waiting: true } });
    expect(await r.layer.api.test(USER, "c9")).toMatchObject({ ok: false, error: MOVED_WAITS.replace('"Proxy"', '"Copied"') });
    expect(r.sent).toEqual([]);
  });
});

describe("a hand edit of the connections, made while the layer was stopped", () => {
  const answered = (): Response => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop")]));
  const fields = { name: "Proxy", provider: "openai-compatible", auth: "key", model: "served-model" } as const;

  test("a connection moved to another address while the layer was stopped waits there with its key and its headers' values, and one left where it was sends them", async () => {
    const store = new MemoryStore();
    r = rig({ store, script: answered });
    const saved = await r.layer.api.save(USER, { ...fields, baseUrl: "https://proxy.example.com/v1", headers: { "x-gateway-token": GATEWAY } }, SERVER_KEY);
    await r.done();

    // Made again over the same documents, nothing moved: the key and the values go with their connection.
    r = rig({ store, script: answered });
    await call(await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" }), ASK);
    expect([r.sent[0]?.url, r.sent[0]?.headers.authorization, r.sent[0]?.headers["x-gateway-token"]]).toEqual(["https://proxy.example.com/v1/chat/completions", `Bearer ${SERVER_KEY}`, GATEWAY]);
    await r.done();

    handEdit(store, (doc) => {
      entryAt(doc, 0).baseUrl = "https://elsewhere.example/v1";
    });
    r = rig({ store, script: answered });
    const agent = await r.layer.agentModel({ user: USER, connectionId: saved.id, model: null, effort: "off" });
    expect((await call(agent, ASK)).errorMessage).toBe(MOVED_WAITS);
    expect(r.sent).toEqual([]);
    expect(r.logs).toEqual([MOVED_NOTE]);
    expect(store.secretsDoc).toMatchObject({ keys: { [saved.id]: SERVER_KEY }, headers: { [saved.id]: { "x-gateway-token": GATEWAY } } });
    expect((await r.layer.api.list(USER)).connections[0]).toMatchObject({ baseUrl: "https://elsewhere.example/v1", headers: [{ name: "x-gateway-token", set: true }], key: { set: true, waiting: true } });
  });
});

describe("the documents by user", () => {
  /** A second user beside the rig's own. */
  const OTHER = "quay-reader";

  test("two users with different default connections: each user's turn runs on his own", async () => {
    r = rig({ script: (sent) => (sent.url.includes("anthropic") ? eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) : eventStream(chatStream([chunk({ role: "assistant", content: "In the tower." }), chunk({}, "stop")]))) });
    const mine = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    await r.layer.api.setDefault(USER, mine.id);
    const theirs = await r.layer.api.save(OTHER, { name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "harbour-local" });
    await r.layer.api.setDefault(OTHER, theirs.id);

    // Each user's Connections page lists his own connection, as his default, and nothing of the other's.
    expect([(await r.layer.api.list(USER)).connections.map((c) => [c.name, c.default]), (await r.layer.api.list(OTHER)).connections.map((c) => [c.name, c.default])]).toEqual([[["Claude", true]], [["Local", true]]]);
    expect([r.store.of(USER).connections, r.store.of(OTHER).connections].map((doc) => (doc as { connections: { name: string }[] }).connections.map((c) => c.name))).toEqual([["Claude"], ["Local"]]);

    // Each user's turn starts by reading his own documents, and his agent runs on his own default.
    await r.layer.turnStarting(USER);
    await r.layer.turnStarting(OTHER);
    const myAgent = await r.layer.agentModel({ user: USER, connectionId: null, model: null, effort: "off" });
    const theirAgent = await r.layer.agentModel({ user: OTHER, connectionId: null, model: null, effort: "off" });
    expect((await call(myAgent, ASK)).errorMessage).toBeUndefined();
    expect((await call(theirAgent, ASK)).errorMessage).toBeUndefined();
    expect(r.sent.map((sent) => [new URL(sent.url).host, bodyOf(sent).model, sent.headers["x-api-key"] ?? null])).toEqual([
      ["api.anthropic.com", "claude-sonnet-4-5", KEY],
      ["127.0.0.1:8080", "harbour-local", null],
    ]);

    // A connection's id is one user's alone: the other user's, named by his agent, is no connection of his, and his own default stands in; a model made for one user's agent goes on no connection of the other's.
    expect((await r.layer.agentModel({ user: USER, connectionId: theirs.id, model: null })).model.id).toBe("claude-sonnet-4-5");
    expect((await call({ ...theirAgent, streamFn: myAgent.streamFn }, ASK)).errorMessage).toBe("This model wasn't made by the model layer, so the call has no connection to go on: ask the layer for the agent's model.");
    expect(r.sent).toHaveLength(2);
  });
});
