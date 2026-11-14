// The host's other stores (§6.8 `archive_search`: databanks, the chat application's memory,
// summaries), the searchers `gap_check` runs besides chat and lore (§10.5: state and the story
// record, for RPE), and the web searcher (§6.8 `web_search`).

import type { AgentRef, Scope, SearchHit } from "./common";

/** One of the host's other stores, as `archive_search` lists it. */
export interface StoreInfo {
  /** Its name, by which a search asks for it (`databank`, `memory`, `summaries`). */
  name: string;
  /** One line on what it holds, from the host's own text. */
  line: string;
}

/** What to look for in the host's other stores. */
export interface StoresQuery {
  /** The names and words to look for. */
  text: string;
  /** Only these stores, by name; every store when absent. */
  stores?: string[];
  /** At most this many hits; the host's own cap when absent. */
  limit?: number;
}

/** A thing read in full from one of the host's other stores. */
export interface StoreItem {
  ref: string;
  /** The store it is in. */
  store: string;
  title: string;
  text: string;
}

/** The host's other stores. A host without any leaves `Environment.stores` out, and `archive_search` reaches only RPH's own earlier sessions. */
export interface StoresPort {
  /** The stores this chat has. */
  list(scope: Scope): Promise<StoreInfo[]>;
  /** Searches them. Each hit's `ref` reads it in full. */
  search(scope: Scope, query: StoresQuery): Promise<SearchHit[]>;
  /** One thing in full, by a hit's `ref`; undefined when it is no longer there. */
  read(scope: Scope, ref: string): Promise<StoreItem | undefined>;
}

/**
 * What `gap_check` looks for (§10.5): the topic, and the names, other names and words around it it
 * was given.
 */
export interface GapQuery {
  topic: string;
  terms: string[];
  /** At most this many hits from this searcher. */
  limit: number;
  /**
   * The agent the check is for. A searcher gives what that agent may know, as the lore does (§9.4):
   * an agent that plays a character (`plays`) is given only what its character may know.
   */
  reader: AgentRef;
}

/** One more place `gap_check` searches, as the host has it (for RPE: the state, the story record). */
export interface Searcher {
  /** Its name in the saved evidence (`state`, `story`); unique among the host's searchers. */
  name: string;
  /** Searches by the names and words given, and by meaning where the host has that set up. */
  search(scope: Scope, query: GapQuery): Promise<SearchHit[]>;
}

/** What to look for on the web. */
export interface WebQuery {
  /** The words to look for. */
  text: string;
  /** At most this many hits; the searcher's own cap when absent. */
  limit?: number;
}

/** A web searcher, as a host offers one (§6.8 `web_search`: off until the user sets a provider). */
export interface WebSearchPort {
  /** Searches the web by the words given. Each hit's `ref` is the page's address. */
  search(scope: Scope, query: WebQuery): Promise<SearchHit[]>;
}
