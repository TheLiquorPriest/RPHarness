// Everything an agent is sent is a file (§17.2, Y21, Y25): every text in every request five whole
// turns send a provider, as the provider receives it (pi-ai's own OpenAI-compatible adapter, over a
// server answered from a script, so that what the adapter adds shows too), each part of it accounted
// for as a file of the agents' tree, the request the host sent, a tool's own data, or the model's own
// words. Nothing may be left over: a word the code wrote itself would be.
//
// The turns take these paths: in the tag form, the frame, the briefing with every part RPH lays out,
// a rule that stops the reply and the line to go on under, a second reply, RPH's own tools' answers
// (a write, a refused write, a missing file, a search that lacks its pattern, a list, a second
// release), a clipped result, a held call, a rule on a result, a tool that threw, one nobody holds,
// a write where the player allows none and one the player declined, calls cut short at the length
// limit, and a changed file's notice; the narrator, as a draft, as a draft it leaves empty, and live;
// and the two-step form, with a release before any draft and a hand-over to a writer nobody defined.
import { afterEach, expect, test } from "bun:test";
import type { ApprovalsPort, JsonObject, JsonValue, TurnRequest } from "../../src/contract";
import { chunk } from "../model/support";
import { CHARACTER, CHAT, PROMPT, request, said, type Stage, stage, type WatchedSink } from "./support";

const opened: Stage[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
});

/** A rule on the reply that stops the call, a rule due at every turn's start, a rule on a write's result, and one that holds a write. */
const RULES = {
  ".rules/fixture-phrase.md": "---\ndescription: Fixture - no shivers.\nagents: [author]\ncondition: shiver ran down\nscope: [reply]\n---\nFixture rule: that phrase is worn out. Say it another way.\n",
  ".rules/fixture-start.md": "---\ndescription: Fixture - a nudge at every turn's start.\nagents: [author]\nat: turn-start\n---\nFixture rule: the storm is the scene's clock.\n",
  ".rules/fixture-unsourced.md": "---\ndescription: Fixture - a write with no source.\nagents: [author]\ncondition: marked unsourced\nscope: [result:world_apply]\n---\nFixture rule: say where that came from.\n",
  ".rules/fixture-vault.md": "---\ndescription: Fixture - the vault stays shut.\nagents: [author]\ncondition: vault\nscope: [arguments:world_apply]\nhold: true\n---\nFixture rule: the vault stays shut.\n",
};

const TIDES = "Tide table: high water at six, low water at noon, and the spring tide on the fourth night of the storm.";

/** One answer of the provider's server: the text and the tool calls it streams, in order, and how it ends when not as the model finished. */
interface Said {
  steps: ({ text: string } | { call: string; args?: JsonObject })[];
  end?: "length";
}

/**
 * A provider's server behind an OpenAI-compatible connection: each request is answered with the
 * next of `answers`, streamed one event at a time with a turn of the event loop between events, as
 * a server's stream comes; and each request's body is kept, the payload exactly as the provider
 * receives it. A call's id is `call_<request>_<call>`, both counted from 1.
 */
function server(answers: readonly Said[]): { fetch: typeof globalThis.fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const encoder = new TextEncoder();
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(await new Request(input, init).text()) as Record<string, unknown>);
    const n = bodies.length;
    const steps = answers[n - 1]?.steps ?? [];
    let calls = 0;
    const deltas = steps.map((step, at): Record<string, unknown> => {
      const role = at === 0 ? { role: "assistant" } : {};
      if ("text" in step) return { ...role, content: step.text };
      calls += 1;
      return { ...role, tool_calls: [{ index: calls - 1, id: `call_${n}_${calls}`, type: "function", function: { name: step.call, arguments: JSON.stringify(step.args ?? {}) } }] };
    });
    const events = [...deltas.map((delta) => chunk(delta)), chunk({}, answers[n - 1]?.end ?? (calls > 0 ? "tool_calls" : "stop"))].map((event) => `data: ${JSON.stringify(event)}\n\n`);
    events.push("data: [DONE]\n\n");
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const pause = Promise.withResolvers<void>();
        setImmediate(pause.resolve);
        await pause.promise;
        if (signal?.aborted === true) controller.error(signal.reason);
        else {
          const event = events.shift();
          if (event === undefined) controller.close();
          else controller.enqueue(encoder.encode(event));
        }
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: Object.assign(answer, { preconnect: (): void => undefined }), bodies };
}

/** A stage whose models are reached through the model layer, on one saved connection to `served`'s server. */
async function served(answers: readonly Said[], options: Omit<Parameters<typeof stage>[0], "answers" | "fetch">): Promise<{ s: Stage; bodies: Record<string, unknown>[] }> {
  const { fetch, bodies } = server(answers);
  const s = await stage({ ...options, fetch, answers: [] });
  opened.push(s);
  const saved = await s.harness.models.save({ name: "Harbour", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "fixture-model" });
  await s.harness.models.setDefault(saved.id);
  return { s, bodies };
}

