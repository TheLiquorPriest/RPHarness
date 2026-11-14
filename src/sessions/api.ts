// Sessions as the host and the pages reach them (Appendix A `SessionsApi`): opened and closed only
// when the host says so (§11: it ties them to its scenes), closing as the work of the turn that did
// it, a branch begun from a turn of another session, and each session as it stands now. Code never
// closes a session for its size, and nothing here is a step of a turn.
import type { FilesPort, Scope, SessionsApi, SessionView } from "../contract";
import type { SessionBook, SessionFile } from "./book";
import { pathTurns } from "./carry";
import type { ClosedEntry } from "./file";

/** A session as it stands at its leaf: closed while a closing on its path belongs to no turn, or to a turn still on the path. */
function viewOf(file: SessionFile, now: number): SessionView {
  const { log, header, scope } = file;
  const closing = log.path(log.leaf).findLast((entry): entry is ClosedEntry => entry.type === "closed" && (entry.turn === undefined || !log.left(entry.turn)));
  return {
    id: scope.session,
    user: scope.user,
    chat: scope.chat,
    state: closing === undefined ? "open" : "closed",
    opened: log.opened?.at ?? header?.at ?? now,
    ...(closing?.turn !== undefined ? { closedBy: closing.turn } : {}),
    ...(header?.from !== undefined ? { from: header.from } : {}),
    turns: pathTurns(log, log.leaf).length,
  };
}

/** A listing names no session; places are asked for one only to learn the folder every session's folder is in (§5 `sessions/<session-id>/`). */
const ANY_SESSION = "any";

export function sessionsApi(book: SessionBook, d: { files: FilesPort; now(): number }): SessionsApi {
  const view = (file: SessionFile): SessionView => viewOf(file, d.now());
  return {
    async open(scope, opening) {
      const file = await book.of(scope);
      // Opened once: the summary it opened with stays the one it carries (§11).
      if (file.log.opened === undefined) file.add({ type: "opened", parent: file.log.leaf, ...(opening?.summary !== undefined && opening.summary !== "" ? { summary: opening.summary } : {}) });
      await file.settled();
      return view(file);
    },

    async close(scope) {
      const file = await book.of(scope);
      if (view(file).state === "closed") return view(file);
      // The closing hangs at the end of the turn that did it, so it leaves the path with that turn.
      const tip = scope.turn === undefined ? undefined : file.log.tip(scope.turn);
      file.add({ type: "closed", parent: tip ?? file.log.leaf, ...(scope.turn !== undefined ? { turn: scope.turn } : {}) });
      await file.settled();
      return view(file);
    },

    async fork(from, to) {
      const source = await book.of(from);
      const tip = source.log.tip(from.turn);
      if (tip === undefined) throw new Error(`The session ${from.session} has no turn ${from.turn} to branch from.`);
      const target = await book.of(to);
      if (target.header !== undefined || target.log.entries.length > 0) throw new Error(`The session ${to.session} has begun already; a branch begins a session of its own.`);
      // The path to that turn, each turn marked with where it was played; then, again, the marks of the turns before it that are off the path.
      const path = source.log.path(tip);
      target.copy(
        path.map((entry) => (entry.type === "turn" && entry.played === undefined ? { ...entry, played: { chat: from.chat, session: from.session } } : entry)),
        { chat: from.chat, session: from.session, turn: from.turn },
      );
      for (const entry of path) {
        if (entry.type !== "turn" || entry.turn === from.turn || !source.log.left(entry.turn)) continue;
        const last = path.findLast((step) => step.type !== "opened" && step.turn === entry.turn);
        if (last !== undefined) target.add({ type: "left", parent: last.id, turn: entry.turn });
      }
      await target.settled();
      return view(target);
    },

    async get(scope) {
      const file = await book.of(scope);
      return file.header === undefined && file.log.entries.length === 0 ? undefined : view(file);
    },

    async list(user, chat) {
      const scope: Scope = { user, chat, session: ANY_SESSION };
      const { files } = d;
      const folder = (await files.places(scope)).session.replace(/[^/]+\/$/, "");
      const hits = await files.find(scope, { by: "glob", pattern: "*/*.jsonl", ...(folder !== "" ? { path: folder } : {}) });
      if (!Array.isArray(hits)) return [];
      const ids = hits.flatMap((hit) => {
        const [session, name] = hit.path.slice(folder.length).split("/");
        return hit.type === "file" && session !== undefined && name === `${session}.jsonl` ? [session] : [];
      });
      const views = await Promise.all(ids.map(async (session) => view(await book.of({ user, chat, session }))));
      return views.sort((a, b) => a.opened - b.opened);
    },
  };
}
