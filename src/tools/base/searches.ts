// `archive_search` and `web_search` (§6.8): searches of what the host keeps besides the chat and the
// lore (databanks, the chat application's memory, summaries), and of the web. Each is made only
// when the host offers a searcher for it, so an agent never holds a tool that has nothing behind it.
import type { SearchHit, StoresPort } from "../../contract";
import type { LoopToolResult } from "../../loop/types";
import { answer, argumentsOf, fieldsOf, type OwnTool, text, whole, type Words } from "../kit";
import { type BaseToolsDeps, linesAnswer, shown, textsOf, type WebSearchPort, wordsOf } from "./deps";

/** Hits, one line each by `line`, or the line for none. */
function hitsAnswer(words: Words, line: string, hits: readonly SearchHit[]): LoopToolResult {
  if (hits.length === 0) return answer(words("none_found"));
  return linesAnswer(
    hits.map((hit) => words(line, { ref: hit.ref, title: hit.title, snippet: hit.snippet, ...(hit.how === "meaning" ? { meaning: true } : {}) })),
    "\n",
  );
}

export function archiveSearch(deps: BaseToolsDeps, stores: StoresPort): OwnTool {
  const own = deps.texts.get("archive_search");
  return {
    name: "archive_search",
    family: "stores",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ query: { type: "string" }, stores: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1 }, ref: { type: "string" } }, [], own),
    async run(args, ctx) {
      const { scope } = ctx;
      const given = fieldsOf(args);
      const words = await wordsOf(deps.guidance);
      const ref = text(given, "ref")?.trim() || undefined;
      if (ref !== undefined) {
        const item = await stores.read(scope, ref);
        if (item === undefined) return answer(words("no_item", { ref }), true);
        return answer(shown([words("archive_item", { ref: item.ref, store: item.store, title: item.title }), item.text]).join("\n"));
      }
      const query = text(given, "query")?.trim() || undefined;
      if (query === undefined) return answer(words("archive_needs"), true);
      const named = [...new Set(textsOf(given["stores"]))];
      if (named.length > 0) {
        const kept = (await stores.list(scope)).map((store) => store.name);
        const unknown = named.find((name) => !kept.includes(name));
        if (unknown !== undefined) return answer(words("no_store", { name: unknown, stores: kept.join(", ") }), true);
      }
      const limit = whole(given, "limit");
      return hitsAnswer(words, "archive_hit", await stores.search(scope, { text: query, ...(named.length > 0 ? { stores: named } : {}), ...(limit !== undefined ? { limit } : {}) }));
    },
  };
}

export function webSearch(deps: BaseToolsDeps, web: WebSearchPort): OwnTool {
  const own = deps.texts.get("web_search");
  return {
    name: "web_search",
    family: "web",
    tier: "external",
    description: own?.description ?? "",
    parameters: argumentsOf({ query: { type: "string" }, limit: { type: "integer", minimum: 1 } }, ["query"], own),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const limit = whole(given, "limit");
      const [words, hits] = await Promise.all([wordsOf(deps.guidance), web.search(ctx.scope, { text: text(given, "query") ?? "", ...(limit !== undefined ? { limit } : {}) })]);
      return hitsAnswer(words, "web_hit", hits);
    },
  };
}