/** The literal pieces of a file: its text split wherever a template puts something in, each line also without a header's or a line's `name: ` before it. */
function pieces(file: string): string[] {
  return file
    .split(/\{\{[^}]*\}\}/)
    .flatMap((piece) => piece.split("\n"))
    .flatMap((piece) => {
      const named = /^\s*[\w-]+: (.*)$/.exec(piece);
      return named?.[1] !== undefined ? [piece, named[1], piece.trim()] : [piece, piece.trim()];
    })
    .filter((piece) => piece.trim() !== "");
}

/** Every string inside a JSON value. */
function strings(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/** What of `text` is left once every known source is taken out of it, longest first. */
function leftOver(text: string, known: readonly string[]): string {
  let left = text;
  for (const source of known) if (source !== "") left = left.split(source).join("\u0001");
  return left;
}

/** The texts a request's body sends the model: every message's text, whoever's it is, and every description in every tool it declares. */
function sentTexts(body: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as { content?: unknown }[]) : [];
  for (const { content } of messages) {
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) for (const part of content as { text?: unknown }[]) if (typeof part.text === "string") texts.push(part.text);
  }
  const described = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "description" && typeof inner === "string") texts.push(inner);
      else described(inner);
    }
  };
  described(body["tools"]);
  return texts;
}

/** The model's own words: everything it streamed, each piece and each answer's text whole, and every name and string of its calls. */
function modelsOwn(answers: readonly Said[]): string[] {
  return answers.flatMap((answer) => {
    const texts = answer.steps.flatMap((step) => ("text" in step ? [step.text] : []));
    return [...texts, texts.join(""), ...answer.steps.flatMap((step) => ("call" in step ? [step.call, ...strings(step.args)] : []))];
  });
}

function requestTexts(req: TurnRequest): string[] {
  return [
    ...req.prompt.map((message) => (typeof message.content === "string" ? message.content : "")),
    ...req.briefing.flatMap((part) => [part.name, part.text]),
    ...req.since.map((item) => item.text),
    ...(req.asked ?? []),
    req.prefill ?? "",
    req.kind,
    req.speaker ?? "",
  ];
}

/** The model's own words as the player was shown them, which the line to go on under repeats. */
function shown(sinks: readonly WatchedSink[]): string[] {
  return sinks.flatMap((sink) => sink.pieces.map((piece) => piece.text.trim()));
}

/** The answer a call got, as a provider was sent it: the text of the tool message for that call, or "" when none was sent. */
function answerTo(bodies: readonly Record<string, unknown>[], id: string): string {
  for (const body of bodies) {
    const messages = Array.isArray(body["messages"]) ? (body["messages"] as { role?: unknown; tool_call_id?: unknown; content?: unknown }[]) : [];
    const found = messages.find((message) => message.role === "tool" && message.tool_call_id === id);
    if (found !== undefined) return sentTexts({ messages: [found] }).join("");
  }
  return "";
}

/** The names a request declares its tools by: each tool's, and each of its arguments'. A line that names an argument takes it from here. */
function declaredNames(body: Record<string, unknown>): string[] {
  const names: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "name" && typeof inner === "string") names.push(inner);
      if (key === "properties" && typeof inner === "object" && inner !== null) names.push(...Object.keys(inner));
      walk(inner);
    }
  };
  walk(body["tools"]);
  return names;
}

/** Each result kept whole in a turn's folder because it was too long to show whole: its path as agents see it, and its text. */
async function keptResults(s: Stage): Promise<{ path: string; text: string }[]> {
  const chat = `${s.dir}/files/chats/${CHARACTER}/${CHAT}`;
  const kept: { path: string; text: string }[] = [];
  for await (const path of new Bun.Glob("sessions/*/turns/*/cache/results/*.md").scan({ cwd: chat })) kept.push({ path, text: await Bun.file(`${chat}/${path}`).text() });
  return kept;
}

/** What of each request's texts nothing accounts for. */
function unaccounted(bodies: readonly Record<string, unknown>[], known: string[]): { request: number; left: string }[] {
  const sorted = [...known].sort((a, b) => b.length - a.length);
  return bodies.flatMap((body, n) => sentTexts(body).map((text) => ({ request: n + 1, left: leftOver(text, sorted) }))).filter(({ left }) => /\p{L}/u.test(left));
}

/** The player's settings: no writes in the story lane, and asked first in the cast lane, where the answer is no. */
const APPROVALS: ApprovalsPort = {
  permission: async (_scope, lane) => (lane === "story" ? "never" : lane === "cast" ? "confirm" : "auto"),
  ask: async () => ({ go: false, reason: "Not tonight." }),
};

