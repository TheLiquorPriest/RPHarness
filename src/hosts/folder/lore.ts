// The folder host's lore (§9.4) over a folder of entries: `host/lore/*.json`, one entry per file,
// every entry part of every chat's lore. What activated for a turn is what the prompt given for it
// says (`prompt.json`'s `activated`).
//
// Who may read an entry is what its `knowing` says (§9.4). In the folder host a character's id is
// its name, so a reader that plays a character reads an entry known by named characters when its
// name is among them. The folder host keeps no secret parts inside an entry's text (§9.6), so
// it has none to leave out.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRef, LoreEntry, LoreHit, LorePort, Scope } from "../../contract/index";
import { hostLimits } from "./config";
import { codeOf, readJson, writeWhole } from "./disk";
import { readGiven } from "./prompt";
import { loreEntry } from "./shape";
import type { Site } from "./site";
import { match, snippetOf, termsOf } from "./words";

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

  /** Every entry the chat is bound to (its `chat.json`'s `lore`, every source where it names none), in the order of their files' names. Two files with one id is an error that names both. */
  async function entries(scope: Scope): Promise<LoreEntry[]> {
    const bound = (await site.chat(scope)).lore;
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
      if (bound === undefined || bound.includes(entry.source)) out.push(entry);
    }
    await keepIndex(scope, out);
    return out;
  }

  /**
   * The chat's readable view of the lore it is bound to (§9.1), `LORE-INDEX.md` in its folder: each
   * entry's id, title, source and keys, the index lines the folder host has. Written only when what
   * it says changed; generated, never an agent's to edit.
   */
  async function keepIndex(scope: Scope, all: readonly LoreEntry[]): Promise<void> {
    const lines = ["# Lore index", "", ...all.map((e) => `- ${e.id}: ${e.title} (${e.source})${e.keys.length > 0 ? ` keys: ${e.keys.join(", ")}` : ""}`), ""].join("\n");
    const path = join(await site.chatFolder(scope), "LORE-INDEX.md");
    const now = await readFile(path, "utf8").catch(() => undefined);
    if (now !== lines) await writeWhole(path, lines);
  }

  return {
    async read(scope, ids, reader) {
      const byId = new Map((await entries(scope)).filter((e) => mayRead(e, reader)).map((e) => [e.id, e]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    },

    async search(scope, query, reader) {
      site.check(scope);
      const limits = await hostLimits(site);
      const terms = termsOf(query.text);
      if (terms.length === 0) return [];
      const found: { hit: LoreHit; score: number; order: number }[] = [];
      for (const [order, e] of (await entries(scope)).entries()) {
        if (!mayRead(e, reader) || (query.sources !== undefined && !query.sources.includes(e.source))) continue;
        // Title and keys count as much as the text: a word found in any of them counts once.
        const inText = match(e.text, terms);
        const score = terms.filter((t) => e.title.toLowerCase().includes(t) || e.keys.some((k) => k.toLowerCase().includes(t)) || e.text.toLowerCase().includes(t)).length;
        if (score === 0) continue;
        const snippet = inText.score > 0 ? snippetOf(e.text, inText.at, inText.length, limits.snippet) : e.title;
        found.push({ score, order, hit: { id: e.id, source: e.source, title: e.title, snippet, how: "words" } });
      }
      return found
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, query.limit ?? limits.searchHits)
        .map((f) => f.hit);
    },

    async activated(scope) {
      site.check(scope);
      if (scope.turn === undefined) return [];
      return (await readGiven(site, scope.chat, scope.turn))?.activated ?? [];
    },
  };
}
