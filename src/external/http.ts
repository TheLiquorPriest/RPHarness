// An HTTP tool's call (§5.4, P15, §16): the arguments go as the JSON body to the address his manifest
// writes, never one taken from the arguments; the headers' values are the secrets his manifest names,
// read from the secrets document (C4), so none is in his files. The JSON answered is the tool's
// result, as data. Every secret sent is taken out of whatever comes back, and out of a failure's
// words, before the model, the trace, the session file or a page could see it, as the model layer's
// keys are. A redirect is refused: the switched-on address is the one called.

import type { JsonValue, SwitchesPort, ToolCtx, ToolResult } from "../contract";
import { redact, type SecretTerms } from "../model/words";
import { answer, type Words } from "../tools/kit";
import { dataAnswer, SAID_MOST } from "./command";
import { readUpTo } from "./run";

/** An HTTP tool's call: the tool, what its manifest writes, the arguments, and its terms. */
export interface HttpToolCall {
  tool: string;
  address: string;
  method: string;
  /** Each header's name, with the name of the secret its value is. */
  headers: Readonly<Record<string, string>>;
  args: JsonValue;
  ctx: ToolCtx;
  timeoutMs: number;
  readMost: number;
  switches: SwitchesPort | undefined;
  words: Words;
  /** A secret's value by its name; undefined when it is not set. */
  secret(name: string): Promise<string | undefined>;
  secrets: SecretTerms;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Calls an HTTP tool once its address is switched on, and gives its JSON answer as data, or why there is none, in the file's words. */
export async function callHttpTool(c: HttpToolCall): Promise<ToolResult> {
  const { tool, words, ctx } = c;
  // Nothing is sent to an address the host's switches do not have on for the user, pinned or found.
  const state = c.switches === undefined ? "off" : await c.switches.state(ctx.scope.user, { kind: "http-tool", name: tool, target: c.address });
  if (state !== "on") return answer(words("not_switched_on", { tool, name: tool, kind: "http-tool", ...(state === "waiting" ? { waiting: true } : {}) }), true);
  const values: Record<string, string> = {};
  for (const [header, secret] of Object.entries(c.headers)) {
    const value = await c.secret(secret);
    // A header whose secret is not set is said, and nothing is sent.
    if (value === undefined) return answer(words("secret_unset", { tool, secret, header }), true);
    values[header] = value;
  }
  const sent = Object.values(values);
  // An answer is taken whole, its length held by `tools.maxAnswerBytes`; a failure's words are cut as the layer cuts a provider's.
  const clean = (text: string, whole = false): string => redact(text, sent, whole ? { ...c.secrets, wordsMost: Number.MAX_SAFE_INTEGER } : c.secrets);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), c.timeoutMs);
  const started = performance.now();
  const lost = (error: unknown): ToolResult => {
    if (timeout.signal.aborted && !ctx.signal.aborted) return answer(words("timed_out", { tool, seconds: c.timeoutMs / 1000 }), true);
    // The reason goes to the trace as the failed call's, with every secret taken out of it.
    throw new Error(clean(`The address could not be reached: ${errorText(error)}`));
  };
  try {
    let response: Response;
    try {
      response = await fetch(c.address, { method: c.method, headers: { "content-type": "application/json", accept: "application/json", ...values }, body: JSON.stringify(c.args ?? {}), redirect: "error", signal: AbortSignal.any([ctx.signal, timeout.signal]) });
    } catch (error) {
      return lost(error);
    }
    let read: { bytes: Uint8Array; cut: boolean };
    try {
      read = response.body === null ? { bytes: new Uint8Array(), cut: false } : await readUpTo(response.body, c.readMost);
    } catch (error) {
      return lost(error);
    }
    const details: JsonValue = { status: response.status, ms: Math.round(performance.now() - started) };
    const failed = (name: string, fields: Record<string, JsonValue>): ToolResult => ({ ...answer(words(name, { tool, ...fields }), true), details });
    if (read.cut) return failed("answer_cut", { bytes: c.readMost });
    const text = clean(new TextDecoder().decode(read.bytes), true).trim();
    if (!response.ok) return failed("http_status", { status: response.status, ...(text !== "" ? { said: text.slice(0, SAID_MOST) } : {}) });
    if (text === "") return { ...answer(words("empty_answer", { tool })), details };
    let output: JsonValue;
    try {
      output = JSON.parse(text) as JsonValue;
    } catch {
      return failed("not_json", { said: text.slice(0, SAID_MOST) });
    }
    return dataAnswer(output, details);
  } finally {
    clearTimeout(timer);
  }
}
