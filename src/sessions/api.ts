// Sessions as the host and the pages reach them (Appendix A `SessionsApi`): opened and closed only
// when the host says so (§11: it ties them to its scenes), closing as the work of the turn that did
// it, or as the owner's own close and its undo; a branch begun from a turn of another session, a
// compaction asked for, and each session as it stands now. Every change is told as it happens, to
// the host's trace and the chat's live view (§13.1: RPH reports everything it does). Code never
// closes a session for its size, and nothing here is a step of a turn.
import type { CompactionView, FilesPort, Log, Scope, SessionsApi, SessionView, TraceEvent } from "../contract";
import type { TemplatePart } from "../files/api";
import type { SessionBook, SessionFile } from "./book";
import { copyCache } from "./cache";
import { carriedFields, compactionAt, pathTurns, summaryStands } from "./carry";
import type { ClosedEntry, CompactedEntry, SessionEntry, SessionLog } from "./file";
import { pageOf, type SessionListing } from "./listing";

/** A change of a session, as its trace record tells it. */
export type SessionChange = Omit<Extract<TraceEvent, { kind: "session" }>, "kind">;

/**
 * The closings that stand at the leaf, in the order of the file. A closing is judged by its turn,
 * wherever it sits in the file: one that names no turn (the host's own) holds; one made as the work
 * of a turn, or the owner's hung after one, holds while that turn is on the path, or, for a turn the
 * file never saw begin, until the host says it left; and none that the owner took back holds.
 */
function standing(log: SessionLog, onPath: ReadonlySet<string>): ClosedEntry[] {
  return log.entries.filter((entry): entry is ClosedEntry => entry.type === "closed" && log.reopened(entry.id) === undefined && (entry.turn === undefined || onPath.has(entry.turn) || (log.turn(entry.turn) === undefined && !log.left(entry.turn))));
}

/** The newest closing that stands at the session's leaf: none while it is open. */
export function closingOf(file: SessionFile): ClosedEntry | undefined {
  return standing(file.log, new Set(pathTurns(file.log, file.log.leaf).map((turn) => turn.entry.turn))).at(-1);
}

/** A session of a chat (`scope`) as it stands at its leaf: the newest closing that stands says who closed it. */
export function viewOf(file: SessionFile, scope: Scope, now: number): SessionView {
  const { log, header } = file;
  const turns = pathTurns(log, log.leaf);
  const closing = standing(log, new Set(turns.map((turn) => turn.entry.turn))).at(-1);
  return {
    id: scope.session,
    user: scope.user,
    chat: scope.chat,
    kind: header?.kind ?? "scene",
    ...(header?.parent !== undefined ? { parent: header.parent } : {}),
    ...(header?.agent !== undefined ? { agent: header.agent } : {}),
    state: closing === undefined ? "open" : "closed",
    opened: log.opened?.at ?? header?.at ?? now,
    ...(closing?.turn !== undefined ? { closedBy: closing.turn } : {}),
    ...(closing?.by !== undefined ? { by: closing.by } : {}),
    ...(header?.from !== undefined ? { from: header.from } : {}),
    turns: turns.length,
    ...(log.asked !== undefined ? { compactAsked: true as const } : {}),
  };
}

/** A listing names no session; places are asked for one only to learn the folder every session's folder is in (§5 `sessions/<session-id>/`). */
const ANY_SESSION = "any";

export interface SessionsDeps {
  files: FilesPort;
  log: Log;
  now(): number;
  /** How many of a session's newest turns a summary never stands for, as the user's settings for its chat say. */
  keepTurns(scope: Scope): Promise<number>;
  /** How many sessions a page of the list holds when it asks for no number (`sessions.page`), as the user's settings say. */
  pageSize(scope: Scope): Promise<number>;
  /** The carried part (§10.2 block 3's layout), as the files for the session's chat stand. */
  carriedPart(scope: Scope): Promise<TemplatePart | undefined>;
  /** Each chat's index of its sessions, which a listing reads. */
  listing: SessionListing;
  /** The session closed: what the harness and the model layer keep of it beside its file is let go. */
  closed(scope: Scope): void;
  /** A change of the session, told to the host's trace and the chat's live view as a record of the host's word (S-1). */
  told(scope: Scope, change: SessionChange): void;
}

/** A compaction as the Sessions page shows it, from its entry. */
function compactionOf(log: SessionLog, onPath: ReadonlySet<string>, entry: CompactedEntry): CompactionView {
  const undone = log.undone(entry.id) !== undefined;
  return {
    id: entry.id,
    turn: entry.turn,
    summary: entry.summary,
    at: entry.at,
    of: entry.of ?? "turns",
    turns: [...(entry.turns ?? [])],
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.before !== undefined ? { before: entry.before } : {}),
    ...(entry.after !== undefined ? { after: entry.after } : {}),
    stands: onPath.has(entry.id) && summaryStands(log, entry),
    ...(undone ? { undone: true as const } : {}),
  };
}

