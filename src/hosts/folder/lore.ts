// The folder host's lore (§9.4) over a folder of entries: `host/lore/*.json`, one entry per file,
// every entry part of every chat's lore. What activated for a turn is what the prompt given for it
// says (`prompt.json`'s `activated`).
//
// Who may read an entry is what its `knowing` says (§9.4). In the folder host a character's id is
// its name, so a reader that plays a character reads an entry known by named characters when its
// name is among them. The folder host keeps no secret parts inside an entry's text (§9.6), so
// it has none to leave out.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRef, LoreEntry, LoreHit, LorePort } from "../../contract/index";
import { codeOf, readJson } from "./disk";
import { readGiven } from "./prompt";
import { loreEntry } from "./shape";
import type { Site } from "./site";
import { match, SEARCH_LIMIT, snippetOf, termsOf } from "./words";

/** Whether `reader` may read `entry`: every entry for a reader that plays no character; else what anyone may know, what its character is named for, and what is behind a gate that holds. */
function mayRead(entry: LoreEntry, reader: AgentRef): boolean {
  if (reader.plays === undefined || entry.knowing === undefined) return true;
  switch (entry.knowing.by) {
    case "anyone":
      return true;
    case "characters":
      return entry.knowing.names.includes(reader.plays);
    case "gate":
      return entry.knowing.open;
  }
}

export function folderLore(site: Site): LorePort {
  const folder = join(site.host, "lore");

  /** Every entry, in the order of their files' names. Two files with one id is an error that names both. */
  async function entries(): Promise<LoreEntry[]> {
    let names: string[];
    try {
      names = (await readdir(folder)).filter((n) => n.endsWith(".json")).sort();
    } catch (error) {
      if (codeOf(error) === "ENOENT") return [];
      throw error;
    }
    const seen = new Map<string, string>();
    const out: LoreEntry[] = [];
    for (const name of names) {
      const path = join(folder, name);
      const entry = loreEntry(path, await readJson(path));
      const other = seen.get(entry.id);
      if (other !== undefined) throw new Error(`Two lore entries have the id ${JSON.stringify(entry.id)}: ${other} and ${path}.`);
      seen.set(entry.id, path);
      out.push(entry);
    }
    return out;
  }

  return {
    async read(scope, ids, reader) {
      site.check(scope);
      const byId = new Map((await entries()).filter((e) => mayRead(e, reader)).map((e) => [e.id, e]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    },

    async search(scope, query, reader) {
      site.check(scope);
      const terms = termsOf(query.text);
      if (terms.length === 0) return [];
      const found: { hit: LoreHit; score: number; order: number }[] = [];
      for (const [order, e] of (await entries()).entries()) {
        if (!mayRead(e, reader) || (query.sources !== undefined && !query.sources.includes(e.source))) continue;
        // Title and keys count as much as the text: a word found in any of them counts once.
        const inText = match(e.text, terms);
        const score = terms.filter((t) => e.title.toLowerCase().includes(t) || e.keys.some((k) => k.toLowerCase().includes(t)) || e.text.toLowerCase().includes(t)).length;
        if (score === 0) continue;
        const snippet = inText.score > 0 ? snippetOf(e.text, inText.at, inText.length) : e.title;
        found.push({ score, order, hit: { id: e.id, source: e.source, title: e.title, snippet, how: "words" } });
      }
      return found
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, query.limit ?? SEARCH_LIMIT)
        .map((f) => f.hit);
    },

    async activated(scope) {
      site.check(scope);
      if (scope.turn === undefined) return [];
      return (await readGiven(site, scope.chat, scope.turn))?.activated ?? [];
    },
  };
}
