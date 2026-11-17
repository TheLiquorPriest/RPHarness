// A client of one MCP server (§5.4, P15): JSON-RPC 2.0 over a started command's stdin and stdout, one
// message a line, or over HTTP at an address (the protocol's streamable HTTP: a POST a message,
// answered with JSON or a stream of events). It asks only what RPH needs: to start, the server's
// tools, and a tool's call. A server's own `ping` is answered and its other requests refused; its
// notifications are let go. Nothing here reads a switch: the caller starts a server only once the
// host's switches have it on.

import type { JsonObject, JsonValue } from "../../contract";
import type { McpServer } from "../../files/mcp";
import { readUpTo } from "../run";

/** The protocol's version RPH speaks. */
const PROTOCOL = "2025-06-18";

/** The characters of a started server's stderr kept, for the words of why it ended. */
const STDERR_KEPT = 600;

/** The names of the environment a server runs with besides its own secrets: enough for a shell to find programs and a home. */
const PASSED = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TZ"] as const;

/** A tool as the server lists it. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

/** A tool call's result as the server gives it. */
export interface McpCallResult {
  content: JsonValue[];
  isError?: boolean;
  structuredContent?: JsonValue;
}

interface Message {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: { code: number; message: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A request failed because the server is gone: its process ended. It is started again at the next need. */
export class ServerGone extends Error {}

/** How messages go to a server and come back. */
interface Transport {
  /** Sends a message; for a request, resolves with the server's answer to it. */
  send(message: Message, signal: AbortSignal): Promise<Message | undefined>;
  /** Resolves, with why, once the server is gone. An address is never gone: each call reaches it anew. */
  readonly ended: Promise<string>;
  close(): Promise<void>;
}

/** A server started by its command line, as the server's user, with the few names a shell needs and its own secrets for an environment. */
class Started implements Transport {
  readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #pending = new Map<number | string, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
  #gone: string | undefined;
  #stderr = "";
  readonly ended: Promise<string>;

  constructor(command: string, env: Readonly<Record<string, string>>, readMost: number) {
    const passed: Record<string, string> = {};
    for (const name of PASSED) {
      const value = process.env[name];
      if (value !== undefined) passed[name] = value;
    }
    this.#proc = Bun.spawn(["/bin/sh", "-c", command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...passed, ...env } });
    void this.#readErrors(readMost);
    const lines = this.#readLines(readMost);
    this.ended = Promise.all([this.#proc.exited, lines]).then(([code]) => {
      const said = this.#stderr.trim();
      const why = this.#gone ?? `it ended (exit code ${code})${said !== "" ? `: ${said.slice(-STDERR_KEPT)}` : ""}`;
      this.#gone = why;
      for (const waiting of this.#pending.values()) waiting.reject(new ServerGone(why));
      this.#pending.clear();
      return why;
    });
  }

  async #readErrors(most: number): Promise<void> {
    const reader = this.#proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (done) return;
      this.#stderr = (this.#stderr + decoder.decode(value, { stream: true })).slice(-Math.min(most, STDERR_KEPT * 4));
    }
  }

  async #readLines(most: number): Promise<void> {
    const reader = this.#proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line !== "") this.#heard(line);
      }
      // One message past the most read of an answer is a runaway: the server is stopped.
      if (buffer.length > most) {
        this.#gone = `it wrote a message longer than ${most} bytes (the setting "tools.maxAnswerBytes")`;
        this.#proc.kill("SIGKILL");
        return;
      }
    }
  }

  #heard(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    const { id, method } = message;
    if (typeof method === "string") {
      // A request of the server's own: a ping is answered, anything else refused.
      if (typeof id === "number" || typeof id === "string") this.#write(method === "ping" ? { jsonrpc: "2.0", id, result: {} } : { jsonrpc: "2.0", id, error: { code: -32601, message: "Not offered by this client." } });
      return;
    }
    if (typeof id !== "number" && typeof id !== "string") return;
    const waiting = this.#pending.get(id);
    if (waiting === undefined) return;
    this.#pending.delete(id);
    waiting.resolve(message as unknown as Message);
  }

  #write(message: Message): void {
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
    void this.#proc.stdin.flush();
  }

  send(message: Message, signal: AbortSignal): Promise<Message | undefined> {
    if (this.#gone !== undefined) return Promise.reject(new ServerGone(this.#gone));
    const id = message.id;
    if (id === undefined) {
      this.#write(message);
      return Promise.resolve(undefined);
    }
    const { promise, resolve, reject } = Promise.withResolvers<Message>();
    const stop = (): void => {
      this.#pending.delete(id);
      // The server is told the request is given up, and may stop its work.
      if (this.#gone === undefined) this.#write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
      reject(signal.reason instanceof Error ? signal.reason : new Error("given up"));
    };
    if (signal.aborted) {
      stop();
      return promise;
    }
    signal.addEventListener("abort", stop, { once: true });
    const settled = (): void => signal.removeEventListener("abort", stop);
    this.#pending.set(id, {
      resolve: (m) => {
        settled();
        resolve(m);
      },
      reject: (e) => {
        settled();
        reject(e);
      },
    });
    try {
      this.#write(message);
    } catch (error) {
      this.#pending.delete(id);
      settled();
      reject(new Error(`it could not be written to: ${errorText(error)}`));
    }
    return promise;
  }

  async close(): Promise<void> {
    this.#gone ??= "it was stopped";
    try {
      await this.#proc.stdin.end();
    } catch {
      // Already closed.
    }
    this.#proc.kill("SIGTERM");
    await Promise.race([this.ended, Bun.sleep(2_000)]);
    this.#proc.kill("SIGKILL");
  }
}

