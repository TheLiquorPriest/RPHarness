// `chat_read` and `chat_search` (§6.8), over the host's chat: any message or stretch of the active
// path, each message whole, whether or not the history window kept it in the prompt (§4.2); and a
// search over the whole chat. Hidden and summarized messages come marked. A long answer is clipped
// by what runs around every call (the user's `results.clip`), as every tool's is.
import type { ChatMessage, JsonValue } from "../../contract";
import { answer, argumentsOf, fieldsOf, type OwnTool, text, whole, type Words } from "../kit";
import { type BaseToolsDeps, linesAnswer, wordsOf } from "./deps";

/** A stretch asked for, as positions, the last included; or an id the chat does not have. */
type Asked = { from: number; to: number } | { unknown: string };

/** The stretch the arguments ask for, in a chat of `length` messages. `positions` finds a message's place by its id. */
async function askedOf(given: Readonly<Record<string, JsonValue>>, length: number, positions: () => Promise<ReadonlyMap<string, number>>): Promise<Asked> {
  const last = whole(given, "last");
  if (last !== undefined) return { from: Math.max(0, length - last), to: length - 1 };
  const fromId = text(given, "from_id");
  const toId = text(given, "to_id");
  const from = fromId !== undefined ? (await positions()).get(fromId) : (whole(given, "from") ?? 0);
  if (from === undefined) return { unknown: fromId ?? "" };
  const to = toId !== undefined ? (await positions()).get(toId) : (whole(given, "to") ?? length - 1);
  if (to === undefined) return { unknown: toId ?? "" };
  return { from, to };
}

/** A message as the answers' file lays it out: its text, or the line for a hidden one whose text agents may not read. */
function laid(words: Words, message: ChatMessage): string | undefined {
  const fields = { index: message.index, id: message.id, name: message.name };
  if (message.text === undefined) return words("chat_withheld", fields);
  return words("chat_message", { ...fields, text: message.text, ...(message.hidden === true ? { hidden: true } : {}), ...(message.summarized === true ? { summarized: true } : {}) });
}

export function chatRead(deps: BaseToolsDeps): OwnTool {
  const own = deps.texts.get("chat_read");
  return {
    name: "chat_read",
    family: "chat",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf(
      {
        from: { type: "integer", minimum: 0 },
        to: { type: "integer", minimum: 0 },
        from_id: { type: "string" },
        to_id: { type: "string" },
        last: { type: "integer", minimum: 1 },
      },
      [],
      own,
    ),
    async run(args, ctx) {
      const { chat } = deps.env;
      const [words, info] = await Promise.all([wordsOf(deps.guidance), chat.info(ctx.scope)]);
      const { length } = info;
      if (length === 0) return answer(words("chat_empty"));
      // The port reads by position, so a message named by its id is found on the active path, once.
      let found: Promise<ReadonlyMap<string, number>> | undefined;
      const positions = () => (found ??= chat.read(ctx.scope, { from: 0, to: length }).then((all) => new Map(all.map((message) => [message.id, message.index]))));
      const asked = await askedOf(fieldsOf(args), length, positions);
      if ("unknown" in asked) return answer(words("no_message", { id: asked.unknown }), true);
      const messages = await chat.read(ctx.scope, { from: asked.from, to: asked.to + 1 });
      const first = messages[0];
      const end = messages.at(-1);
      if (first === undefined || end === undefined) return answer(words("chat_outside", { length, last: length - 1, from: asked.from, to: asked.to }), true);
      return linesAnswer([words("chat_range", { from: first.index, to: end.index, length }), ...messages.map((message) => laid(words, message))], "\n\n");
    },
  };
}

export function chatSearch(deps: BaseToolsDeps): OwnTool {
  const own = deps.texts.get("chat_search");
  return {
    name: "chat_search",
    family: "chat",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ query: { type: "string" }, limit: { type: "integer", minimum: 1 } }, ["query"], own),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const limit = whole(given, "limit");
      const [words, hits] = await Promise.all([wordsOf(deps.guidance), deps.env.chat.search(ctx.scope, { text: text(given, "query") ?? "", ...(limit !== undefined ? { limit } : {}) })]);
      if (hits.length === 0) return answer(words("none_found"));
      return linesAnswer(
        hits.map((hit) => words("chat_hit", { index: hit.index, id: hit.id, name: hit.name, snippet: hit.snippet, ...(hit.how === "meaning" ? { meaning: true } : {}) })),
        "\n",
      );
    },
  };
}
