// `gap_check` (§10.5): one search for a topic across every place the host can search (the chat, the
// lore, and each searcher the host offers: for RPE, the state and the story record) by the names
// and words given, and by meaning where the host has that set up. What was searched and what came
// back is saved with the turn, in its `queries/` folder, and the host is told; the answer says
// where. Each place is asked for, and keeps, at most the user's `tools.perCall` hits. Code proves
// nothing about meaning: it shows what was searched and what came back.
import type { GapCheck, GapSearch, SearchHit } from "../../contract";
import { answer, argumentsOf, fieldsOf, type OwnTool, text, whole } from "../kit";
import { type BaseToolsDeps, linesAnswer, textsOf, wordsOf } from "./deps";

/** Where a check's evidence is kept, inside the turn's own `queries/` folder. */
const EVIDENCE = "queries/gap-check-";

export function gapCheck(deps: BaseToolsDeps): OwnTool {
  const own = deps.texts.get("gap_check");
  return {
    name: "gap_check",
    family: "continuity",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ topic: { type: "string" }, terms: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1 } }, ["topic"], own),
    async run(args, ctx) {
      const { env } = deps;
      const { scope } = ctx;
      const given = fieldsOf(args);
      const topic = (text(given, "topic") ?? "").trim();
      const words = await wordsOf(deps.guidance);
      // A check of nothing would come back empty everywhere, which reads as a gap proven.
      if (topic === "") return answer(words("gap_no_topic"), true);
      const terms = [...new Set(textsOf(given["terms"]).map((term) => term.trim()))].filter((term) => term !== "" && term !== topic);
      const limit = Math.min(whole(given, "limit") ?? deps.gapHits, deps.perCall);
      const looked = [topic, ...terms].join(" ");
      const searches: { where: string; search(): Promise<SearchHit[]> }[] = [
        { where: "chat", search: async () => (await env.chat.search(scope, { text: looked, limit })).map((hit) => ({ ref: hit.id, title: hit.name, snippet: hit.snippet, how: hit.how })) },
        // The lore as the agent may read it: a character's agent checks only what its character may know (§9.4).
        { where: "lore", search: async () => (await env.lore.search(scope, { text: looked, limit }, ctx.agent)).map((hit) => ({ ref: hit.id, title: hit.title, snippet: hit.snippet, how: hit.how })) },
        ...env.searchers.map((searcher) => ({ where: searcher.name, search: () => searcher.search(scope, { topic, terms, limit, reader: ctx.agent }) })),
      ];
      const settled = await Promise.allSettled(searches.map(async (one) => one.search()));
      const searched: GapSearch[] = [];
      const failed: { where: string }[] = [];
      for (const [at, outcome] of settled.entries()) {
        const where = searches[at]?.where ?? "";
        // A place that could not be searched is not evidence of anything, so it is left out of what was searched. Its error's words are for whoever runs the host.
        if (outcome.status === "rejected") {
          failed.push({ where });
          env.log.warn("A place a gap check looks in could not be searched.", { place: where, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
        } else searched.push({ where, hits: outcome.value.slice(0, limit) });
      }
      const check: GapCheck = { id: deps.ids(), by: ctx.agent, topic, terms, searched };

      let saved: string | undefined;
      const turn = searched.length === 0 ? undefined : (await env.files.places(scope)).turn;
      if (turn !== undefined) {
        const path = `${turn}${EVIDENCE}${check.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
        const written = await env.files.write(scope, path, { op: "write", text: `${JSON.stringify(check, null, 2)}\n` }, "harness");
        if (written.status === "written") saved = written.path;
        else env.log.warn("A gap check's evidence could not be saved in the turn's folder.", { path, status: written.status });
      }
      if (searched.length > 0) {
        try {
          await env.events.gapCheck(scope, { ...check, ...(saved !== undefined ? { saved } : {}) });
        } catch (error) {
          env.log.error("The host could not be told of a gap check.", { check: check.id, error: error instanceof Error ? error.message : String(error) });
        }
      }

      return linesAnswer(
        [
          words("gap_head", { id: check.id, topic, terms: terms.join(", ") }),
          ...searched.flatMap((search) => [
            search.hits.length === 0 ? words("gap_place_none", { where: search.where }) : words("gap_place", { where: search.where, count: search.hits.length }),
            ...search.hits.map((hit) => words("gap_hit", { ref: hit.ref, title: hit.title, snippet: hit.snippet, ...(hit.how === "meaning" ? { meaning: true } : {}) })),
          ]),
          ...failed.map((failure) => words("gap_failed", failure)),
          saved !== undefined ? words("gap_saved", { path: saved }) : searched.length > 0 ? words("gap_unsaved") : undefined,
        ],
        "\n",
        searched.length === 0,
      );
    },
  };
}
