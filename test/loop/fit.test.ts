// What did not fit is read from pi-ai's own argument check, in the form pi-ai 1.5.2 writes it (§13.7:
// pi is pinned exactly, and an upgrade is a task the suite gates). These tests run pi's own check and
// pi's own parser of a call's arguments, so they fail the day either message changes its form; and
// they show what the model is then told, in the file's words: each argument that did not fit, or that
// what it sent was not JSON at all. Everything here is invented.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream, type Model, parseToolCallArguments, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../../src/contract";
import { AgentRunner, fit, type LoopTool, RunTrace } from "../../src/loop";
import { FakeClock, said, scope, scriptedModel, texts, textOf, TraceRecorder, user } from "./support";

const author = { id: "author", definition: "author" };

/** A tool that takes three arguments, each of which a call can get wrong. */
const TIDE_SET: LoopTool = {
  name: "tide_set",
  description: "Fixture: sets the tide for a day.",
  parameters: { type: "object", properties: { day: { type: "integer" }, port: { type: "string" }, state: { enum: ["calm", "storm"] } }, required: ["day", "port", "state"] },
  run: async () => said("set"),
};

/** The text a model sent as its arguments, cut off: not JSON. */
const BROKEN = '{"day": 3, "port": "Gannet';

/** pi's check of `args`, as its loop runs it; its message when it throws. */
function piSays(args: JsonObject, argumentsError?: string): string {
  try {
    validateToolArguments(TIDE_SET, { type: "toolCall", id: "c-1", name: "tide_set", arguments: args, ...(argumentsError !== undefined ? { argumentsError } : {}) });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The file's `invalid` line, as a test's own: each argument that did not fit, or that what was sent was not JSON. */
const invalid = ({ tool, arguments: sent, misfits, unparsed }: { tool: string; arguments: string; parameters: string; misfits: { argument: string; missing: boolean }[]; unparsed?: true }): string =>
  unparsed === true ? `Fixture: ${tool} was sent no JSON: ${sent}` : `Fixture: ${tool} did not take ${misfits.map((m) => `${m.argument} (${m.missing ? "missing" : "does not fit"})`).join(", ")}`;

/** A model's answer that calls `tide_set` with `text` as its arguments, parsed as pi-ai's providers parse a finished call. */
function callWith(model: Model<string>, text: string): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const parsed = parseToolCallArguments(text);
  const call: ToolCall = { type: "toolCall", id: "c-1", name: "tide_set", arguments: parsed.arguments, ...(parsed.argumentsError !== undefined ? { argumentsError: parsed.argumentsError } : {}) };
  const message: AssistantMessage = {
    role: "assistant",
    content: [call],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
  queueMicrotask(() => {
    out.push({ type: "start", partial: message });
    out.push({ type: "toolcall_start", contentIndex: 0, partial: message });
    out.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
    out.push({ type: "done", reason: "toolUse", message });
    out.end(message);
  });
  return out;
}

describe("pi-ai 1.5.2's own messages", () => {
  test("three arguments that do not fit: the message's form, and each argument read from it with whether the call left it out", () => {
    const args = { day: "three", state: "fog" };
    const message = piSays(args);
    const lines = message.split("\n");
    expect(lines[0]).toBe('Validation failed for tool "tide_set":');
    expect(lines.slice(1, 4).every((line) => /^ {2}- (day|port|state): \S/.test(line))).toBe(true);
    expect(message).toContain("\n\nReceived arguments:\n");

    const checked = fit(TIDE_SET, args, "c-1");
    expect("misfits" in checked ? [...checked.misfits].sort((a, b) => a.argument.localeCompare(b.argument)) : checked).toEqual([
      { argument: "day", missing: false },
      { argument: "port", missing: true },
      { argument: "state", missing: false },
    ]);
  });

  test("arguments that do not parse: the parser's note, the check's message, and the text the model sent, with no argument named", () => {
    const parsed = parseToolCallArguments(BROKEN);
    // pi-ai's own shape of the arguments: an empty object where nothing parsed.
    const args = parsed.arguments as JsonObject;
    expect(args).toEqual({});
    expect(parsed.argumentsError).toEndWith(`\n\nReceived arguments:\n${BROKEN}`);
    expect(piSays(args, parsed.argumentsError)).toStartWith('Invalid arguments for tool "tide_set": ');

    expect(fit(TIDE_SET, args, "c-1", parsed.argumentsError)).toEqual({ misfits: [], unparsed: BROKEN });
  });
});

describe("what the model is told, in the file's words", () => {
  test("a call whose arguments do not fit: each argument that did not fit, and whether it was left out", async () => {
    const clock = new FakeClock();
    const scripted = scriptedModel([{ pieces: [{ call: "tide_set", args: { day: "three", state: "fog" } }] }, { pieces: [{ text: "Noted." }] }], { clock });
    const runner = new AgentRunner({ agent: author, trace: new RunTrace(new TraceRecorder(), scope, "run-1", clock), model: scripted.model, streamFn: scripted.streamFn, connection: "connection-a", session: "session-a", texts: { ...texts, invalid }, tools: [TIDE_SET] });

    await clock.settle(runner.start({ messages: [user("Set the tide.")] }).done);

    const told = textOf(scripted.requests[1]!.messages.at(-1)!);
    expect(told).toStartWith("Fixture: tide_set did not take ");
    expect(told.slice("Fixture: tide_set did not take ".length).split(", ").sort()).toEqual(["day (does not fit)", "port (missing)", "state (does not fit)"]);
  });

  test("a call whose arguments are not JSON: told so, with the text it sent, and no argument named as missing", async () => {
    const clock = new FakeClock();
    const scripted = scriptedModel([{ pieces: [{ text: "Noted." }] }], { clock });
    let first = true;
    const streamFn: StreamFn = (model, context, options) => {
      if (!first) return scripted.streamFn(model, context, options);
      first = false;
      return callWith(model, BROKEN);
    };
    const runner = new AgentRunner({ agent: author, trace: new RunTrace(new TraceRecorder(), scope, "run-1", clock), model: scripted.model, streamFn, connection: "connection-a", session: "session-a", texts: { ...texts, invalid }, tools: [TIDE_SET] });

    const outcome = await clock.settle(runner.start({ messages: [user("Set the tide.")] }).done);

    expect(outcome.status).toBe("done");
    expect(textOf(scripted.requests[0]!.messages.at(-1)!)).toBe(`Fixture: tide_set was sent no JSON: ${BROKEN}`);
  });
});
