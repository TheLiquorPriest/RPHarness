// A model that answers from a script, standing wherever a real one does: pi's `Agent` is given its
// model and its stream function (`StreamFn`), the two things the model layer gives an agent for a
// connection's model (`AgentModel`). Each call takes the script's next answer: pieces of text, of
// thinking and tool calls, in the order and the split the script gives, with waits between them on
// the rig's clock or a gate the test opens; the usage numbers; and how the answer ends: finished, at
// its length limit, with an error, or cut off half way, as a stream that drops does. Every request
// is kept as it came (its messages in order, the tools declared to the model, the options), with
// when each piece was pushed, for tests to assert on. The call's signal stops it the way a provider
// stops: no piece after it, and an error event with the reason "aborted", unless the script says to
// ignore the signal, so a test can show who holds back what a stopped model goes on sending.

import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEventStream, CacheRetention, JsonObject, Message, Model, SimpleStreamOptions, TextContent, ThinkingContent, Tool, ToolCall, ToolChoice, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ModelLimits } from "../../contract";
import type { AgentModel, ModelSource, UserChoice } from "../../model/source";
import { FakeClock } from "./clock";

/** Something the test opens: a call holding at it goes on once it is open. */
export interface Gate {
  open(): void;
  readonly isOpen: boolean;
  /** Resolves once the gate is open. */
  readonly opened: Promise<void>;
}

export function gate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  let isOpen = false;
  return {
    open() {
      isOpen = true;
      resolve();
    },
    get isOpen() {
      return isOpen;
    },
    opened: promise,
  };
}

/** One step of an answer: a piece of text or of thinking (each one delta, split as the script splits it), a tool call, a wait on the rig's clock, or a hold at a gate. */
export type Piece = { text: string } | { thinking: string; signature?: string } | { call: string; args?: JsonObject; id?: string } | { wait: number } | { hold: Gate };

/** The answer's tokens, as a provider reports them: `input` without what was read from the cache or written to it, `output` with the reasoning. */
export interface ReplyUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface Reply {
  pieces: readonly Piece[];
  usage?: ReplyUsage;
  /**
   * How the answer ends, after its pieces: as the model finished ("stop", or "toolUse" for an answer
   * that calls a tool, which is what it ends with when this is left out), at its length limit
   * ("length"), with a provider's error in its words, or "cut": the stream stops there, as one that
   * drops does.
   */
  end?: "stop" | "toolUse" | "length" | "cut" | { error: string };
  /** The call's signal is ignored: the pieces keep coming after it ends. */
  ignoreAbort?: boolean;
}

/** One answer of the script, or the answer to a request as it came (its messages, tools, options and number). */
export type Answer = Reply | ((request: RecordedRequest) => Reply | Promise<Reply>);

/** What the call's options asked, as the request was received. */
export interface RecordedOptions {
  temperature?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  reasoning?: SimpleStreamOptions["reasoning"];
  sessionId?: string;
  cacheRetention?: CacheRetention;
  toolChoice?: ToolChoice;
}

/** A piece the rig pushed: what kind, its text (a call's arguments as JSON), and when, by the rig's clock and by `performance.now()`. */
export interface PushedPiece {
  kind: "text" | "thinking" | "call";
  text: string;
  at: number;
  wall: number;
}

export interface RecordedRequest {
  /** Its place among the calls this model received, from 0. */
  index: number;
  /** The model it was asked of. */
  model: string;
  /** The messages as sent, in order, system messages and all. */
  messages: Message[];
  /** The tools declared to the model, as they stand at the end of the messages. */
  tools: Tool[];
  options: RecordedOptions;
  /** When it came, by the rig's clock. */
  at: number;
  pushed: PushedPiece[];
}

export interface ScriptedOptions {
  /** The clock waits run on: a new one at 0 when not given. */
  clock?: FakeClock;
  id?: string;
  name?: string;
  /** The model's limits in tokens; unknown when not given. */
  contextWindow?: number;
  maxTokens?: number;
  /** Whether the model says it reasons: true when not given. */
  reasoning?: boolean;
  /** Every reply ignores the call's signal. */
  ignoreAbort?: boolean;
}

export interface ScriptedModel {
  /** `initialState.model` of an `Agent` that answers from the script. */
  readonly model: Model<Api>;
  /** Its `streamFn`. */
  readonly streamFn: StreamFn;
  /** Every request received, in order. */
  readonly requests: readonly RecordedRequest[];
  readonly clock: FakeClock;
  /** How many of the script's answers are still to be given. */
  readonly left: number;
  /** Adds answers after those the script still has. */
  add(...answers: Answer[]): void;
  /** A gate a reply can hold at (`{ hold: gate }`). */
  gate(): Gate;
  /** The model as the model layer gives one to an agent. */
  agentModel(thinkingLevel?: ThinkingLevel): AgentModel;
}

