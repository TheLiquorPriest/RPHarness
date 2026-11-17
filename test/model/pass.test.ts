// A request that is no turn, passed through on the connection the host names, streamed back as it
// comes, ended with its tool calls and its tokens. Its body is OpenAI's chat completions: on a
// connection that speaks that API it goes as it came, field for field, but its model; through another
// API it is carried as that API can carry it. What that API has no place for refuses the request
// before anything is sent, in words that name it and say what to do, a message named by its place in
// the body; so does a picture to a model that takes none, on any API.

import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject, PassError, PassResult } from "../../src/contract";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, chatStream, chunk, eventStream, forever, rig, USER } from "./support";

const LOOKUP = { type: "function", function: { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: { what: { type: "string" } } } } };

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

const BODY: JsonObject = {
  model: "whatever-the-chat-app-names",
  stream: true,
  messages: [
    { role: "system", content: "You summarize harbour gossip." },
    { role: "user", content: "What happened at the mill?" },
  ],
  tools: [LOOKUP],
  max_tokens: 321,
  temperature: 0.4,
  top_p: 0.8,
  reasoning_effort: "low",
  parallel_tool_calls: false,
  response_format: { type: "json_object" },
  user: "harbour-reader",
  logit_bias: { "50256": -100 },
};

/** BODY without what only a connection that speaks OpenAI's chat completions has a place for: what any connection's API carries. */
const { response_format: _format, user: _user, logit_bias: _bias, ...CARRIED } = BODY;

const ANTHROPIC_KEY = "sk-ant-api03-0123456789abcdef";

