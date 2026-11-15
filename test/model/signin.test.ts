// Signing in to Anthropic through pi-ai's own flow, on the path a page can finish: the flow's address
// to open, then the code the provider's page showed, pasted in. Against a scripted token endpoint:
// the code is exchanged, the tokens are kept with the secrets, a call on the sign-in carries them,
// an expired token is renewed once however many calls find it so, a flow left open expires, a flow
// that ends without signing in says why for a while, and signing out forgets the tokens.

import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { Rig, Sent } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, call, eventStream, failed, json, rig, scriptedFetch, textOf, USER } from "./support";

const CLAUDE_CODE = "You are Claude Code, Anthropic's official CLI for Claude.";

let r: Rig | undefined;
let realFetch: typeof globalThis.fetch | undefined;
afterEach(async () => {
  if (realFetch !== undefined) globalThis.fetch = realFetch;
  realFetch = undefined;
  await r?.done();
  r = undefined;
});

/** Answers pi-ai's own requests to the token endpoint, which go out through the process's fetch. */
function tokenEndpoint(answer: (sent: Sent) => Response): Sent[] {
  const { fetch, sent } = scriptedFetch(answer);
  realFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  return sent;
}

/** The tokens Anthropic's endpoint hands out, a new pair on each request, each pair good for `seconds`. */
function anthropicTokens(seconds: number): (sent: Sent) => Response {
  let issued = 0;
  return () => {
    issued += 1;
    return json({ access_token: `sk-ant-oat01-access-${issued}`, refresh_token: `sk-ant-ort01-refresh-${issued}`, expires_in: seconds });
  };
}

/** A layer whose Anthropic API answers every call, and a connection on the sign-in. */
async function signInRig(options: Parameters<typeof rig>[0] = {}): Promise<{ r: Rig; connection: string }> {
  const made = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))), ...options });
  r = made;
  const saved = await made.layer.api.save(USER, { name: "Claude sign-in", provider: "anthropic", auth: "signin", model: "claude-sonnet-4-5" });
  return { r: made, connection: saved.id };
}

/** Signs in to Anthropic with the code its page would show. */
async function signIn(made: Rig): Promise<void> {
  const start = await made.layer.api.signIn(USER).start("anthropic");
  const state = new URL(start.url).searchParams.get("state");
  await made.layer.api.signIn(USER).finish(start.flow, `code-from-the-page#${state}`);
}

/** Until when the sign-in kept for `provider` holds, as the secrets say. */
function expiresOf(made: Rig, provider: string): number {
  const secrets = made.store.secretsDoc as { signins: Record<string, { expires: number }> };
  return secrets.signins[provider]?.expires ?? Number.NaN;
}

const ASK: Message[] = [
  { role: "system", content: "You narrate a harbour town.", timestamp: 1 },
  { role: "user", content: "Where is Ilse?", timestamp: 1 },
];