function compactionsOf(log: SessionLog): CompactionView[] {
  const onPath = new Set(log.path(log.leaf).map((entry) => entry.id));
  return log.entries.flatMap((entry) => (entry.type === "compacted" ? [compactionOf(log, onPath, entry)] : []));
}

export function sessionsApi(book: SessionBook, d: SessionsDeps): SessionsApi {
  const view = (file: SessionFile, scope: Scope): SessionView => viewOf(file, scope, d.now());
  const turnOf = (scope: Scope): { turn?: string } => (scope.turn !== undefined ? { turn: scope.turn } : {});
  // An agent's run is off the path with the turn it was played in (a swipe, a delete), as that turn's session says; its file is kept.
  const placed = async (seen: SessionView): Promise<SessionView> => {
    const parent = seen.parent;
    if (parent === undefined || "owner" in parent || parent.session === undefined || parent.turn === undefined) return seen;
    const turn = parent.turn;
    const left = await book.with({ user: seen.user, chat: seen.chat, session: parent.session }, (file) => file.log.left(turn));
    return left ? { ...seen, offPath: true } : seen;
  };
  return {
    open: (scope, opening) =>
      book.with(scope, async (file) => {
        // Opened once: the summary it opened with stays the one it carries (§11), until the host says another (`opensWith`).
        if (file.log.opened !== undefined) return view(file, scope);
        file.add({ type: "opened", parent: file.log.leaf, ...(opening?.summary !== undefined && opening.summary !== "" ? { summary: opening.summary } : {}) });
        await file.settled();
        d.told(scope, { session: scope.session, change: "opened", ...turnOf(scope) });
        return view(file, scope);
      }),

    opensWith: (scope, summary) =>
      book.with(scope, async (file) => {
        // The host's newest word stands; the summary the session already opens with writes nothing.
        const now = file.log.opensWith?.summary ?? file.log.opened?.summary ?? "";
        if (summary !== now) file.add({ type: "opensWith", parent: file.log.leaf, summary });
        await file.settled();
        return view(file, scope);
      }),

    close: (scope, how) =>
      book.with(scope, async (file) => {
        if (view(file, scope).state === "closed") return view(file, scope);
        // The closing hangs at the end of the turn that did it, or for the owner's, the chat's newest
        // turn, so it leaves the path with that turn.
        const tip = scope.turn === undefined ? undefined : file.log.tip(scope.turn);
        const by = how?.by === "user" ? { by: "user" as const } : {};
        file.add({ type: "closed", parent: tip ?? file.log.leaf, ...turnOf(scope), ...by });
        await file.settled();
        d.closed(scope);
        d.told(scope, { session: scope.session, change: "closed", ...turnOf(scope), ...by });
        return view(file, scope);
      }),

    reopen: (scope) =>
      book.with(scope, async (file) => {
        // His undo takes back his own closings that stand; a turn's stands until its turn leaves the path.
        const his = standing(file.log, new Set(pathTurns(file.log, file.log.leaf).map((turn) => turn.entry.turn))).filter((closing) => closing.by === "user");
        if (his.length === 0) return view(file, scope);
        for (const closing of his) file.add({ type: "reopened", parent: closing.id, closing: closing.id });
        await file.settled();
        if (closingOf(file) === undefined) d.told(scope, { session: scope.session, change: "reopened", by: "user" });
        return view(file, scope);
      }),

    fork: (from, to) =>
      book.with(from, (source) => {
        const tip = source.log.tip(from.turn);
        if (tip === undefined) throw new Error(`The session ${from.session} has no turn ${from.turn} to branch from.`);
        return book.with(to, async (target) => {
          if (target.header !== undefined || target.log.entries.length > 0) throw new Error(`The session ${to.session} has begun already; a branch begins a session of its own.`);
          // The path to that turn as it stands (an attempt shown again in place of another followed by what followed that one), each entry after the one before it there, and each turn marked with where it was played.
          const path = source.log.path(tip);
          const entries = path.map((entry): SessionEntry => {
            const played = entry.type === "turn" && entry.played === undefined ? { ...entry, played: { chat: from.chat, session: from.session } } : entry;
            const parent = source.log.parentOf(entry);
            return parent === entry.parent ? played : { ...played, parent };
          });
          // Then the host's word that put each turn before it off the path, before every summary written after it in the source file and after every one written before it: a summary stands in the branch as it stands there.
          for (const entry of path) {
            if (entry.type !== "turn" || entry.turn === from.turn) continue;
            const mark = source.log.leftBy(entry.turn);
            const last = path.findLast((step) => step.type !== "opened" && step.turn === entry.turn);
            if (mark === undefined || last === undefined) continue;
            const before = entries.findIndex((step) => step.type === "compacted" && source.log.place(step.id) > source.log.place(mark.id));
            entries.splice(before < 0 ? entries.length : before, 0, { ...mark, parent: last.id });
          }
          // And each lead's newest opening block, so the branch goes on with the front its session had (§10.2).
          for (const opening of source.log.openings()) entries.push({ ...opening, parent: tip });
          // And the owner's undo of each of his closings on the path, so a session he opened again is open in the branch.
          for (const entry of path) {
            const undo = entry.type === "closed" ? source.log.reopened(entry.id) : undefined;
            if (undo !== undefined) entries.push(undo);
          }
          // And the host's newest word on what the session opens with, so the branch opens with it too.
          const opens = source.log.opensWith;
          if (opens !== undefined) entries.push({ ...opens, parent: tip });
          target.copy(entries, { chat: from.chat, session: from.session, turn: from.turn });
          await target.settled();
          // And the session's cache folder, the host's files with RPH's: the branch's turns find it as it stood.
          const fromScope: Scope = { user: from.user, chat: from.chat, session: from.session };
          const toScope: Scope = { user: to.user, chat: to.chat, session: to.session };
          await copyCache(d.files, { scope: fromScope, places: await d.files.places(fromScope) }, { scope: toScope, places: await d.files.places(toScope) }, d.log);
          d.told(to, { session: to.session, change: "forked", from: from.session, turn: from.turn });
          return view(target, to);
        });
      }),

    compact: (scope) =>
      book.with(scope, async (file) => {
        // Marked when there is something to summarize: the session's next turn compacts at its start, where the lead can save what matters first.
        if (file.log.asked === undefined && compactionAt(file.log, file.log.leaf, undefined, await d.keepTurns(scope)) !== undefined) file.add({ type: "compact", parent: file.log.leaf });
        await file.settled();
        return view(file, scope);
      }),

    get: async (scope) => {
      const seen = await book.with(scope, (file) => (file.header === undefined && file.log.entries.length === 0 ? undefined : view(file, scope)));
      return seen === undefined ? undefined : placed(seen);
    },

    async list(user, chat, page) {
      const scope: Scope = { user, chat, session: ANY_SESSION };
      const limit = page?.limit ?? (await d.pageSize(scope));
      const indexed = await d.listing.all(user, chat);
      if (indexed !== undefined) return pageOf(indexed, page?.after, limit);
      // No index yet (or the store lost it): made again from the files, once, and listed from it.
      const { files } = d;
      const folder = (await files.places(scope)).session.replace(/[^/]+\/$/, "");
      // Every session the chat has: a host's own cap on one find would cut the list short with no sign of it.
      const found = await files.find(scope, { by: "glob", pattern: "*/*.jsonl", limit: Number.MAX_SAFE_INTEGER, ...(folder !== "" ? { path: folder } : {}) });
      if (found.status === "refused") return { sessions: [] };
      const ids = found.hits.flatMap((hit) => {
        const [session, name] = hit.path.slice(folder.length).split("/");
        return hit.type === "file" && session !== undefined && name === `${session}.jsonl` ? [session] : [];
      });
      // One file at a time, each let go once its view is made: a chat's sessions are never in memory all at once.
      const made: { view: SessionView; left: string[] }[] = [];
      for (const session of ids) made.push(await book.with({ user, chat, session }, (file) => ({ view: view(file, { user, chat, session }), left: file.log.leftTurns() })));
      await d.listing.rebuild(user, chat, made);
      return pageOf((await d.listing.all(user, chat)) ?? [], page?.after, limit);
    },

    carried: (scope, carry) =>
      book.with(scope, async (file) => {
        // Block 3 as the session's next turn would have it, after its newest turn on the path.
        const layout = await d.carriedPart(scope);
        if (layout === undefined) return "";
        const record = layout.header["record"];
        const fields = await carriedFields({ carry, tree: file.log, from: file.log.leaf, scope, files: d.files, log: d.log, ...(typeof record === "string" ? { record } : {}) });
        return fields === undefined ? "" : layout.render(fields).text.trimEnd();
      }),

    compactions: (scope) => book.with(scope, (file) => compactionsOf(file.log)),

    uncompact: (scope, id) =>
      book.with(scope, async (file) => {
        // His undo: the summary no longer stands; the file keeps both.
        const entry = file.log.get(id);
        if (entry?.type === "compacted" && file.log.undone(id) === undefined) {
          file.add({ type: "uncompacted", parent: file.log.leaf, compacted: id });
          await file.settled();
        }
        return compactionsOf(file.log);
      }),
  };
}