/** The model's two lookups and their results, as a body carries them: two tool messages after the assistant's calls. */
const LOOKED_UP: JsonObject[] = [
  { role: "user", content: "Who keeps the mill, and since when?" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_keeper", type: "function", function: { name: "lookup", arguments: '{"what":"keeper"}' } },
      { id: "call_since", type: "function", function: { name: "lookup", arguments: '{"what":"since"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_keeper", content: "Okoro." },
  { role: "tool", tool_call_id: "call_since", content: "Last spring." },
];

/** A prefix for the model to go on from, as the last message. */
const PREFIX: JsonObject = { role: "assistant", content: "Okoro has kept it", prefix: true };

/** What a passed request's sink heard: its pieces, and its one end. */
interface Heard {
  content: string[];
  reasoning: string[];
  result?: PassResult;
  error?: PassError;
  ends: number;
}

/** Passes `body` on the connection `connection` and gathers what the sink heard. */
async function pass(made: Rig, body: JsonObject, connection: string | null = "id1", signal: AbortSignal = forever()): Promise<Heard> {
  const heard: Heard = { content: [], reasoning: [], ends: 0 };
  await made.layer.api.pass(USER, { connection, body }, { content: (d) => heard.content.push(d), reasoning: (d) => heard.reasoning.push(d), finish: (result) => ((heard.result = result), (heard.ends += 1)), error: (e) => ((heard.error = e), (heard.ends += 1)) }, signal);
  expect(heard.ends).toBe(1);
  return heard;
}

/** The words a request is refused with as not carried; nothing of it is sent. */
async function refusal(made: Rig, body: JsonObject): Promise<string> {
  const heard = await pass(made, body);
  if (heard.error?.code !== "not-carried") throw new Error(`a refusal in words was expected, not ${JSON.stringify(heard)}`);
  return heard.error.detail ?? "";
}

/** Words of a refusal: what of the request can't be carried, then why nothing of it goes. */
const refused = (what: string): string => `This request wasn't passed on: ${what}. A request that is no turn goes to its connection whole or not at all, so that nothing of a prompt is dropped on the way.`;

describe("a request passed through", () => {
  test("streams its text as it comes, and ends with its tool calls and its tokens", async () => {
    const faux = fauxProvider({ provider: "groq", models: [{ id: "faux-1" }], tokenSize: { min: 1, max: 1 } });
    faux.setResponses([fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("lookup", { what: "mill" }, { id: "call_9" })], { stopReason: "toolUse" })]);
    r = rig({ providers: [faux.provider] });
    await r.layer.api.save(USER, { name: "Writer", provider: "groq", auth: "key", model: "faux-1" }, "gsk_0123456789abcdefghij");
    // pi-ai's faux provider speaks an API of its own: the body is carried as it can carry it.
    const heard = await pass(r, CARRIED);
    expect(heard.content.join("")).toBe("Let me look.");
    expect(heard.result).toMatchObject({ content: "Let me look.", finishReason: "tool_calls", model: "faux-1", toolCalls: [{ id: "call_9", name: "lookup", args: { what: "mill" } }] });
    expect(heard.result?.usage).toMatchObject({ calls: 1, input: expect.any(Number), output: expect.any(Number) });
  });

  test("on a chat-completions connection a body with a speaker's name, audio, video and a picture by address arrives as sent, field for field, but its model; on Anthropic's API a speaker's name is refused by name and nothing is sent", async () => {
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "The wheel broke." }), chunk({}, "stop")])) });
    await r.layer.api.save(USER, { name: "Writer", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" });
    const body: JsonObject = {
      ...BODY,
      stream: false,
      messages: [
        { role: "system", content: "You summarize harbour gossip.", name: "keeper" },
        {
          role: "user",
          name: "Okoro",
          content: [
            { type: "text", text: "What do you hear, and what is this?" },
            { type: "input_audio", input_audio: { data: "UklGRiQAAAA=", format: "wav" } },
            { type: "video_url", video_url: { url: "https://media.example.com/quay.mp4" } },
            { type: "image_url", image_url: { url: "https://images.example.com/reef.png", detail: "high" } },
          ],
        },
        { role: "assistant", content: "The wheel", prefix: true },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
    };
    expect((await pass(r, body)).result?.content).toBe("The wheel broke.");
    // Its model is the connection's, and the call streams its answer to read it as it comes; nothing else is the layer's.
    const { model, stream, stream_options: _usage, ...rest } = bodyOf(r.sent[0]);
    const { model: _asked, stream: _once, ...asSent } = body;
    expect([model, stream, rest]).toEqual(["served-model", true, asSent]);

    const claude = await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, ANTHROPIC_KEY);
    const heard = await pass(r, { ...CARRIED, messages: [{ role: "user", content: "Hello", name: "Okoro" }] }, claude.id);
    expect(heard.error).toEqual({ code: "not-carried", detail: refused("message 1 names its speaker (`name`), which model calls have no place for: put the name in the message's text, or leave it out") });
    expect(r.sent).toHaveLength(1);
  });

  test("a picture sent through to a model that takes none fails with a line naming the picture and the model, and nothing reaches the server", async () => {
    r = rig();
    const saved = await r.layer.api.save(USER, { name: "Writer", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model", limits: { "served-model": { pictures: false } } });
    const body: JsonObject = { ...BODY, messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }] };
    expect((await pass(r, body, saved.id)).error).toEqual({ code: "not-carried", detail: refused('message 1\'s part 2 is a picture, and the model "served-model" on the connection "Writer" takes no pictures: send the request without it, or on a connection whose model takes pictures') });
    expect(r.sent).toEqual([]);
  });

  test("audio or a video sent through to a model its connection says takes none fails with a line naming the part and the model, and nothing reaches the server", async () => {
    r = rig();
    const saved = await r.layer.api.save(USER, { name: "Writer", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model", limits: { "served-model": { audio: false, video: false } } });
    const audio: JsonObject = { ...BODY, messages: [{ role: "user", content: [{ type: "text", text: "Listen." }, { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } }] }] };
    expect((await pass(r, audio, saved.id)).error).toEqual({ code: "not-carried", detail: refused('message 1\'s part 2 is audio, and the model "served-model" on the connection "Writer" takes no audio: send the request without it, or on a connection whose model takes audio') });
    const video: JsonObject = { ...BODY, messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } }] }] };
    expect((await pass(r, video, saved.id)).error).toEqual({ code: "not-carried", detail: refused('message 1\'s part 1 is a video, and the model "served-model" on the connection "Writer" takes no video: send the request without it, or on a connection whose model takes video') });
    expect(r.sent).toEqual([]);
  });

  test("gives a provider with another API what it has a place for, refuses by name each field it has none for, and continues a prefix where Anthropic can", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: " broke at dawn." }))) });
    await r.layer.api.save(USER, { name: "Writer", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, ANTHROPIC_KEY);
    const messages = [...(BODY.messages as JsonObject[]), { role: "assistant", content: "The wheel", prefix: true }];
    expect((await pass(r, { ...CARRIED, messages, reasoning_effort: "none" })).result?.content).toBe(" broke at dawn.");
    const body = bodyOf(r.sent[0]);
    expect(body).toMatchObject({ max_tokens: 321, temperature: 0.4, top_p: 0.8, thinking: { type: "disabled" }, tool_choice: { disable_parallel_tool_use: true } });
    expect(Object.keys(body)).not.toContain("reasoning_effort");
    expect((body.messages as { role: string; content: unknown }[]).at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "The wheel" }] });
    // What Anthropic's API has no place for, sampling it doesn't take among it, is named, never dropped, and nothing of the request goes.
    for (const [field, value] of [["response_format", { type: "json_object" }], ["user", "harbour-reader"], ["frequency_penalty", 0.3], ["reasoning", { effort: "low", max_tokens: 900 }]] as const) {
      expect((await pass(r, { ...CARRIED, [field]: value })).error).toEqual({ code: "not-carried", detail: refused(`it has the field \`${field}\`, which the connection "Writer" (Anthropic, claude-sonnet-4-5) has no place for: leave it out, or send the request on a connection that speaks OpenAI's chat completions, where it goes as it came`) });
    }
    expect(r.sent).toHaveLength(1);
  });

  test("continues a prefix after the tools' results where Anthropic can: the results go back as the user's turn, and the prefix last", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: " since last spring." }))) });
    await r.layer.api.save(USER, { name: "Writer", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, ANTHROPIC_KEY);
    expect((await pass(r, { ...CARRIED, messages: [...LOOKED_UP, PREFIX], reasoning_effort: "none" })).result?.content).toBe(" since last spring.");
    const sent = bodyOf(r.sent[0]).messages as { role: string; content: string | { type: string }[] }[];
    expect(sent.map((m) => [m.role, typeof m.content === "string" ? ["text"] : m.content.map((b) => b.type)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["tool_use", "tool_use"]],
      ["user", ["tool_result", "tool_result"]],
      ["assistant", ["text"]],
    ]);
    expect(sent.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Okoro has kept it" }] });
  });

  test("through another API, refuses what it has no place for, in words that name it by its place in the body and say what to do, and sends nothing", async () => {
    const made = rig();
    r = made;
    await made.layer.api.save(USER, { name: "Writer", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, ANTHROPIC_KEY);
    const user = (content: unknown, more: JsonObject = {}): JsonObject => ({ ...CARRIED, messages: [{ role: "user", content, ...more }] as JsonObject[] });
    const refusals: [JsonObject, string][] = [
      [user("Hello", { name: "Okoro" }), "message 1 names its speaker (`name`), which model calls have no place for: put the name in the message's text, or leave it out"],
      // Each of the body's tool messages counts as one of its messages, though the two go on as one.
      [{ ...CARRIED, messages: [...LOOKED_UP, { role: "user", content: "And before him?", name: "Mara" }] }, "message 5 names its speaker (`name`)"],
      [user([{ type: "input_audio", input_audio: { data: "UklGRiQAAAA=", format: "wav" } }]), "message 1's part 1 is audio, and model calls carry text and images only: leave it out, or give what it holds as text"],
      [user([{ type: "text", text: "What happens here?" }, { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAAIGZ0eXA=" } }]), "message 1's part 2 is a video, and model calls carry text and images only"],
      [user([{ type: "image_url", image_url: { url: "https://images.example.com/reef.png" } }]), "message 1's part 1 is given by its address (https://images.example.com/reef.png), and model calls take media only as its data"],
      [user([{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "high" } }]), "message 1's part 1 asks for its image at `detail: high`, which model calls have no place for: leave `detail` out"],
      // An image goes in a user's message: a system message carries its text alone, and a message of the model's own its text, reasoning and tool calls.
      [{ ...CARRIED, messages: [{ role: "system", content: [{ type: "text", text: "You keep the harbour's log." }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }, { role: "user", content: "What came in?" }] }, "message 1's part 2 is an image in a system message, and model calls carry a system message's text only: put the image in a user's message, or leave it out"],
      [{ ...CARRIED, messages: [{ role: "user", content: "Show me the reef." }, { role: "assistant", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }, { role: "user", content: "Again." }] }, "message 2's part 1 is an image in a message of the model's own, and model calls carry only the text, reasoning and tool calls of one: put the image in a user's message, or leave it out"],
      [{ ...CARRIED, tool_choice: "required" }, 'it asks the model to call a tool (`tool_choice`: "required"), and model calls let the model choose a tool or call none: set `tool_choice` to "auto" or "none", or leave it out'],
      [{ ...CARRIED, tool_choice: { type: "function", function: { name: "lookup" } } }, "it asks the model to call a tool (`tool_choice`: {"],
      [{ ...CARRIED, messages: [...LOOKED_UP.slice(0, 1), { role: "assistant", content: "The keeper", prefix: true }, { role: "user", content: "Go on." }] }, "message 2 is marked as a prefix to continue (`prefix`), and only the last message, the model's own, can be one: take the mark off"],
    ];
    for (const [body, words] of refusals) {
      const said = await refusal(made, body);
      expect(said).toStartWith("This request wasn't passed on: ");
      expect(said).toContain(words);
    }
    expect(made.sent).toEqual([]);
  });

  test("each size is its setting: a set calls.quotedChars changes how much of a media address the refusal quotes, from the next request", async () => {
    const address = `https://images.example.com/${"reef-".repeat(30)}.png`;
    const made = rig({ global: "calls:\n  quotedChars: 20\n" });
    r = made;
    await made.layer.api.save(USER, { name: "Writer", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, ANTHROPIC_KEY);
    const body = { ...CARRIED, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: address } }] }] as JsonObject[] };
    expect(await refusal(made, body)).toContain(`is given by its address (${address.slice(0, 20)}…), and model calls`);
    made.configs.global = "";
    // As it is where nothing is set: 80 characters.
    expect(await refusal(made, body)).toContain(`is given by its address (${address.slice(0, 80)}…), and model calls`);
    expect(made.sent).toEqual([]);
  });

  test("refuses a prefix where the connection's API can't continue one, after the tools' results too, and sends nothing", async () => {
    r = rig();
    await r.layer.api.save(USER, { name: "Writer", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", api: "openai-responses", model: "served-model" });
    const words = refused('the last message is a prefix to continue (`prefix`), and the connection "Writer" (OpenAI-compatible, served-model) can\'t continue one: only Anthropic\'s API continues a message given to it. Take the mark off to send the message as one the model wrote before, or use a connection to an earlier Claude model than 4.6');
    // A model of OpenAI's responses API nobody lists is taken to reason, and takes no temperature or top_p.
    const { temperature: _warmth, top_p: _nucleus, ...plain } = CARRIED;
    expect(await refusal(r, { ...plain, messages: [...(BODY.messages as JsonObject[]), PREFIX] })).toBe(words);
    expect(await refusal(r, { ...plain, messages: [...LOOKED_UP, PREFIX] })).toBe(words);
    // `partial`, Moonshot's name for the same mark, is the same prefix.
    expect(await refusal(r, { ...plain, messages: [...LOOKED_UP, { role: "assistant", content: "Okoro has kept it", partial: true }] })).toBe(words);
    expect(r.sent).toEqual([]);
  });

  test("refuses a prefix Anthropic itself would: to Claude 4.6 and later whatever they are asked, and to an earlier model asked to think, by the request or by its connection", async () => {
    const made = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: " since last spring." }))) });
    r = made;
    const saved = await made.layer.api.save(USER, { name: "Writer", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, ANTHROPIC_KEY);
    const writer = async (model: string, effort?: "medium"): Promise<void> => {
      await made.layer.api.save(USER, { id: saved.id, name: "Writer", provider: "anthropic", auth: "key", model, effort: effort ?? null });
    };
    const prefixed = (more: JsonObject = {}): JsonObject => ({ ...CARRIED, reasoning_effort: "none", messages: [...LOOKED_UP, PREFIX], ...more });
    // pi-ai marks the models from Claude 4.6 on as thinking adaptively; on those that take an effort mark (5 and later), its mark would follow the prefix, which then wouldn't be last.
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5", "claude-sonnet-5-5"]) {
      await writer(model);
      expect(await refusal(made, prefixed())).toBe(refused(`the last message is a prefix to continue (\`prefix\`), and the connection "Writer" (Anthropic, ${model}) can't continue one: Anthropic refuses a prefix to Claude 4.6 and later. Leave the message out, or use a connection to an earlier Claude model`));
    }
    await writer("claude-sonnet-4-5");
    expect(await refusal(made, prefixed({ reasoning_effort: "high" }))).toBe(refused('the last message is a prefix to continue (`prefix`), and the connection "Writer" (Anthropic, claude-sonnet-4-5) can\'t continue one while its model thinks, as the request asks it to (`reasoning_effort`: "high"): send "none" there instead'));
    const { reasoning_effort: _none, ...asksNone } = prefixed();
    expect(await refusal(made, { ...asksNone, reasoning: { effort: "low" } })).toContain('as the request asks it to (`reasoning.effort`: "low")');
    await writer("claude-sonnet-4-5", "medium");
    expect(await refusal(made, asksNone)).toBe(refused('the last message is a prefix to continue (`prefix`), and the connection "Writer" (Anthropic, claude-sonnet-4-5) can\'t continue one while its model thinks, as the connection\'s effort (medium) has it do: send `reasoning_effort`: "none" with the request, or set the connection\'s effort to off'));
    expect(made.sent).toEqual([]);
    // Asked not to think, the same model on the same connection continues it.
    expect((await pass(made, prefixed())).result?.content).toBe(" since last spring.");
  });

  test("with no connection to go on, or a provider's failure, or a stop, ends in an error of that kind", async () => {
    const made = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "The wheel" })]).replace("data: [DONE]\n\n", "")) });
    r = made;
    expect((await pass(made, BODY, "id9")).error).toEqual({ code: "no-connection", detail: "This call's connection is no longer there: pick another on the Connections page." });
    await made.layer.api.save(USER, { name: "Writer", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" });
    expect((await pass(made, BODY, null)).error?.code).toBe("provider");
    const stop = new AbortController();
    stop.abort(new Error("The request was stopped."));
    expect((await pass(made, BODY, null, stop.signal)).error).toEqual({ code: "stopped", detail: "The request was stopped." });
    expect(made.sent.length).toBe(1);
  });
});
