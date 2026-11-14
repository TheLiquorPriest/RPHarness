// Lore from every source the host has (for RPE: the user's books and the world's own lore, §9.1):
// read in full, searched, and what activated for this turn's prompt (§9.2). RPH's `lore_read` and
// `lore_search` work over it; who may know an entry travels with it as data (§9.4).

import type { Scope } from "./common";

/**
 * Who may know an entry, as its source keeps it (§9.4): anyone; the named characters; or whoever
 * passes its gate, with whether the gate holds now. Shown to agents as a mark (§9.4: "marked with
 * who knows it").
 */
export type LoreKnowing =
  | { by: "anyone" }
  | { by: "characters"; names: string[] }
  | { by: "gate"; gate: string; open: boolean };

/** A secret inside an entry's text (§9.6), by its id, with the characters who hold it. */
export interface LoreSecret {
  id: string;
  heldBy: string[];
}

/** A lore entry, in full. */
export interface LoreEntry {
  /** Its id, which also says its source's kind (§9.1: `e-112` a book entry, `w-31` a world entry). */
  id: string;
  /** Where it is kept: the book's name, or the world's. */
  source: string;
  title: string;
  /** The words that activate it. */
  keys: string[];
  /**
   * Its text as agents read it. Secrets are rendered by the host as secrets with their id and who
   * holds them, never as the raw marks (§9.6).
   */
  text: string;
  /** Its revision, which changes whenever its text or keys change. */
  revision?: string;
  /** Who may know it, where its source says (§9.4). Absent: anyone. */
  knowing?: LoreKnowing;
  /** The secrets in its text (§9.6). */
  secrets?: LoreSecret[];
}

/** An entry that activated for this turn's prompt (§4.2), and how. */
export interface ActivatedLore {
  id: string;
  source: string;
  title: string;
  /** How it activated, as the chat application said: always on, by a key, by meaning, or still in force from an earlier turn. Absent where the host was not told. */
  how?: "constant" | "keyword" | "vector" | "sticky";
}

/** What to look for in the lore. */
export interface LoreQuery {
  /** The names and words to look for. */
  text: string;
  /** Only these sources; every source when absent. */
  sources?: string[];
  /** At most this many hits; the host's own cap when absent. */
  limit?: number;
}

/** An entry a lore search found. */
export interface LoreHit {
  id: string;
  source: string;
  title: string;
  /** The words around the match. */
  snippet: string;
  /** How it matched: by the words given, or by meaning where the host has that set up (§9.4). */
  how: "words" | "meaning";
}

export interface LorePort {
  /** The entries asked for, in full and in the order asked. An id the host does not know is left out. */
  read(scope: Scope, ids: string[]): Promise<LoreEntry[]>;
  /** Searches every source attached to the chat (§9.4). */
  search(scope: Scope, query: LoreQuery): Promise<LoreHit[]>;
  /** The entries that activated for the prompt of `scope.turn` (§4.2); none when the scope names no turn. */
  activated(scope: Scope): Promise<ActivatedLore[]>;
}
