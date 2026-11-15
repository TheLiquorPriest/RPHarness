// Sessions as the host and the pages reach them (Appendix A `SessionsApi`): opened and closed only
// when the host says so (§11: it ties them to its scenes), closing as the work of the turn that did
// it, a branch begun from a turn of another session, a compaction asked for, and each session as it
// stands now. Code never closes a session for its size, and nothing here is a step of a turn.
import type { FilesPort, Scope, SessionsApi, SessionView } from "../contract";
import type { SessionBook, SessionFile } from "./book";
import { compactionAt, pathTurns } from "./carry";
import type { ClosedEntry, SessionEntry } from "./file";

/**
 * A session as it stands at its leaf. A closing is judged by its turn, wherever it sits in the file:
 * one that names no turn (the host's own) holds; one made as the work of a turn holds while that turn
 * is on the path, or, for a turn the file never saw begin, until the host says it left.
 */
function viewOf(file: SessionFile, now: number): SessionView {
  const { log, header, scope } = file;
  const turns = pathTurns(log, log.leaf);
  const onPath = new Set(turns.map((turn) => turn.entry.turn));
  const closing = log.entries.findLast((entry): entry is ClosedEntry => entry.type === "closed" && (entry.turn === undefined || onPath.has(entry.turn) || (log.turn(entry.turn) === undefined && !log.left(entry.turn))));
  return {
    id: scope.session,
    user: scope.user,
    chat: scope.chat,
    state: closing === undefined ? "open" : "closed",
    opened: log.opened?.at ?? header?.at ?? now,
    ...(closing?.turn !== undefined ? { closedBy: closing.turn } : {}),
    ...(header?.from !== undefined ? { from: header.from } : {}),
    turns: turns.length,
    ...(log.asked !== undefined ? { compactAsked: true as const } : {}),
  };
}

/** A listing names no session; places are asked for one only to learn the folder every session's folder is in (§5 `sessions/<session-id>/`). */
const ANY_SESSION = "any";

export interface SessionsDeps {
  files: FilesPort;
  now(): number;
  /** How many of a session's newest turns a summary never stands for, as the user's settings for its chat say. */
  keepTurns(scope: Scope): Promise<number>;
  /** The host closed the session: what the harness keeps of it beside its file is let go. */
  closed(scope: Scope): void;
}

export function sessionsApi(book: SessionBook, d: SessionsDeps): SessionsApi {
  const view = (file: SessionFile): SessionView => viewOf(file, d.now());
  return {
    open: (scope, opening) =>
      book.with(scope, async (file) => {
        // Opened once: the summary it opened with stays the one it carries (§11).
        if (file.log.opened === undefined) file.add({ type: "opened", parent: file.log.leaf, ...(opening?.summary !== undefined && opening.summary !== "" ? { summary: opening.summary } : {}) });
        await file.settled();
        return view(file);
      }),

    close: (scope) =>
      book.with(scope, async (file) => {
        if (view(file).state === "closed") return view(file);
        // The closing hangs at the end of the turn that did it, so it leaves the path with that turn.
        const tip = scope.turn === undefined ? undefined : file.log.tip(scope.turn);
        file.add({ type: "closed", parent: tip ?? file.log.leaf, ...(scope.turn !== undefined ? { turn: scope.turn } : {}) });
        await file.settled();
        d.closed(scope);
        return view(file);
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
          target.copy(entries, { chat: from.chat, session: from.session, turn: from.turn });
          await target.settled();
          return view(target);
        });
      }),

    compact: (scope) =>
      book.with(scope, async (file) => {
        // Marked when there is something to summarize: the session's next turn compacts at its start, where the lead can save what matters first.
        if (file.log.asked === undefined && compactionAt(file.log, file.log.leaf, undefined, await d.keepTurns(scope)) !== undefined) file.add({ type: "compact", parent: file.log.leaf });
        await file.settled();
        return view(file);
      }),

    get: (scope) => book.with(scope, (file) => (file.header === undefined && file.log.entries.length === 0 ? undefined : view(file))),

    async list(user, chat) {
      const scope: Scope = { user, chat, session: ANY_SESSION };
      const { files } = d;
      const folder = (await files.places(scope)).session.replace(/[^/]+\/$/, "");
      // Every session the chat has: a host's own cap on one find would cut the list short with no sign of it.
      const found = await files.find(scope, { by: "glob", pattern: "*/*.jsonl", limit: Number.MAX_SAFE_INTEGER, ...(folder !== "" ? { path: folder } : {}) });
      if (found.status === "refused") return [];
      const ids = found.hits.flatMap((hit) => {
        const [session, name] = hit.path.slice(folder.length).split("/");
        return hit.type === "file" && session !== undefined && name === `${session}.jsonl` ? [session] : [];
      });
      // One file at a time, each let go once its view is made: a chat's sessions are never in memory all at once.
      const views: SessionView[] = [];
      for (const session of ids) views.push(await book.with({ user, chat, session }, view));
      return views.sort((a, b) => a.opened - b.opened);
    },
  };
}