/** A server reached at an address: each message a POST, its session kept by the id the server gives. */
class Reached implements Transport {
  readonly #address: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #readMost: number;
  #session: string | undefined;
  readonly ended = Promise.withResolvers<string>().promise;

  constructor(address: string, headers: Readonly<Record<string, string>>, readMost: number) {
    this.#address = address;
    this.#headers = headers;
    this.#readMost = readMost;
  }

  #sent(): Record<string, string> {
    return { ...this.#headers, "mcp-protocol-version": PROTOCOL, ...(this.#session !== undefined ? { "mcp-session-id": this.#session } : {}) };
  }

  async send(message: Message, signal: AbortSignal): Promise<Message | undefined> {
    const response = await fetch(this.#address, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.#sent() }, body: JSON.stringify(message), redirect: "error", signal });
    const session = response.headers.get("mcp-session-id");
    if (session !== null) this.#session = session;
    if (message.id === undefined || response.status === 202) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const read = response.body === null ? { bytes: new Uint8Array(), cut: false } : await readUpTo(response.body, this.#readMost);
    if (read.cut) throw new Error(`its answer was longer than ${this.#readMost} bytes (the setting "tools.maxAnswerBytes")`);
    const text = new TextDecoder().decode(read.bytes);
    if (!response.ok) throw new Error(`the address answered ${response.status}${text.trim() !== "" ? `: ${text.trim().slice(0, 500)}` : ""}`);
    const type = response.headers.get("content-type") ?? "";
    const bodies = type.includes("text/event-stream") ? eventData(text) : [text];
    for (const body of bodies) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      for (const one of Array.isArray(parsed) ? parsed : [parsed]) if (isObject(one) && one.id === message.id && one.method === undefined) return one as unknown as Message;
    }
    throw new Error("the address gave no answer to the request");
  }

  async close(): Promise<void> {
    if (this.#session === undefined) return;
    // The server is told the session is over; one that keeps none answers as it will.
    await fetch(this.#address, { method: "DELETE", headers: this.#sent(), redirect: "error", signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
  }
}

/** The data of each event of a stream of events, its `data:` lines joined. */
function eventData(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data.length > 0) out.push(data.join("\n"));
  }
  return out;
}

/** What starting a server is given: its secrets' values by header or variable, and its terms in milliseconds and bytes. */
export interface McpStart {
  /** For a started server: each variable's value; for an address: each header's. */
  values: Readonly<Record<string, string>>;
  startMs: number;
  readMost: number;
}

/** A started or reached server, with the tools it listed. */
export class McpClient {
  readonly #t: Transport;
  #next = 1;
  tools: McpTool[] = [];
  /** Resolves, with why, once the server is gone. */
  readonly ended: Promise<string>;

  private constructor(transport: Transport) {
    this.#t = transport;
    this.ended = transport.ended;
  }

  /** Starts or reaches the server, opens its session and lists its tools, all within `startMs`; stopped again where any of it fails. */
  static async start(server: McpServer, start: McpStart): Promise<McpClient> {
    const runs = server.runs;
    const client = new McpClient("command" in runs ? new Started(runs.command, start.values, start.readMost) : new Reached(runs.address, start.values, start.readMost));
    const signal = AbortSignal.timeout(start.startMs);
    try {
      await Promise.race([
        (async () => {
          await client.#request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "rp-harness", version: "1" } }, signal);
          await client.#t.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
          const tools: McpTool[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.#request("tools/list", cursor !== undefined ? { cursor } : {}, signal);
            const listed = isObject(page) && Array.isArray(page.tools) ? page.tools : [];
            for (const tool of listed) if (isObject(tool) && typeof tool.name === "string") tools.push({ name: tool.name, ...(typeof tool.description === "string" ? { description: tool.description } : {}), inputSchema: isObject(tool.inputSchema) ? (tool.inputSchema as JsonObject) : { type: "object", properties: {} } });
            cursor = isObject(page) && typeof page.nextCursor === "string" && page.nextCursor !== "" ? page.nextCursor : undefined;
          } while (cursor !== undefined);
          client.tools = tools;
        })(),
        client.ended.then((why) => {
          throw new Error(why);
        }),
      ]);
    } catch (error) {
      await client.close();
      throw new Error(signal.aborted ? `it did not start within ${start.startMs / 1000} seconds (the setting "mcp.startTimeoutSeconds")` : errorText(error));
    }
    return client;
  }

  async #request(method: string, params: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    const id = this.#next;
    this.#next += 1;
    const answer = await this.#t.send({ jsonrpc: "2.0", id, method, params }, signal);
    if (answer === undefined) throw new Error("the server gave no answer");
    if (answer.error !== undefined) throw new Error(`the server refused ${method}: ${answer.error.message}`);
    return answer.result ?? null;
  }

  /** Calls one of its tools; rejects where the server is gone, the signal fires, or it refuses the request. */
  async call(name: string, args: JsonValue, signal: AbortSignal): Promise<McpCallResult> {
    const result = await Promise.race([
      this.#request("tools/call", { name, arguments: isObject(args) ? args : {} }, signal),
      this.ended.then((why) => {
        throw new ServerGone(why);
      }),
    ]);
    if (!isObject(result)) return { content: [] };
    return { content: Array.isArray(result.content) ? (result.content as JsonValue[]) : [], ...(result.isError === true ? { isError: true } : {}), ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent as JsonValue } : {}) };
  }

  close(): Promise<void> {
    return this.#t.close();
  }
}
