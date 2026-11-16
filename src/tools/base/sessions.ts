// The chat's earlier sessions as one of `archive_search`'s stores (§6.8 L742, §11): RPH keeps them
// for every host, so the Author can go back to an earlier scene's rulings whatever stores the host
// has. A search goes through the host's own file search over the chat's session files, the open
// session's left out, and gives each entry that holds the words (what the lead wrote, its intent,
// what a tool told it, a summary) with its session and the words around the match; its ref reads
// that entry's text in full. The store's name and its line are `base-tools.md`'s.

import type { FilesPort, Scope, SearchHit, StoreInfo, StoreItem } from "../../contract";
import { isMapping } from "../../files/header";
import type { Words } from "../kit";

/** The name an agent asks for the sessions store by, where `base-tools.md` gives none: an id, never shown as words of their own. */
const SESSIONS = "sessions";

/** How much of an entry a hit shows on each side of the first word it matched, in UTF-16 code units: as the folder host's snippets. */
const RADIUS = 80;

/** An entry of a session file that holds words: its id, its kind, its turn and its text. */
interface Said {
  id: string;
  type: string;
  turn?: string;
  text: string;
  at: number;
}

/** A session file's line as an entry that holds words; anything else is none. */
function saidOf(line: string): Said | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isMapping(value) || typeof value.id !== "string" || typeof value.type !== "string") return undefined;
  const text = typeof value.text === "string" ? value.text : typeof value.summary === "string" ? value.summary : undefined;
  if (text === undefined || text.trim() === "") return undefined;
  return { id: value.id, type: value.type, ...(typeof value.turn === "string" ? { turn: value.turn } : {}), text, at: typeof value.at === "number" ? value.at : 0 };
}

/** The words of a query: runs of letters and digits, in lower case, each once. */
function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== ""))];
}

/** The chat's earlier sessions, over the host's files. */
export class SessionsStore {
  constructor(
    private readonly files: Pick<FilesPort, "places" | "find" | "read">,
    private readonly words: Words,
  ) {}

  /** Its name and line, as `base-tools.md` gives them. */
  info(): StoreInfo {
    return { name: this.words("sessions_store") ?? SESSIONS, line: this.words("sessions_line") ?? "" };
  }

  /** The folder every session's folder is in, and the open session's file. */
  async #where(scope: Scope): Promise<{ folder: string; open: string }> {
    const { session } = await this.files.places(scope);
    const folder = session.replace(/[^/]+\/$/, "");
    return { folder, open: `${session}${scope.session}.jsonl` };
  }

  /** A session's file by its folder's name: `<session>/<session>.jsonl` (§11). */
  #isSessionFile(folder: string, path: string): string | undefined {
    const below = path.startsWith(folder) ? path.slice(folder.length) : undefined;
    const parts = below?.split("/");
    return parts?.length === 2 && parts[1] === `${parts[0]}.jsonl` ? parts[0] : undefined;
  }

  /** Entries of the earlier sessions that hold the words, those holding the most first, then the newest; at most `limit`. */
  async search(scope: Scope, query: string, limit: number): Promise<SearchHit[]> {
    const terms = termsOf(query);
    if (terms.length === 0) return [];
    const { folder, open } = await this.#where(scope);
    const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const found = await this.files.find(scope, { by: "grep", pattern, ignoreCase: true, glob: "*/*.jsonl", path: folder });
    if (found.status !== "found") return [];
    // The lines each earlier session's file holds the words at: read whole, so an entry's text is never one the grep cut.
    const lines = new Map<string, Set<number>>();
    for (const hit of found.hits) {
      if (hit.path === open || hit.line === undefined || this.#isSessionFile(folder, hit.path) === undefined) continue;
      lines.set(hit.path, (lines.get(hit.path) ?? new Set()).add(hit.line));
    }
    const ranked: { hit: SearchHit; score: number; at: number }[] = [];
    for (const [path, at] of lines) {
      const read = await this.files.read(scope, path);
      if (read.status !== "read") continue;
      const session = this.#isSessionFile(folder, path) ?? "";
      read.text.split("\n").forEach((line, i) => {
        if (!at.has(i + 1)) return;
        const said = saidOf(line);
        if (said === undefined) return;
        const lower = said.text.toLowerCase();
        const places = terms.map((t) => [lower.indexOf(t), t.length] as const).filter(([p]) => p !== -1);
        if (places.length === 0) return;
        const [first, length] = places.reduce((a, b) => (b[0] < a[0] ? b : a));
        const title = this.words("session_hit", { session, entry: said.type, ...(said.turn !== undefined ? { turn: said.turn } : {}) }) ?? session;
        ranked.push({ score: places.length, at: said.at, hit: { ref: `${path}#${said.id}`, title, snippet: said.text.slice(Math.max(0, first - RADIUS), first + length + RADIUS), how: "words" } });
      });
    }
    return ranked
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, limit)
      .map((r) => r.hit);
  }

  /** An entry in full by a hit's ref (`<session file>#<entry>`); undefined when the ref names none of the chat's sessions' entries. */
  async read(scope: Scope, ref: string): Promise<StoreItem | undefined> {
    const mark = ref.lastIndexOf("#");
    if (mark === -1) return undefined;
    const path = ref.slice(0, mark);
    const id = ref.slice(mark + 1);
    const { folder } = await this.#where(scope);
    const session = this.#isSessionFile(folder, path);
    if (session === undefined) return undefined;
    const read = await this.files.read(scope, path);
    if (read.status !== "read") return undefined;
    for (const line of read.text.split("\n")) {
      const said = saidOf(line);
      if (said?.id !== id) continue;
      const title = this.words("session_hit", { session, entry: said.type, ...(said.turn !== undefined ? { turn: said.turn } : {}) }) ?? session;
      return { ref, store: this.info().name, title, text: said.text };
    }
    return undefined;
  }
}