const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The words of a stream cut off half way: a provider's, for a stream that ended before its answer did. */
const CUT_WORDS = "The stream ended before the answer did.";
/** The words of a call stopped by its signal. */
const STOPPED_WORDS = "The call was stopped.";

function usageOf(given: ReplyUsage | undefined): Usage {
  const input = given?.input ?? 0;
  const output = given?.output ?? 0;
  const cacheRead = given?.cacheRead ?? 0;
  const cacheWrite = given?.cacheWrite ?? 0;
  return { ...NO_USAGE, input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, ...(given?.reasoning !== undefined ? { reasoning: given.reasoning } : {}), cost: { ...NO_USAGE.cost } };
}

function recordedOptions(options: SimpleStreamOptions | undefined): RecordedOptions {
  if (options === undefined) return {};
  const { temperature, maxTokens, samplingParams, reasoning, sessionId, cacheRetention, toolChoice } = options;
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(samplingParams !== undefined ? { samplingParams: { ...samplingParams } } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(cacheRetention !== undefined ? { cacheRetention } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
  };
}

/** Why a reply stopped before its end: the call's signal ended. */
class Stopped extends Error {}

export function scriptedModel(answers: readonly Answer[], options: ScriptedOptions = {}): ScriptedModel {
  const clock = options.clock ?? new FakeClock();
  const script = [...answers];
  const requests: RecordedRequest[] = [];
  const model: Model<Api> = {
    id: options.id ?? "scripted",
    name: options.name ?? "Scripted model",
    api: "scripted",
    provider: "rig",
    baseUrl: "",
    reasoning: options.reasoning ?? true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? 0,
    maxTokens: options.maxTokens ?? 0,
  };
  const limits: ModelLimits = {
    contextWindow: options.contextWindow !== undefined ? { tokens: options.contextWindow, from: "user" } : null,
    maxTokens: options.maxTokens !== undefined ? { tokens: options.maxTokens, from: "user" } : null,
  };

  /** Plays one reply into `out`; `listens` says whether the call's signal stops it. */
  const play = async (reply: Reply, request: RecordedRequest, asked: Model<Api>, signal: AbortSignal | undefined, out: AssistantMessageEventStream): Promise<void> => {
    const listens = !(reply.ignoreAbort ?? options.ignoreAbort ?? false);
    const watched = listens ? signal : undefined;
    const message: AssistantMessage = { role: "assistant", content: [], api: asked.api, provider: asked.provider, model: asked.id, usage: usageOf(undefined), stopReason: "stop", timestamp: clock.now() };
    const stopIfAsked = (): void => {
      if (watched?.aborted === true) throw new Stopped();
    };
    /** The block now being written, with its place in the content: text or thinking. */
    let open: { kind: "text"; at: number; block: TextContent } | { kind: "thinking"; at: number; block: ThinkingContent } | undefined;
    const close = (): void => {
      if (open === undefined) return;
      if (open.kind === "text") out.push({ type: "text_end", contentIndex: open.at, content: open.block.text, partial: message });
      else out.push({ type: "thinking_end", contentIndex: open.at, content: open.block.thinking, partial: message });
      open = undefined;
    };
    const pushed = (kind: PushedPiece["kind"], text: string): void => {
      request.pushed.push({ kind, text, at: clock.now(), wall: performance.now() });
    };
    try {
      stopIfAsked();
      out.push({ type: "start", partial: message });
      let calls = 0;
      for (const piece of reply.pieces) {
        if ("wait" in piece) {
          await clock.sleep(piece.wait, watched).catch(() => {
            throw new Stopped();
          });
          continue;
        }
        if ("hold" in piece) {
          if (!piece.hold.isOpen) {
            const { promise: ended, resolve: end } = Promise.withResolvers<void>();
            watched?.addEventListener("abort", () => end(), { once: true });
            await Promise.race([piece.hold.opened, ended]);
          }
          stopIfAsked();
          continue;
        }
        stopIfAsked();
        if ("text" in piece) {
          if (open?.kind !== "text") {
            close();
            const block: TextContent = { type: "text", text: "" };
            message.content.push(block);
            open = { kind: "text", at: message.content.length - 1, block };
            out.push({ type: "text_start", contentIndex: open.at, partial: message });
          }
          const { at, block } = open;
          block.text += piece.text;
          pushed("text", piece.text);
          out.push({ type: "text_delta", contentIndex: at, delta: piece.text, partial: message });
        } else if ("thinking" in piece) {
          if (open?.kind !== "thinking") {
            close();
            const block: ThinkingContent = { type: "thinking", thinking: "" };
            message.content.push(block);
            open = { kind: "thinking", at: message.content.length - 1, block };
            out.push({ type: "thinking_start", contentIndex: open.at, partial: message });
          }
          const { at, block } = open;
          block.thinking += piece.thinking;
          if (piece.signature !== undefined) block.thinkingSignature = piece.signature;
          pushed("thinking", piece.thinking);
          out.push({ type: "thinking_delta", contentIndex: at, delta: piece.thinking, partial: message });
        } else {
          close();
          calls += 1;
          const call: ToolCall = { type: "toolCall", id: piece.id ?? `call_${request.index + 1}_${calls}`, name: piece.call, arguments: piece.args ?? {} };
          message.content.push(call);
          const at = message.content.length - 1;
          const args = JSON.stringify(call.arguments);
          out.push({ type: "toolcall_start", contentIndex: at, partial: message });
          out.push({ type: "toolcall_delta", contentIndex: at, delta: args, partial: message });
          pushed("call", args);
          out.push({ type: "toolcall_end", contentIndex: at, toolCall: call, partial: message });
        }
      }
      stopIfAsked();
      message.usage = usageOf(reply.usage);
      const end = reply.end ?? (calls > 0 ? "toolUse" : "stop");
      if (end === "cut" || typeof end === "object") {
        // A provider's stream that breaks leaves its open block as it was.
        message.stopReason = "error";
        message.errorMessage = end === "cut" ? CUT_WORDS : end.error;
        out.push({ type: "error", reason: "error", error: message });
        return;
      }
      close();
      message.stopReason = end;
      out.push({ type: "done", reason: end, message });
    } catch (error) {
      if (!(error instanceof Stopped)) throw error;
      message.stopReason = "aborted";
      message.errorMessage = STOPPED_WORDS;
      out.push({ type: "error", reason: "aborted", error: message });
    }
  };

  const streamFn: StreamFn = (asked, context, streamOptions) => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      // Kept before anything else, in the order the calls came: this part runs before the stream function returns.
      const request: RecordedRequest = { index: requests.length, model: asked.id, messages: [], tools: [], options: recordedOptions(streamOptions), at: clock.now(), pushed: [] };
      requests.push(request);
      const answer = script.shift();
      try {
        // Copied as JSON, which is what a request is: what came is kept as it was, whatever is done to it later.
        request.messages = JSON.parse(JSON.stringify(context.messages));
        request.tools = JSON.parse(JSON.stringify(getCurrentTools(context.messages)));
        if (answer === undefined) throw new Error(`The script has no answer for call ${request.index + 1}.`);
        const reply = typeof answer === "function" ? await answer(request) : answer;
        await play(reply, request, asked, streamOptions?.signal, out);
      } catch (error) {
        // A stream function never throws: what went wrong ends the answer, in its words.
        const words = error instanceof Error ? error.message : String(error);
        out.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: asked.api, provider: asked.provider, model: asked.id, usage: usageOf(undefined), stopReason: "error", errorMessage: words, timestamp: clock.now() } });
      }
    })();
    return out;
  };

  return {
    model,
    streamFn,
    requests,
    clock,
    get left() {
      return script.length;
    },
    add(...more) {
      script.push(...more);
    },
    gate,
    agentModel(thinkingLevel = "off") {
      return { model, thinkingLevel, streamFn, limits };
    },
  };
}

