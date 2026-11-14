// `lore_read` and `lore_search` (§6.8, §9.4), over the host's lore: entries in full by id, and a
// search of every source attached to the chat, both as the calling agent may read them. The host
// decides what a reader may know (an agent that plays a character is given only what that character
// may know) and renders an entry's secrets in its text (§9.6); these tools mark who may know each
// entry, which is how the lead and the GM see every one.
import type { LoreEntry } from "../../contract";
import { answer, argumentsOf, fieldsOf, type OwnTool, text, whole, type Words } from "../kit";
import { type BaseToolsDeps, linesAnswer, shown, textsOf, wordsOf } from "./deps";

/** An entry in full: its head, who may know it where its source says, and its text. */
function laid(words: Words, entry: LoreEntry): string {
  const knowing = entry.knowing;
  return shown([
    words("lore_entry", { id: entry.id, title: entry.title, source: entry.source, keys: entry.keys.join(", ") }),
    knowing?.by === "characters" ? words("lore_known_by", { names: knowing.names }) : undefined,
    knowing?.by === "gate" ? words("lore_gate", { gate: knowing.gate, ...(knowing.open ? { open: true } : {}) }) : undefined,
    entry.text,
  ]).join("\n");
}

export function loreRead(deps: BaseToolsDeps): OwnTool {
  const own = deps.texts.get("lore_read");
  return {
    name: "lore_read",
    family: "lore",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ ids: { type: "array", items: { type: "string" } } }, ["ids"], own),
    async run(args, ctx) {
      const ids = [...new Set(textsOf(fieldsOf(args)["ids"]))];
      const [words, entries] = await Promise.all([wordsOf(deps.guidance), ids.length === 0 ? [] : deps.env.lore.read(ctx.scope, ids, ctx.agent)]);
      if (entries.length === 0) return ids.length === 0 ? answer(words("none_found"), true) : linesAnswer(ids.map((id) => words("no_entry", { id })), "\n", true);
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      // In the order asked: an entry the reader may not know is left out by the host, and said here as one it does not have.
      return linesAnswer(
        ids.map((id) => {
          const entry = byId.get(id);
          return entry === undefined ? words("no_entry", { id }) : laid(words, entry);
        }),
        "\n\n",
      );
    },
  };
}

export function loreSearch(deps: BaseToolsDeps): OwnTool {
  const own = deps.texts.get("lore_search");
  return {
    name: "lore_search",
    family: "lore",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ query: { type: "string" }, sources: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1 } }, ["query"], own),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const sources = textsOf(given["sources"]);
      const limit = whole(given, "limit");
      const query = { text: text(given, "query") ?? "", ...(sources.length > 0 ? { sources } : {}), ...(limit !== undefined ? { limit } : {}) };
      const [words, hits] = await Promise.all([wordsOf(deps.guidance), deps.env.lore.search(ctx.scope, query, ctx.agent)]);
      if (hits.length === 0) return answer(words("none_found"));
      return linesAnswer(
        hits.map((hit) => words("lore_hit", { id: hit.id, title: hit.title, source: hit.source, snippet: hit.snippet, ...(hit.how === "meaning" ? { meaning: true } : {}) })),
        "\n",
      );
    },
  };
}
