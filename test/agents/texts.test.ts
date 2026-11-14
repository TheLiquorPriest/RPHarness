// Everything a sub-agent is sent is a file (§17.2, Y21, Y25), checked by `test/harness/texts.test.ts`'s
// method: every text of every request of a turn with sub-agents (the lead's, each sub-agent's, their
// tool declarations and every tool answer) is accounted for as a file of the agents' tree, the
// request, the host's data, or the model's own words. Nothing may be left over: a word the code
// wrote itself would be.
import { afterEach, expect, test } from "bun:test";
import type { Message, Tool } from "@earendil-works/pi-ai";
import type { JsonValue } from "../../src/contract";
import { CHARACTER, CHAT, definition, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

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

/** The texts a request sends a model: every message but the model's own, and every description of every tool it declares. */
function sentTexts(messages: readonly Message[], tools: readonly Tool[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") continue;
    const content = message.content;
    if (typeof content === "string") texts.push(content);
    else for (const part of content) if (part.type === "text") texts.push(part.text);
  }
  const described = (schema: unknown): void => {
    if (typeof schema !== "object" || schema === null) return;
    for (const [key, value] of Object.entries(schema)) {
      if (key === "description" && typeof value === "string") texts.push(value);
      else described(value);
    }
  };
  for (const tool of tools) {
    texts.push(tool.description);
    described(tool.parameters);
  }
  return texts;
}

/** The model's own words, in every request: what it wrote, and every string, name and id of its calls. */
function modelsOwn(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => (message.role !== "assistant" ? [] : message.content.flatMap((part) => (part.type === "text" ? [part.text] : part.type === "thinking" ? [part.thinking] : [part.id, part.name, ...strings(part.arguments as JsonValue)]))));
}

const PLAYER = "She leaps for the far ledge.";
const SCENE = "The gap to the far ledge is twenty feet.\n";
const LEDGE = "A shelf of wet basalt, never climbed since the old keeper fell.";
const VIEW = "Fixture view: the lamp room; the storm breaks within the hour.";
const MESSAGES = [
  { role: "user" as const, name: "Mara", text: "We climb the stairs." },
  { role: "assistant" as const, name: "Wren Hale", text: "The far ledge glistens in the rain." },
  { role: "user" as const, name: "Mara", text: PLAYER },
];

test("every text sent to the lead and its sub-agents is a file, the request, the host's data, or the model's own words", async () => {
  const s = (open = await stage({
    files: {
      ".agents/lead.md": definition("lead", { model: "lead-model", tools: ["delegate", "agent_message"] }, "Fixture lead: you run the turn."),
      ".agents/gm.md": definition("gm", { model: "gm-model", tools: ["file_read", "ask_author"], reads: ["rules"], given: ["world:scene"] }, "Fixture GM: rule on what you are asked."),
      ".agents/keeper.md": definition("keeper", { model: "keeper-model", tools: ["delegate", "file_write"], reads: ["rules"] }, "Fixture keeper: note what happened."),
      ".rules/fixture-measure.md": "---\ndescription: Fixture - a reminder on reading the scene.\nagents: [gm]\ncondition: twenty feet\nscope: [result:file_read]\n---\nFixture rule: measure twice.\n",
      "config.yml": "limits:\n  turn:\n    depth: 1\n",
      [`chats/${CHARACTER}/${CHAT}/persistent-workspace/scene.md`]: SCENE,
    },
    messages: MESSAGES,
    lore: [{ id: "e-112", source: "Fixture book", title: "The far ledge", keys: ["ledge"], text: LEDGE }],
    views: { "world:scene": VIEW },
    models: {
      "lead-model": [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump.", attach: ["chat:history[-2:]", "lore:e-112", "file:persistent-workspace/scene.md", "lore:e-999"], returns: "One line: does she make it?" }, id: "d-1" }] },
        { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Twenty feet, as the file says.", consent: { topic: "the rail", bounds: "rotten or sound" } }, id: "m-1" }, { call: "agent_message", args: { agent: "gm-9", message: "Hello?" }, id: "m-2" }] },
        { pieces: [{ call: "delegate", args: { agent: "nobody", brief: "Anything." }, id: "d-2" }, { call: "delegate", args: { agent: "keeper", brief: "Note the outcome." }, id: "d-3" }] },
        { pieces: [{ text: "Settled." }] },
      ],
      "gm-model": [
        { pieces: [{ call: "file_read", args: { path: "persistent-workspace/scene.md" }, id: "r-1" }] },
        { pieces: [{ call: "ask_author", args: { question: "Is the gap really that wide?", searched: "the scene file" }, id: "a-1" }] },
        { pieces: [{ text: "She does not make it." }] },
      ],
      "keeper-model": [
        { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Check the rail." }, id: "d-4" }, { call: "file_write", args: { path: "persistent-workspace/outcome.md", op: "write", text: "The jump failed." }, id: "w-1" }] },
        { pieces: [{ text: "Noted." }] },
      ],
    },
  }));

  const outcome = await (await s.play(PLAYER)).done;
  expect(outcome.status).toBe("done");

  const requests = Object.values(s.models).flatMap((model) => model.requests);
  expect(requests).toHaveLength(9);
  const known = [
    ...(await s.files()).flatMap(pieces),
    PLAYER,
    ...requests.flatMap((req) => modelsOwn(req.messages)),
    // What each model answered, its last answer included, which only the agent that started it reads.
    ...requests.flatMap((req) => req.pushed.map((piece) => piece.text)),
    // A name the GM's definition lists in `given:`, as its file writes it inside the list.
    "world:scene",
    // The host's data: the chat's messages, the lore entry, the view.
    ...MESSAGES.flatMap((message) => [message.name, message.text]),
    "The far ledge",
    "Fixture book",
    LEDGE,
    VIEW,
  ].sort((a, b) => b.length - a.length);

  // Each path a sub-agent's work may take is in these requests.
  const all = requests.flatMap((req) => sentTexts(req.messages, req.tools)).join("\n");
  for (const expected of [
    "You are working for the lead on one turn of a roleplay.",
    "## What to send back",
    "Fixture view: the lamp room",
    "#1 Wren Hale: The far ledge glistens in the rain.",
    "The far ledge (Fixture book)",
    "Fixture rule: measure twice.",
    "gm-1 stopped to ask before going on:",
    "gm-1 answered:",
    "gm-1 was not given lore:e-999: it could not be found.",
    "No agent you started this turn goes by gm-9.",
    "There is no agent definition named nobody.",
    "gm was not started: it would stand 2 deep, and the player allows 1.",
    "Wrote persistent-workspace/outcome.md",
    "keeper-1 answered:",
    "# Do not fill gaps on your own",
  ]) {
    expect(all).toContain(expected);
  }

  const unaccounted = requests.flatMap((req) => sentTexts(req.messages, req.tools).map((text) => ({ model: req.model, call: req.index + 1, left: leftOver(text, known) }))).filter(({ left }) => /\p{L}/u.test(left));
  expect(unaccounted).toEqual([]);
});