test("every text sent to a provider in five whole turns, as the provider receives it, is a file, the request, a tool's data, or the model's own words", async () => {
  const tagged: Said[] = [
    // Turn one, the lead: an intent record, then a reply a rule on the reply stops once its first sentence was shown.
    { steps: [{ text: "<intent>Wants: the boat. Engine lane: nothing changes.</intent><reply>The hall is dark. " }, { text: "Something moves, and a shiver ran down her spine. " }] },
    // It goes on under the rule's text and the line that says where the player's view ends, and makes every kind of call there is.
    {
      steps: [
        { text: "<reply>Something moves; she runs.</reply>" },
        { call: "world_query" },
        { call: "world_apply", args: { what: "the vault" } },
        { call: "world_apply", args: { what: "the boat is lost" } },
        { call: "story_query" },
        { call: "story_record", args: { what: "the boat is lost" } },
        { call: "cast_update", args: { what: "Wren is cold" } },
        { call: "fly_away" },
        { call: "file_write", args: { path: "persistent-workspace/boat.md", op: "write", text: "The boat is two days late." } },
        { call: "file_write", args: { path: "WRITING.md", op: "write", text: "Fixture: shorter." } },
        { call: "file_read", args: { path: "persistent-workspace/missing.md" } },
        { call: "file_find", args: { by: "glob", pattern: "*.md", path: "persistent-workspace" } },
        { call: "file_find", args: { by: "grep" } },
        { call: "todo", args: { items: [{ text: "record the boat", done: false }] } },
        { call: "reply_release", args: {} },
      ],
    },
    // Its last calls, cut short at the length limit.
    { steps: [{ text: "Noting it." }, { call: "todo", args: { items: [] } }], end: "length" },
    { steps: [{ text: "That is everything for this turn." }] },
    // Turn two, the lead: the prose goes to the narrator, as a draft, then out.
    { steps: [{ call: "write_reply", args: { brief: "Wren says the boat has not come." } }] },
    // The narrator.
    { steps: [{ text: " has not come, Wren says." }] },
    { steps: [{ call: "reply_release", args: { closing: true } }] },
    // Turn three, the lead: a draft the narrator leaves empty, then the narrator live, the hand-over closing.
    { steps: [{ call: "write_reply", args: { brief: "Wren says the boat may come at dawn." } }] },
    { steps: [] },
    { steps: [{ call: "write_reply", args: { brief: "Wren says the boat may come at dawn.", live: true, closing: true } }] },
    // The narrator, live.
    { steps: [{ text: "At dawn, perhaps," }, { text: " Wren says." }] },
  ];
  const { s, bodies } = await served(tagged, {
    drafted: true,
    config: "results:\n  clip: 90\n",
    files: RULES,
    approvals: APPROVALS,
    tools: {
      world_query: { tier: "read", description: "Fixture: reads the world.", run: async () => said(TIDES) },
      world_apply: { tier: "write", lane: "engine", description: "Fixture: records a change.", parameters: { properties: { what: { type: "string" } } }, run: async () => ({ content: [{ type: "text", text: "recorded" }], marks: ["unsourced"] }) },
      story_query: {
        tier: "read",
        description: "Fixture: a read whose store is locked.",
        run: async () => {
          throw new Error("Fixture: the ledger is locked.");
        },
      },
      story_record: { tier: "write", lane: "story", description: "Fixture: records the story.", parameters: { properties: { what: { type: "string" } } }, run: async () => said("kept") },
      cast_update: { tier: "write", lane: "cast", description: "Fixture: changes a character.", parameters: { properties: { what: { type: "string" } } }, run: async () => said("changed") },
    },
  });

  const first = request("t1", {
    speaker: "Wren Hale",
    asked: ["play it in full"],
    since: [{ kind: "edit", text: "Message 4 was edited after its turn." }],
    briefing: [{ name: "world-state", text: "Gannet Rock, the lamp room. The storm is an hour off." }],
  });
  const one = await s.turn(first);
  expect(one.outcome.status).toBe("released");
  // Between the turns the player changes a file the lead's opening block holds: the next briefing gives its whole text.
  await Bun.write(`${s.dir}/files/WRITING.md`, "# Writing the reply\n\nFixture: keep it to three sentences.\n");
  const second = request("t2", { kind: "swipe", parent: "t0", prefill: "The boat", prompt: [...PROMPT, { role: "assistant", content: "The boat" }], presetSampling: { temperature: 0.8 } });
  const two = await s.turn(second);
  expect(two.outcome).toMatchObject({ status: "released", form: "narrator" });
  const third = request("t3", { parent: "t2" });
  const three = await s.turn(third);
  expect(three.outcome).toMatchObject({ status: "released", form: "narrator-live", reply: "At dawn, perhaps, Wren says." });
  expect(bodies).toHaveLength(tagged.length);

  // Turn four, in the two-step form, on RPH's own guidance: working text, a release with no draft, a hand-over to a writer nobody defined, the intent record to its file; then the reply.
  const plain: Said[] = [
    {
      steps: [
        { text: "Checking the notes first." },
        { call: "reply_release", args: {} },
        { call: "write_reply", args: { brief: "Wren shakes her head." } },
        { call: "file_write", args: { path: "sessions/s1/turns/t4/scratch/intent.md", op: "write", text: "Wants: news of the boat." } },
      ],
    },
    { steps: [{ text: "Wren shakes her head. No boat, not in this sea." }, { call: "todo", args: { items: [], closing: true } }] },
  ];
  const plainStage = await served(plain, { config: "reply:\n  form: two-step\n" });
  const fourth = request("t4", { lead: "lead" });
  const four = await plainStage.s.turn(fourth);
  expect(four.outcome).toMatchObject({ status: "released", form: "message", reply: "Wren shakes her head. No boat, not in this sea." });
  expect(plainStage.bodies).toHaveLength(plain.length);

  // Each path was taken, whatever the words the files give it: every call above got an answer of its own, and the fixtures' texts went where they go.
  for (const call of ["call_2_1", "call_2_2", "call_2_3", "call_2_4", "call_2_5", "call_2_6", "call_2_7", "call_2_8", "call_2_9", "call_2_10", "call_2_11", "call_2_12", "call_2_13", "call_2_14", "call_3_1", "call_8_1"]) expect(answerTo(bodies, call)).not.toBe("");
  for (const call of ["call_1_1", "call_1_2", "call_1_3"]) expect(answerTo(plainStage.bodies, call)).not.toBe("");
  const all = [...bodies, ...plainStage.bodies].flatMap(sentTexts).join("\n");
  for (const expected of [
    "Fixture rule: the storm is the scene's clock.",
    "Fixture rule: that phrase is worn out.",
    "Fixture rule: the vault stays shut.",
    "Fixture rule: say where that came from.",
    "Fixture: the ledger is locked.",
    "Not tonight.",
    "Fixture: keep it to three sentences.",
    "Wren says the boat may come at dawn.",
  ]) {
    expect(all).toContain(expected);
  }
  // The line to go on under, after the rule stopped the reply, holds what the player had been shown; nothing else in that request does.
  expect(sentTexts(bodies[1]!).some((text) => text.includes("The hall is dark."))).toBe(true);

  // What the host gave: its tools' descriptions, from its manifest; what its tools answered; the player's reason for a no; where agents may write, each
  // turn's folder and the lanes, as its ports name them; and the path of the file the player changed.
  const places = await s.env.files.places(first.scope);
  const hostData = [
    TIDES,
    "Fixture: reads the world.",
    "Fixture: records a change.",
    "Fixture: a read whose store is locked.",
    "Fixture: records the story.",
    "Fixture: changes a character.",
    "recorded",
    "Fixture: the ledger is locked.",
    "Not tonight.",
    ...places.writable,
    ...["t1", "t2", "t3", "t4"].map((turn) => `sessions/s1/turns/${turn}/`),
    "persistent-workspace",
    "story",
    "@global/WRITING.md",
  ];
  const tags = [...(await s.files()).flatMap(pieces), ...[first, second, third].flatMap(requestTexts), ...modelsOwn(tagged), ...shown([one.sink, two.sink, three.sink]), ...bodies.flatMap(declaredNames), ...hostData];
  // A result too long to read whole is kept in the turn's folder and shown clipped: once its whole is accounted for, so are its first characters and where it is kept.
  for (const { path, text } of await keptResults(s)) {
    expect(unaccounted([{ messages: [{ content: text }] }], tags)).toEqual([]);
    tags.push(path, text.slice(0, 90));
  }
  expect(unaccounted(bodies, tags)).toEqual([]);
  expect(unaccounted(plainStage.bodies, [...(await plainStage.s.files()).flatMap(pieces), ...requestTexts(fourth), ...modelsOwn(plain), ...shown([four.sink]), ...plainStage.bodies.flatMap(declaredNames), ...hostData])).toEqual([]);
});

test("the check finds a text that came from nowhere", () => {
  const known = pieces("---\ndescription: Fixture.\n---\nThe reply went {{where}}.\n");
  expect(unaccounted([{ messages: [{ role: "tool", content: "The reply went out." }] }], [...known, "out"])).toEqual([]);
  const [found] = unaccounted([{ messages: [{ role: "tool", content: "The reply went out. (no tool output)" }] }], [...known, "out"]);
  expect(found?.left).toContain("(no tool");
});
