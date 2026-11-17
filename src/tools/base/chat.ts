// `chat_read` and `chat_search` (§6.8), over the host's chat: any message or stretch of the active
// path, each message whole, whether or not the history window kept it in the prompt (§4.2); and a
// search over the whole chat. Hidden and summarized messages come marked, and so does a message the
// host's story choice leaves out of the story; asked for the story alone (`story: true`), either tool
// gives only the story's messages. One call takes at most the user's `tools.perCall`: a read stops
// there and says which stretch it gave. A long answer is clipped by what runs around every call (the
// user's `results.clipChars`), as every tool's is.
import type { ChatMessage, JsonValue } from "../../contract";
import { answer, argumentsOf, fieldsOf, type OwnTool, text, whole, type Words } from "../kit";
import { type BaseToolsDeps, heldLimit, inChat, linesAnswer, wordsOf } from "./deps";

/**
 * A stretch asked for, as positions, the last included: where it ends as asked (`to`) and as one
 * call takes it (`stop`), and whether the bound cut it short; or an id the chat does not have.
 */
type Asked = { from: number; to: number; stop: number; cut: boolean } | { unknown: string };

/**
 * The stretch the arguments ask for, in a chat of `length` messages, held to `most` messages: the
 * last few are the newest of them, and any other stretch stops `most` messages from its start.
 * `position` finds a message's place by its id.
 */
async function askedOf(given: Readonly<Record<string, JsonValue>>, length: number, most: number, position: (id: string) => Promise<number | undefined>): Promise<Asked> {
  const last = whole(given, "last");
  if (last !== undefined) return { from: Math.max(0, length - Math.min(last, most)), to: length - 1, stop: length - 1, cut: Math.min(last, length) > most };
  const fromId = text(given, "from_id");
  const toId = text(given, "to_id");
  const from = fromId !== undefined ? await position(fromId) : (whole(given, "from") ?? 0);
  if (from === undefined) return { unknown: fromId ?? "" };
  const to = toId !== undefined ? await position(toId) : (whole(given, "to") ?? length - 1);
  if (to === undefined) return { unknown: toId ?? "" };
  const stop = Math.min(to, from + most - 1);
  return { from, to, stop, cut: stop < Math.min(to, length - 1) };
}

/** The mark of a message or hit the host's story choice leaves out of the story, for its line. */
function outside(item: { story?: false }): { outside_story?: true } {
  return item.story === false ? { outside_story: true } : {};
}

/** A message as the answers' file lays it out: its text, or the line for a hidden one whose text agents may not read. */
function laid(words: Words, message: ChatMessage): string | undefined {
  const fields = { index: message.index, id: message.id, name: message.name, ...outside(message) };
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
        story: { type: "boolean" },
      },
      [],
      own,
    ),
    async run(args, ctx) {
      const at = await inChat(deps.guidance, ctx, "chat_read");
      if ("answer" in at) return at.answer;
      const { scope } = at;
      const { chat } = deps.env;
      const most = deps.perCall;
      const [words, info] = await Promise.all([wordsOf(deps.guidance), chat.info(scope)]);
      const { length } = info;
      if (length === 0) return answer(words("chat_empty"));
      // A message named by its id: its place asked of the host once, then one stretch read.
      const given = fieldsOf(args);
      const asked = await askedOf(given, length, most, (id) => chat.position(scope, id));
      if ("unknown" in asked) return answer(words("no_message", { id: asked.unknown }), true);
      const messages = await chat.read(scope, { from: asked.from, to: asked.stop + 1 });
      const first = messages[0];
      const end = messages.at(-1);
      if (first === undefined || end === undefined) return answer(words("chat_outside", { length, last: length - 1, from: asked.from, to: asked.to }), true);
      // The story alone: the stretch as read, less what the host's story choice leaves out.
      const shown = given["story"] === true ? messages.filter((message) => message.story !== false) : messages;
      const leftOut = messages.length - shown.length;
      return linesAnswer([words("chat_range", { from: first.index, to: end.index, length, ...(asked.cut ? { most } : {}), ...(leftOut > 0 ? { left_out: leftOut } : {}) }), ...shown.map((message) => laid(words, message))], "\n\n");
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
    parameters: argumentsOf({ query: { type: "string" }, limit: { type: "integer", minimum: 1 }, story: { type: "boolean" } }, ["query"], own),
    async run(args, ctx) {
      const at = await inChat(deps.guidance, ctx, "chat_search");
      if ("answer" in at) return at.answer;
      const given = fieldsOf(args);
      const story = given["story"] === true;
      const limit = heldLimit(whole(given, "limit"), deps.perCall);
      // For the story alone, the hits outside it are dropped before the limit is taken, so the host is asked for as many as one call gives.
      const asked = story ? deps.perCall : limit;
      const [words, found] = await Promise.all([wordsOf(deps.guidance), deps.env.chat.search(at.scope, { text: text(given, "query") ?? "", ...(asked !== undefined ? { limit: asked } : {}) })]);
      const hits = (story ? found.filter((hit) => hit.story !== false) : found).slice(0, limit ?? deps.perCall);
      if (hits.length === 0) return answer(words("none_found"));
      return linesAnswer(
        hits.map((hit) => words("chat_hit", { index: hit.index, id: hit.id, name: hit.name, snippet: hit.snippet, ...(hit.how === "meaning" ? { meaning: true } : {}), ...outside(hit) })),
        "\n",
      );
    },
  };
}
