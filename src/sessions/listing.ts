// Each chat's index of its sessions (§14 Sessions, "as today", R-38): every session's view as it
// last stood, with the turns off its path, kept through the host's store and brought up to date
// whenever a session's file changes (open, close, reopen, fork, a turn begun or played, a
// compaction). The Sessions page lists a long chat's sessions from it by pages, and no session file
// is read for a listing. An index the store lost is made again from the files, once.
import { createHash } from "node:crypto";
import type { JsonValue, Log, Scope, SessionView, StorePort } from "../contract";
import { isMapping } from "../files/header";

/** One session as the index keeps it: its view, and the turns off its path (an agent's run started in one of them is off the path with it). */
interface Indexed {
  view: SessionView;
  left: string[];
}

type Index = Record<string, Indexed>;

/** The store key of a chat's index of its sessions (the store keeps it by user). */
function indexKey(chat: string): string {
  return `sessions/index/${createHash("sha256").update(chat).digest("hex").slice(0, 32)}`;
}

function indexOf(value: JsonValue | undefined): Index | undefined {
  return isMapping(value) ? (value as unknown as Index) : undefined;
}

export class SessionListing {
  readonly #store: StorePort;
  readonly #log: Log;
  /** The index writes under way, in order: a listing waits for them. */
  #writing: Promise<unknown> = Promise.resolve();

  constructor(store: StorePort, log: Log) {
    this.#store = store;
    this.#log = log;
  }

  /** A session's view as it now stands, kept in its chat's index. */
  keep(scope: Scope, view: SessionView, left: readonly string[]): void {
    const { offPath: _offPath, ...stands } = view;
    this.#writing = this.#writing
      .then(() => this.#store.update({ user: scope.user }, indexKey(scope.chat), (current) => ({ ...(indexOf(current) ?? {}), [scope.session]: { view: stands, left: [...left] } }) as unknown as JsonValue))
      .catch((error: unknown) => this.#log.warn("A chat's index of its sessions could not be brought up to date; the next listing makes it again.", { session: scope.session, error: error instanceof Error ? error.message : String(error) }));
  }

  /** Every session the chat's index holds, each placed (an agent's run whose turn left the path is off it), in the order opened; undefined where there is no index. */
  async all(user: string, chat: string): Promise<SessionView[] | undefined> {
    await this.#writing;
    const index = indexOf(await this.#store.get({ user }, indexKey(chat)));
    if (index === undefined) return undefined;
    const views = Object.values(index).map(({ view }) => {
      const parent = view.parent;
      const from = parent === undefined || "owner" in parent || parent.session === undefined || parent.turn === undefined ? undefined : index[parent.session];
      return from !== undefined && parent !== undefined && "turn" in parent && parent.turn !== undefined && from.left.includes(parent.turn) ? { ...view, offPath: true as const } : view;
    });
    return views.sort((a, b) => a.opened - b.opened || a.id.localeCompare(b.id));
  }

  /** The chat's index made again whole, from views made from its files. */
  async rebuild(user: string, chat: string, made: readonly { view: SessionView; left: string[] }[]): Promise<void> {
    await this.#writing;
    const index: Index = {};
    for (const { view, left } of made) {
      const { offPath: _offPath, ...stands } = view;
      index[view.id] = { view: stands, left };
    }
    await this.#store.set({ user }, indexKey(chat), index as unknown as JsonValue);
  }
}

/** One page of a list in the order given: from after `after` (from the start without it), at most `limit`, and the id the next page starts after when there is more. */
export function pageOf(views: readonly SessionView[], after: string | undefined, limit: number): { sessions: SessionView[]; next?: string } {
  const start = after === undefined ? 0 : views.findIndex((view) => view.id === after) + 1;
  const sessions = views.slice(start, start + limit);
  const last = sessions.at(-1);
  return start + limit < views.length && last !== undefined ? { sessions, next: last.id } : { sessions };
}
