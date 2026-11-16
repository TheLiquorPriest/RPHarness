// The folder host's web searcher (§6.8 `web_search`): off until the host's config names an address
// that answers a search, `host/config.json` `{ "web": { "address": "https://search.example/api" } }`.
// A search asks `<address>?q=<words>&limit=<n>` and reads a JSON list of `{ "url", "title",
// "snippet" }`; nothing else leaves the machine, and no redirect is followed.

import { join } from "node:path";
import type { SearchHit, WebSearchPort } from "../../contract/index";
import { isRecord } from "../../contract/json";
import { hostLimits } from "./config";
import { readJson } from "./disk";
import type { Site } from "./site";

/** The address the host's config names for web searches, if it names one. */
async function addressOf(site: Site): Promise<string | undefined> {
  const raw: unknown = await readJson(join(site.host, "config.json")).catch(() => undefined);
  const web = isRecord(raw) && isRecord(raw.web) ? raw.web : undefined;
  return typeof web?.address === "string" && web.address.trim() !== "" ? web.address.trim() : undefined;
}

export function folderWeb(site: Site): WebSearchPort {
  return {
    async enabled(scope) {
      site.serves(scope);
      return (await addressOf(site)) !== undefined;
    },

    async search(scope, query) {
      site.serves(scope);
      const address = await addressOf(site);
      if (address === undefined) return [];
      const limit = query.limit ?? (await hostLimits(site)).searchHits;
      const url = new URL(address);
      url.searchParams.set("q", query.text);
      url.searchParams.set("limit", String(limit));
      const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`The web search answered ${response.status}.`);
      const body: unknown = await response.json();
      const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.results) ? body.results : [];
      return list.slice(0, limit).flatMap((r): SearchHit[] => (isRecord(r) && typeof r.url === "string" ? [{ ref: r.url, title: typeof r.title === "string" ? r.title : r.url, snippet: typeof r.snippet === "string" ? r.snippet : "", how: "words" }] : []));
    },
  };
}