/** Scripted models in the model layer's place, and every choice they were asked for. */
export interface ScriptedSource extends ModelSource {
  /** Each call's choice, in order, as the harness made it: the user it names and the connection and model it picks. For a test to read. */
  readonly asked: readonly UserChoice[];
}

/**
 * Scripted models in the model layer's place, made for one user: a choice that names another is
 * refused in words, as the layer's own desk refuses a model made for another user's choice, so a
 * test fails where an agent, a job or a judge is given the wrong user's. Otherwise an agent's choice
 * is answered by the model its `model` names (else its `connectionId`), and one no script names is
 * refused in words, as the layer refuses a connection that isn't there. Every choice asked for is
 * kept in `asked`, the refused ones too.
 */
export function scriptedSource(models: Readonly<Record<string, ScriptedModel>>, user: string): ScriptedSource {
  const asked: UserChoice[] = [];
  return {
    asked,
    async agentModel(choice: UserChoice) {
      asked.push(choice);
      if (choice.user !== user) throw new Error(`The scripted models are made for the user ${JSON.stringify(user)}, and this choice names ${JSON.stringify(choice.user)}.`);
      const name = choice.model ?? choice.connectionId ?? "";
      const found = Object.hasOwn(models, name) ? models[name] : undefined;
      if (found === undefined) throw new Error(`No scripted model is named "${name}".`);
      return found.agentModel(choice.effort === undefined || choice.effort === "inherit" || choice.effort === "auto" ? "off" : choice.effort);
    },
  };
}
