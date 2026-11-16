// `archive_search` and `web_search` (§6.8), made for every host. `archive_search` searches the chat's
// earlier sessions, which RPH keeps itself (sessions.ts), and whatever other stores the host has
// (databanks, the chat application's memory, summaries), each hit under its store's name; a hit's
// ref reads it in full. `web_search` asks the host at each call whether a web search provider is on:
// while none is, or the host has no web searcher, it answers so and nothing leaves the machine.
// One call takes at most the user's `tools.perCall` hits.
import type { SearchHit, StoreInfo, StoresPort, WebSearchPort } from "../../contract";
import type { LoopToolResult } from "../../loop/types";
import { answer, argumentsOf, fieldsOf, type OwnTool, text, whole, type Words } from "../kit";
import { type BaseToolsDeps, heldLimit, inChat, linesAnswer, shown, textsOf, wordsOf } from "./deps";
import { SessionsStore } from "./sessions";

/** Hits, one line each by `line`, or the line for none. */
function hitsAnswer(words: Words, line: string, hits: readonly (SearchHit & { store?: string })[]): LoopToolResult {
  if (hits.length === 0) return answer(words("none_found"));
  return linesAnswer(
    hits.map((hit) => words(line, { ref: hit.ref, title: hit.title, snippet: hit.snippet, ...(hit.store !== undefined ? { store: hit.store } : {}), ...(hit.how === "meaning" ? { meaning: true } : {}) })),
    "\n",
  );
}

/** Lists taken in turn, one hit from each while any has one left, so no store's hits crowd out another's. */
function inTurn<T>(lists: readonly (readonly T[])[], most: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < most && lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (i < list.length && out.length < most) out.push(list[i]!);
  }
  return out;
}

export function archiveSearch(deps: BaseToolsDeps, stores: StoresPort | undefined): OwnTool {
  const own = deps.texts.get("archive_search");
  return {
    name: "archive_search",
    family: "stores",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ query: { type: "string" }, stores: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1 }, ref: { type: "string" } }, [], own),
    async run(args, ctx) {
      const at = await inChat(deps.guidance, ctx, "archive_search");
      if ("answer" in at) return at.answer;
      const { scope } = at;
      const given = fieldsOf(args);
      const words = await wordsOf(deps.guidance);
      const sessions = new SessionsStore(deps.env.files, words);
      const ref = text(given, "ref")?.trim() || undefined;
      if (ref !== undefined) {
        const item = (await sessions.read(scope, ref)) ?? (await stores?.read(scope, ref));
        if (item === undefined) return answer(words("no_item", { ref }), true);
        return answer(shown([words("archive_item", { ref: item.ref, store: item.store, title: item.title }), item.text]).join("\n"));
      }
      const query = text(given, "query")?.trim() || undefined;
      if (query === undefined) return answer(words("archive_needs"), true);
      const own = sessions.info();
      const theirs: StoreInfo[] = stores === undefined ? [] : (await stores.list(scope)).filter((store) => store.name !== own.name);
      const kept = [...theirs.map((store) => store.name), own.name];
      const named = [...new Set(textsOf(given["stores"]))];
      const unknown = named.find((name) => !kept.includes(name));
      if (unknown !== undefined) return answer(words("no_store", { name: unknown, stores: kept.join(", ") }), true);
      const asked = named.length > 0 ? named : kept;
      const limit = heldLimit(whole(given, "limit"), deps.perCall) ?? deps.perCall;
      // Each store searched apart, so each hit is under its store's name.
      const lists = await Promise.all(
        asked.map(async (name) => {
          const found = name === own.name ? await sessions.search(scope, query, limit) : await stores!.search(scope, { text: query, stores: [name], limit });
          return found.slice(0, limit).map((hit) => ({ ...hit, store: name }));
        }),
      );
      return hitsAnswer(words, "archive_hit", inTurn(lists, limit));
    },
  };
}

export function webSearch(deps: BaseToolsDeps, web: WebSearchPort | undefined): OwnTool {
  const own = deps.texts.get("web_search");
  return {
    name: "web_search",
    family: "web",
    tier: "external",
    description: own?.description ?? "",
    parameters: argumentsOf({ query: { type: "string" }, limit: { type: "integer", minimum: 1 } }, ["query"], own),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const words = await wordsOf(deps.guidance);
      // Asked at each call, so a provider set between two turns of one session holds from the next call, the tool list unchanged.
      if (web === undefined || !(await web.enabled(ctx.scope))) return answer(words("web_off"), true);
      const limit = heldLimit(whole(given, "limit"), deps.perCall);
      const found = await web.search(ctx.scope, { text: text(given, "query") ?? "", ...(limit !== undefined ? { limit } : {}) });
      return hitsAnswer(words, "web_hit", found.slice(0, limit ?? deps.perCall));
    },
  };
}
