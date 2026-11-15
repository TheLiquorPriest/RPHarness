// The model layer is one layer for every user a host serves, and every member of its API names the
// user it acts for (READINGS R-52; §16: keys are his): a connection's id, which connection is the
// default, a sign-in and a passed request are one user's alone. With two users on one layer, one's
// call on the other's connection finds none, sends nothing, and leaves the other's connection, key
// and sign-in as they were. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { JsonObject, PassError, PassResult } from "../../src/contract";
import { anthropicStream, anthropicTurn, chatStream, chunk, eventStream, forever, type Rig, rig, USER } from "../model/support";

/** A second user beside the rig's own. */
const OTHER = "quay-reader";
const KEY = "sk-ant-api03-harbour-0000000000000000";
const GONE = "That connection is no longer there: reload the page.";
const BODY: JsonObject = { model: "whatever-the-chat-app-names", stream: true, messages: [{ role: "user", content: "What happened at the mill?" }] };

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** Passes `body` on `connection` as `user` and gathers what the sink heard. */
async function passed(made: Rig, user: string, connection: string | null): Promise<{ content: string; result?: PassResult; error?: PassError }> {
  const heard: { content: string[]; result?: PassResult; error?: PassError } = { content: [] };
  await made.layer.api.pass(user, { connection, body: BODY }, { content: (d) => heard.content.push(d), reasoning: () => undefined, finish: (result) => (heard.result = result), error: (e) => (heard.error = e) }, forever());
  return { content: heard.content.join(""), ...(heard.result !== undefined ? { result: heard.result } : {}), ...(heard.error !== undefined ? { error: heard.error } : {}) };
}

test("with two users on one layer, test, models, limits, remove, signIn(user) and pass act on each user's own connections only", async () => {
  r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) });
  const mine = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
  await r.layer.api.setDefault(USER, mine.id);

  // `test`: the other user's id is none of his, and nothing is sent; the owner's own call goes.
  expect(await r.layer.api.test(OTHER, mine.id)).toMatchObject({ ok: false });
  expect(r.sent).toEqual([]);
  expect(await r.layer.api.test(USER, mine.id)).toMatchObject({ ok: true });
  expect(r.sent).toHaveLength(1);

  // `models` and `limits`: a connection that is not his is no longer there; he has no default of his own, whatever the other user's is.
  await expect(r.layer.api.models(OTHER, mine.id)).rejects.toThrow(GONE);
  await expect(r.layer.api.models(OTHER, null)).rejects.toThrow("There is no default connection to list models for.");
  expect((await r.layer.api.models(USER, mine.id)).length).toBeGreaterThan(0);
  await expect(r.layer.api.limits(OTHER, mine.id)).rejects.toThrow();
  expect(await r.layer.api.limits(USER, mine.id)).toMatchObject({});

  // `remove` and `setDefault`: the other user's id is passed over, and the owner's connection and default stay.
  await r.layer.api.remove(OTHER, mine.id);
  await expect(r.layer.api.setDefault(OTHER, mine.id)).rejects.toThrow();
  expect((await r.layer.api.list(USER)).connections.map((c) => [c.id, c.default])).toEqual([[mine.id, true]]);
  expect(await r.layer.api.list(OTHER)).toMatchObject({ connections: [], default: null });
  expect(r.store.of(USER).secrets).toMatchObject({ keys: { [mine.id]: KEY } });
  expect(JSON.stringify(r.store.of(OTHER).secrets)).not.toContain(KEY);

  // `signIn(user)`: a flow one user opened is his; another's call neither finishes it nor cancels it, and he sees none.
  const started = await r.layer.api.signIn(USER).start("anthropic");
  expect(await r.layer.api.signIn(OTHER).state("anthropic")).toEqual({ provider: "anthropic", signedIn: false, until: null, flow: null, ended: null });
  await expect(r.layer.api.signIn(OTHER).finish(started.flow, "code-from-the-page")).rejects.toThrow();
  await r.layer.api.signIn(OTHER).cancel(started.flow);
  expect(await r.layer.api.signIn(USER).state("anthropic")).toMatchObject({ flow: started.flow, signedIn: false, ended: null });

  // `pass`: a request on the other user's id, or on a default he has not set, has no connection and sends nothing; the owner's own goes.
  const before = r.sent.length;
  expect((await passed(r, OTHER, mine.id)).error).toMatchObject({ code: "no-connection" });
  expect((await passed(r, OTHER, null)).error).toMatchObject({ code: "no-connection" });
  expect(r.sent).toHaveLength(before);
  const own = await passed(r, USER, null);
  expect(own.error).toBeUndefined();
  expect(own.content).toBe("At the quay.");
  expect(r.sent).toHaveLength(before + 1);
});

test("each user's own default is his: a request on his default goes to his connection, and the other user's goes to his", async () => {
  r = rig({ script: (sent) => (sent.url.includes("anthropic") ? eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))) : eventStream(chatStream([chunk({ role: "assistant", content: "In the tower." }), chunk({}, "stop")]))) });
  const mine = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
  await r.layer.api.setDefault(USER, mine.id);
  const theirs = await r.layer.api.save(OTHER, { name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "harbour-local" });
  await r.layer.api.setDefault(OTHER, theirs.id);

  expect((await passed(r, USER, null)).content).toBe("At the quay.");
  expect((await passed(r, OTHER, null)).content).toBe("In the tower.");
  expect(r.sent.map((sent) => new URL(sent.url).host)).toEqual(["api.anthropic.com", "127.0.0.1:8080"]);
});
