// Everything an agent is sent is a file (§17.2, Y21, Y25): every text in every request two whole
// turns send a model (the lead's calls and the narrator's, their tool declarations and every tool
// answer), with each part of it accounted for as a file of the agents' tree, the request the host
// sent, a tool's own data, or the model's own words. Nothing may be left over: a word the code wrote
// itself would be.
import { afterEach, expect, test } from "bun:test";
import type { Message, Tool } from "@earendil-works/pi-ai";
import type { JsonValue, TurnRequest } from "../../src/contract";
import { PROMPT, request, said, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** A rule on the reply that stops the call, a rule due at every turn's start, a rule on a write's result, and one that holds a write. */
const RULES = {
  ".rules/fixture-phrase.md": "---\ndescription: Fixture - no shivers.\nagents: [author]\ncondition: shiver ran down\nscope: [reply]\n---\nFixture rule: that phrase is worn out. Say it another way.\n",
  ".rules/fixture-start.md": "---\ndescription: Fixture - a nudge at every turn's start.\nagents: [author]\nat: turn-start\n---\nFixture rule: the storm is the scene's clock.\n",
  ".rules/fixture-unsourced.md": "---\ndescription: Fixture - a write with no source.\nagents: [author]\ncondition: marked unsourced\nscope: [result:world_apply]\n---\nFixture rule: say where that came from.\n",
  ".rules/fixture-vault.md": "---\ndescription: Fixture - the vault stays shut.\nagents: [author]\ncondition: vault\nscope: [arguments:world_apply]\nhold: true\n---\nFixture rule: the vault stays shut.\n",
};

const TIDES = "Tide table: high water at six, low water at noon, and the spring tide on the fourth night of the storm.";

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

test("every text sent to a model in two whole turns is a file, the request, a tool's data, or the model's own words", async () => {
  const s = (open = await stage({
    drafted: true,
    config: "results:\n  clip: 90\n",
    files: RULES,
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
    },
    answers: [
      // Turn one, the lead: an intent record, then a reply a rule on the reply stops.
      { pieces: [{ text: "<intent>Wants: the boat. Engine lane: nothing changes.</intent><reply>The hall is dark. Something moves, and a shiver ran down her spine. " }] },
      // It goes on under the rule's text, and makes every kind of call there is.
      {
        pieces: [
          { text: "<reply>Something moves; she runs.</reply>" },
          { call: "world_query" },
          { call: "world_apply", args: { what: "the vault" } },
          { call: "world_apply", args: { what: "the boat is lost" } },
          { call: "story_query" },
          { call: "fly_away" },
          { call: "file_write", args: { path: "persistent-workspace/boat.md", op: "write", text: "The boat is two days late." } },
          { call: "file_read", args: { path: "persistent-workspace/missing.md" } },
          { call: "file_find", args: { by: "glob", pattern: "*.md", path: "persistent-workspace" } },
          { call: "todo", args: { items: [{ text: "record the boat", done: false }] } },
          { call: "reply_release", args: {} },
        ],
      },
      { pieces: [{ text: "That is everything for this turn." }] },
      // Turn two, the lead: the prose goes to the narrator, as a draft, then out.
      { pieces: [{ call: "write_reply", args: { brief: "Wren says the boat has not come." } }] },
      // The narrator.
      { pieces: [{ text: " has not come, Wren says." }] },
      { pieces: [{ call: "reply_release", args: { closing: true } }] },
    ],
  }));

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
  const second = request("t2", { kind: "swipe", prefill: "The boat", prompt: [...PROMPT, { role: "assistant", content: "The boat" }], presetSampling: { temperature: 0.8 } });
  const two = await s.turn(second);
  expect(two.outcome).toMatchObject({ status: "released", form: "narrator" });

  const requests = s.model.requests;
  expect(requests).toHaveLength(6);
  const known = [
    ...(await s.files()).flatMap(pieces),
    ...requestTexts(first),
    ...requestTexts(second),
    ...requests.flatMap((req) => modelsOwn(req.messages)),
    TIDES,
    // The tide table as the model read it, clipped, and the file its whole was kept in.
    TIDES.slice(0, 90),
    "sessions/s1/turns/t1/cache/results/call_2_1.md",
    // The host's own tool descriptions, from its manifest.
    "Fixture: reads the world.",
    "Fixture: records a change.",
    "Fixture: a read whose store is locked.",
    "recorded",
    "Fixture: the ledger is locked.",
    "sessions/s1/turns/t1/",
    "sessions/s1/turns/t2/",
    "persistent-workspace",
    // The path of the file the player changed, as the host's file port names it.
    "@global/WRITING.md",
  ].sort((a, b) => b.length - a.length);

  // Each path a turn may take is in these requests: the frame, the briefing with every part RPH lays out, the rule's text and
  // the line to go on under, the reply's second attempt, the tool answers, a clipped result, a held call, a rule on a result,
  // a tool that threw and one nobody holds, the changed file's notice, and the narrator's request.
  const all = requests.flatMap((req) => sentTexts(req.messages, req.tools)).join("\n");
  for (const expected of [
    "What follows is the prompt the chat application assembled",
    "## From your rules",
    "Fixture rule: the storm is the scene's clock.",
    "Fixture rule: that phrase is worn out.",
    "The player has already been shown the text below.",
    "characters shown. The whole result is in",
    "Fixture rule: the vault stays shut.",
    "Fixture rule: say where that came from.",
    "story_query failed: Fixture: the ledger is locked.",
    "You hold no tool named fly_away.",
    "Wrote persistent-workspace/boat.md",
    "There is no file at persistent-workspace/missing.md.",
    "1 open, 0 done.",
    "The reply for this turn has already gone out.",
    "## Files changed since this session opened",
    "Fixture: keep it to three sentences.",
    "The prompt above is the one the chat application assembled for this reply.",
  ]) {
    expect(all).toContain(expected);
  }

  const unaccounted = requests.flatMap((req, n) => sentTexts(req.messages, req.tools).map((text) => ({ request: n + 1, left: leftOver(text, known) }))).filter(({ left }) => /\p{L}/u.test(left));
  expect(unaccounted).toEqual([]);
});

test("the check finds a text that came from nowhere", () => {
  const known = pieces("---\ndescription: Fixture.\n---\nThe reply went {{where}}.\n").sort((a, b) => b.length - a.length);
  expect(/\p{L}/u.test(leftOver("The reply went out.", [...known, "out"]))).toBe(false);
  expect(/\p{L}/u.test(leftOver("The reply went out. Tool execution was blocked", [...known, "out"]))).toBe(true);
});
