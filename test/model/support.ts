// What the model layer's tests share: a layer over a store kept in memory, a scripted `fetch` that
// keeps what each request sent, answers written the way each provider's API streams them, and the
// rig's clock for every wait. Nothing reaches the network.

import type { AssistantMessage, Message, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { ConnectionsDoc, ModelsPort, SecretsDoc } from "../../src/contract";
import type { AgentModel, ModelLayer, ModelWait } from "../../src/model";
import { createModelLayer } from "../../src/model";
import { FakeClock } from "../../src/testing/rig";

/** One call on an agent's model, as pi's loop makes it, and its answer once it has ended. */
export async function call(agent: AgentModel, messages: Message[], options: SimpleStreamOptions = {}): Promise<AssistantMessage> {
  return (await agent.streamFn(agent.model, normalizeContext({ messages }), options)).result();
}

/** One request a scripted fetch was sent. */
export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The body as JSON where it is JSON, else its text. */
  body: unknown;
  text: string;
  /** What the request does at a redirect: "error" refuses one. */
  redirect: string;
}

export type Script = (sent: Sent, index: number) => Response | Promise<Response>;

/** A fetch that answers from a script and keeps every request it was sent; as a real fetch does, it gives up on an answer still to come once the request's signal ends. */
export function scriptedFetch(script: Script): { fetch: typeof globalThis.fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    let body: unknown = text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // A form or plain text: kept as its text.
    }
    const one: Sent = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body, text, redirect: request.redirect };
    sent.push(one);
    const answered = Promise.resolve(script(one, sent.length - 1));
    const signal = init?.signal;
    if (signal === undefined || signal === null) return answered;
    signal.throwIfAborted();
    const ended = Promise.withResolvers<never>();
    signal.addEventListener("abort", () => ended.reject(signal.reason), { once: true });
    return Promise.race([answered, ended.promise]);
  };
  return { fetch: Object.assign(answer, { preconnect: (): void => undefined }), sent };
}

/** A body sent with a request, read as an object. */
export function bodyOf(sent: Sent | undefined): Record<string, unknown> {
  const body = sent?.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("the request had no JSON body");
  return body as Record<string, unknown>;
}

/** The text of a message's content as a provider's body carries it: a string, or its text blocks together. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: unknown) => (typeof b === "object" && b !== null && "text" in b && typeof b.text === "string" ? b.text : "")).join("");
}

/** An event stream's response, its text given whole. */
export function eventStream(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A failed request's response: its status and its JSON body. */
export function failed(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A JSON response. */
export function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Anthropic's events as its Messages API streams them. */
export function anthropicStream(events: readonly Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export interface AnthropicTurn {
  model?: string;
  thinking?: { text: string; signature: string };
  text?: string;
  tool?: { id: string; name: string; input: Record<string, unknown> };
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** The events of one whole Anthropic answer: its thinking, its text and its tool call, each a block, then its end and its usage. */
export function anthropicTurn(turn: AnthropicTurn): Record<string, unknown>[] {
  const usage = turn.usage ?? { input: 10, output: 5 };
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: turn.model ?? "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheWrite ?? 0 } } },
  ];
  let index = 0;
  if (turn.thinking) {
    events.push(
      { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: turn.thinking.text } },
      { type: "content_block_delta", index, delta: { type: "signature_delta", signature: turn.thinking.signature } },
      { type: "content_block_stop", index },
    );
    index += 1;
  }
  if (turn.text !== undefined) {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: turn.text } }, { type: "content_block_stop", index });
    index += 1;
  }
  if (turn.tool) {
    events.push(
      { type: "content_block_start", index, content_block: { type: "tool_use", id: turn.tool.id, name: turn.tool.name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.tool.input) } },
      { type: "content_block_stop", index },
    );
  }
  events.push({ type: "message_delta", delta: { stop_reason: turn.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: usage.output } }, { type: "message_stop" });
  return events;
}

/** OpenAI's chat-completion chunks as a stream, ended as OpenAI ends one. */
export function chatStream(chunks: readonly Record<string, unknown>[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** A chat-completion chunk with one choice's delta, and its finish where it has one. */
export function chunk(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta, finish_reason: finish }] };
}

/** The two documents the layer keeps, held in memory as a host keeps them: whole, as last given. */
export class MemoryStore implements ModelsPort {
  connectionsDoc: unknown = null;
  secretsDoc: unknown = null;
  /** Every document written, by name, in order. */
  readonly writes: ("connections" | "secrets")[] = [];

  async loadConnections(): Promise<unknown> {
    return structuredClone(this.connectionsDoc);
  }
  async saveConnections(doc: ConnectionsDoc): Promise<void> {
    this.connectionsDoc = structuredClone(doc);
    this.writes.push("connections");
  }
  async loadSecrets(): Promise<unknown> {
    return structuredClone(this.secretsDoc);
  }
  async saveSecrets(doc: SecretsDoc): Promise<void> {
    this.secretsDoc = structuredClone(doc);
    this.writes.push("secrets");
  }
}

export interface RigOptions {
  script?: Script;
  /** A fetch of the test's own in place of the scripted one. */
  fetch?: typeof globalThis.fetch;
  providers?: readonly Provider[];
  /** The store to read: a new empty one when not given. */
  store?: MemoryStore;
  env?: Record<string, string | undefined>;
  silentMs?: number;
  askMs?: number;
  signInMs?: number;
  settingWords?: (wait: ModelWait) => string;
  markNote?: (text: string) => string;
}

export interface Rig {
  layer: ModelLayer;
  store: MemoryStore;
  sent: Sent[];
  clock: FakeClock;
  logs: string[];
  done(): Promise<void>;
}

/** The text the layer's test call sends: a shipped file's in the harness; a test's own here. */
export const TEST_PROMPT = "Answer with one word.";
/** The installation id the rig's layers make for OpenAI's sign-in. */
export const DEVICE = "0f8e6a52-1c3b-4d7a-9e2f-5b6c7d8e9f01";

/** A model layer over a store of its own, its HTTP scripted, its ids counted, its clock and its timers the rig's. */
export function rig(options: RigOptions = {}): Rig {
  const store = options.store ?? new MemoryStore();
  const { fetch, sent } = scriptedFetch(options.script ?? (() => failed(500, { error: { message: "nothing scripted" } })));
  const clock = new FakeClock(1_000_000);
  const logs: string[] = [];
  let ids = 0;
  const layer = createModelLayer({
    store,
    now: clock.now,
    id: () => `id${++ids}`,
    uuid: () => DEVICE,
    log: (text) => logs.push(text),
    fetch: options.fetch ?? fetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    appName: "Harbour Tales",
    testPrompt: async () => TEST_PROMPT,
    env: options.env ?? {},
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.silentMs !== undefined ? { silentMs: () => options.silentMs ?? 0 } : {}),
    ...(options.askMs !== undefined ? { askMs: () => options.askMs ?? 0 } : {}),
    ...(options.signInMs !== undefined ? { signInMs: () => options.signInMs ?? 0 } : {}),
    ...(options.settingWords ? { settingWords: options.settingWords } : {}),
    ...(options.markNote ? { markNote: options.markNote } : {}),
  });
  return { layer, store, sent, clock, logs, done: () => layer.close() };
}

/** A signal that never ends. */
export function forever(): AbortSignal {
  return new AbortController().signal;
}