describe("signing in to Anthropic", () => {
  test("starts on the page that shows a code, says how requests on it are sent, and keeps the tokens with the secrets, never on the page", async () => {
    const tokens = tokenEndpoint(anthropicTokens(3600));
    const { r } = await signInRig();
    const start = await r.layer.api.signIn(USER).start("anthropic");
    const url = new URL(start.url);
    expect(url.host).toBe("claude.ai");
    expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
    expect(start.note).toContain("the way Claude Code sends them");
    expect(await r.layer.api.signIn(USER).state("anthropic")).toEqual({ provider: "anthropic", signedIn: false, until: null, flow: start.flow, ended: null });

    const finished = await r.layer.api.signIn(USER).finish(start.flow, `code-from-the-page#${url.searchParams.get("state")}`);
    expect(finished).toEqual({ provider: "anthropic", signedIn: true, until: expiresOf(r, "anthropic"), flow: null, ended: null });
    expect(tokens.map((t) => [t.url, bodyOf(t).grant_type, bodyOf(t).code])).toEqual([["https://platform.claude.com/v1/oauth/token", "authorization_code", "code-from-the-page"]]);
    expect(JSON.stringify(r.store.secretsDoc)).toContain("sk-ant-ort01-refresh-1");
    const list = await r.layer.api.list(USER);
    expect(list.connections[0]).toMatchObject({ auth: "signin", signedIn: true, key: null });
    expect(JSON.stringify(list)).not.toContain("sk-ant-oat01");
  });

  test("a call on the sign-in carries its token, as Claude Code sends one", async () => {
    tokenEndpoint(anthropicTokens(3600));
    const { r, connection } = await signInRig();
    await signIn(r);
    expect((await call(await r.layer.agentModel({ user: USER, connectionId: connection, model: null, effort: "off" }), ASK)).stopReason).toBe("stop");
    const sent = r.sent[0];
    expect(sent?.headers.authorization).toBe("Bearer sk-ant-oat01-access-1");
    expect(sent?.headers["user-agent"]).toStartWith("claude-cli/");
    expect((bodyOf(sent).system as unknown[]).map((block) => textOf([block]))).toEqual([CLAUDE_CODE, "You narrate a harbour town."]);
  });

  test("renews an expired token once, however many calls find it so, and keeps the new one", async () => {
    // The code buys a token good for a minute, within pi-ai's five minutes of expiring, so the first calls renew it; a renewed one is good for an hour.
    const tokens = tokenEndpoint((sent) =>
      bodyOf(sent).grant_type === "refresh_token" ? json({ access_token: "sk-ant-oat01-renewed", refresh_token: "sk-ant-ort01-renewed", expires_in: 3600 }) : json({ access_token: "sk-ant-oat01-first", refresh_token: "sk-ant-ort01-first", expires_in: 60 }),
    );
    const { r, connection } = await signInRig();
    await signIn(r);
    const agent = await r.layer.agentModel({ user: USER, connectionId: connection, model: null, effort: "off" });
    await Promise.all([call(agent, ASK), call(agent, ASK)]);
    expect(tokens.map((t) => [bodyOf(t).grant_type, bodyOf(t).refresh_token ?? null])).toEqual([
      ["authorization_code", null],
      ["refresh_token", "sk-ant-ort01-first"],
    ]);
    expect(r.sent.map((s) => s.headers.authorization)).toEqual(["Bearer sk-ant-oat01-renewed", "Bearer sk-ant-oat01-renewed"]);
    const kept = JSON.stringify(r.store.secretsDoc);
    expect(kept).toContain("sk-ant-ort01-renewed");
    expect(kept).not.toContain("sk-ant-ort01-first");
    expect((await r.layer.api.signIn(USER).state("anthropic")).until).toBe(expiresOf(r, "anthropic"));
  });

  test("a code from another flow, or one the endpoint refuses, is refused in words, and the flow must start again", async () => {
    tokenEndpoint(() => failed(400, { error: "invalid_grant", error_description: "Invalid authorization code" }));
    const { r } = await signInRig();
    const start = await r.layer.api.signIn(USER).start("anthropic");
    await expect(r.layer.api.signIn(USER).finish(start.flow, "code-from-the-page#another-flow")).rejects.toThrow("The Anthropic sign-in didn't finish: OAuth state mismatch. Start it again.");
    await expect(r.layer.api.signIn(USER).finish(start.flow, "code-from-the-page#another-flow")).rejects.toThrow("This sign-in is no longer open");
    const again = await r.layer.api.signIn(USER).start("anthropic");
    await expect(r.layer.api.signIn(USER).finish(again.flow, `stale-code#${new URL(again.url).searchParams.get("state")}`)).rejects.toThrow("The Anthropic sign-in didn't finish: 400: Invalid authorization code (invalid_grant). Start it again.");
    expect((await r.layer.api.signIn(USER).state("anthropic")).signedIn).toBe(false);
  });

  test("an answer of the token endpoint that isn't JSON is never quoted: the tokens it may hold stay out of the words", async () => {
    tokenEndpoint(() => new Response("access_token=sk-ant-oat01-unread-0123456789&refresh_token=sk-ant-ort01-unread-0123456789", { status: 200, headers: { "content-type": "text/plain" } }));
    const { r } = await signInRig();
    const start = await r.layer.api.signIn(USER).start("anthropic");
    const words = await r.layer.api.signIn(USER).finish(start.flow, `code-from-the-page#${new URL(start.url).searchParams.get("state")}`).then(
      () => "signed in",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(words).toBe("The Anthropic sign-in didn't finish: Token exchange returned invalid JSON. Start it again.");
    expect((await r.layer.api.signIn(USER).state("anthropic")).ended).toBe(words);
  });

  test("a flow left open expires after the wait its setting gives, one cancelled ends, and each says why for ten minutes", async () => {
    tokenEndpoint(anthropicTokens(3600));
    const { r } = await signInRig({ signInMs: 90_000, settingWords: (wait) => `The harbour's "${wait}"` });
    const ended = async (): Promise<string | null> => (await r.layer.api.signIn(USER).state("anthropic")).ended;
    const left = await r.layer.api.signIn(USER).start("anthropic");
    r.clock.advance(90_000);
    expect(await ended()).toBe("The Anthropic sign-in didn't finish: The sign-in was left open longer than 90 seconds. The harbour's \"signInMs\" says how long a sign-in stays open. Start it again.");
    await expect(r.layer.api.signIn(USER).finish(left.flow, "code#state")).rejects.toThrow("This sign-in is no longer open: start it again.");
    const cancelled = await r.layer.api.signIn(USER).start("anthropic");
    // A new flow clears the last one's words.
    expect(await ended()).toBeNull();
    await r.layer.api.signIn(USER).cancel(cancelled.flow);
    expect(await ended()).toBe("The Anthropic sign-in didn't finish: The sign-in was cancelled. Start it again.");
    r.clock.advance(10 * 60_000);
    expect(await ended()).toBeNull();
  });

  test("signing out forgets the tokens, and a call on the sign-in then says what to do", async () => {
    tokenEndpoint(anthropicTokens(3600));
    const { r, connection } = await signInRig();
    await signIn(r);
    await r.layer.api.signIn(USER).out("anthropic");
    expect(await r.layer.api.signIn(USER).state("anthropic")).toEqual({ provider: "anthropic", signedIn: false, until: null, flow: null, ended: null });
    expect(JSON.stringify(r.store.secretsDoc)).not.toContain("sk-ant-");
    expect((await call(await r.layer.agentModel({ user: USER, connectionId: connection, model: null, effort: "off" }), ASK)).errorMessage).toBe('There is no sign-in to Anthropic, which the connection "Claude sign-in" uses: sign in on the Connections page.');
    expect(r.sent).toEqual([]);
  });
});
