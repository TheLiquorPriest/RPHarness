// The host's other stores (§6.8 `archive_search`) and its searchers for `gap_check` (§10.5): folders
// of text in the host's own records, never in an agent's view.
//
//   host/stores/<store>/<entry>.md|.txt   a store (a databank, a memory, summaries); its `ABOUT` file's first line says what it holds
//   host/records/<name>/<entry>.md|.txt   a searcher of `gap_check` under its folder's name (state, story)
//
// Each is searched by words as the chat and the lore are (words.ts), under the host's own limits.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Scope, SearchHit, Searcher, StoresPort } from "../../contract/index";
import { hostLimits } from "./config";
import { codeOf, safeId } from "./disk";
import type { Site } from "./site";
import { match, snippetOf, termsOf } from "./words";

/** A store's file that says what the store holds; not an entry. */
const ABOUT = "ABOUT";

/** An entry of a folder: its file's name without the extension, and its text. */
interface Entry {
  name: string;
  text: string;
}

/** The folders under `dir`, by name; none where it is not there. */
async function folders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
}

/** The entries of one folder, in their names' order. */
async function entriesOf(dir: string): Promise<Entry[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.(md|txt)$/.test(n) && !n.startsWith(`${ABOUT}.`)).sort();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.map(async (n) => ({ name: n.replace(/\.(md|txt)$/, ""), text: await readFile(join(dir, n), "utf8") })));
}

/** The entries of folders that hold the words, best first, each a hit whose ref is `<folder>/<entry>`. */
async function searched(site: Site, base: string, names: readonly string[], words: string, limit: number | undefined): Promise<SearchHit[]> {
  const terms = termsOf(words);
  if (terms.length === 0) return [];
  const limits = await hostLimits(site);
  const found: { hit: SearchHit; score: number }[] = [];
  for (const folder of names) {
    for (const e of await entriesOf(join(base, folder))) {
      const inText = match(e.text, terms);
      const score = terms.filter((t) => e.name.toLowerCase().includes(t) || e.text.toLowerCase().includes(t)).length;
      if (score === 0) continue;
      found.push({ score, hit: { ref: `${folder}/${e.name}`, title: e.name, snippet: inText.score > 0 ? snippetOf(e.text, inText.at, inText.length, limits.snippet) : e.name, how: "words" } });
    }
  }
  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, limit ?? limits.searchHits)
    .map((f) => f.hit);
}

export function folderStores(site: Site): StoresPort {
  const base = join(site.host, "stores");
  return {
    async list(scope: Scope) {
      site.check(scope);
      return Promise.all(
        (await folders(base)).map(async (name) => {
          const about = await readFile(join(base, name, `${ABOUT}.md`), "utf8").catch(() => readFile(join(base, name, `${ABOUT}.txt`), "utf8").catch(() => ""));
          return { name, line: about.split("\n").find((l) => l.trim() !== "")?.trim() ?? name };
        }),
      );
    },

    async search(scope, query) {
      site.check(scope);
      const all = await folders(base);
      return searched(site, base, query.stores === undefined ? all : all.filter((n) => query.stores?.includes(n)), query.text, query.limit);
    },

    async read(scope, ref) {
      site.check(scope);
      const [store, name, ...rest] = ref.split("/");
      if (store === undefined || name === undefined || rest.length > 0) return undefined;
      const found = (await entriesOf(join(base, safeId("store", store)))).find((e) => e.name === name);
      return found === undefined ? undefined : { ref, store, title: found.name, text: found.text };
    },
  };
}

/** A searcher for each folder of `host/records/` (state, story), named by it, as the host is made. */
export async function folderSearchers(site: Site): Promise<Searcher[]> {
  const base = join(site.host, "records");
  return (await folders(base)).map((name) => ({
    name,
    async search(scope, query) {
      site.check(scope);
      return searched(site, base, [name], [query.topic, ...query.terms].join(" "), query.limit);
    },
  }));
}
