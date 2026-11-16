// The agent file tree (§5) as the host gives it: layers in load order, the three kinds of file,
// and the one rule held on writes, which is where agents may write (§5.1). Guidance is loaded from
// here, and the file tools work over it.
//
// Paths. Every path is the path an agent sees: relative, separated by "/", rooted at the chat's
// folder (§5.1: "agents see the chat folder as their root"). A leading "/" or "./" means the same
// root. The global, character and shipped levels appear under their layer's `mount`. The host
// normalizes every path before it acts on it; one that leaves the view, or that passes through a
// link, is refused (§5.1: "paths are normalized and links are not followed").
//
// A read with no chat in view (a connection's test, a sign-in, a request passed through) names only
// the user (`UserScope`): its view is the two levels every chat shares, shipped then global, under
// their mounts, and nothing of a character's or a chat's; it writes nowhere.

import type { AgentRef, RunScope, Scope, UserScope } from "./common";

/** A level of the tree, farthest first: shipped < global < character < chat (§5.2). The nearer level wins a conflict. */
export type LayerLevel = "shipped" | "global" | "character" | "chat";

/** The kinds of guidance that live in folders of their own at each level (§5.4). */
export type GuidanceKind = "agents" | "skills" | "rules" | "hooks" | "prompts" | "tools";

/** One level of the tree, where guidance is loaded from. */
export interface Layer {
  level: LayerLevel;
  /**
   * Where the level appears in the paths agents and RPH use. `""` for the chat level, which is the
   * agents' root; for the others, the same in every host: `@shipped/`, `@global/`, `@character/`.
   */
  mount: string;
  /**
   * The folder of each kind of guidance inside the level, relative to `mount` (`.agents` at the
   * global level, `agents` at a chat's, §5). A kind the level does not hold is absent.
   */
  folders: { [kind in GuidanceKind]?: string };
  /**
   * The level's config file, relative to `mount`, where it has one: YAML (§5.4 "Config": limits,
   * permissions, which files are in force and when). The host writes it; RPH reads it like any other file.
   */
  config?: string;
}

/**
 * The three kinds of file (§5.1). `yours`: instructions, rules, skills, definitions, hooks, prompt
 * parts, config; agents read them only. `notes`: the agents' notes; agents read and write them.
 * `generated`: snapshots and indexes; agents read them, and write only in this turn's own folders.
 * Every file of a mounted level, shipped defaults included, is `yours`.
 */
export type FileKind = "yours" | "notes" | "generated";

/** The chat's own places, so RPH can say where things go and put its own files there. */
export interface Places {
  /** The notes folder (§5 `persistent-workspace/`), ending in "/". */
  notes: string;
  /** The session's folder (§5 `sessions/<session-id>/`), ending in "/": the session file and its `cache/` live in it (§11). */
  session: string;
  /** This turn's folder (§5.3), ending in "/"; absent when the scope names no turn. */
  turn?: string;
  /**
   * Every folder an agent of this scope may write in, each ending in "/": the notes, and this turn's
   * `queries/`, `scratch/`, `output/` and `cache/` (§5.1). A refusal names them (§5.1: "a plain
   * refusal that says where notes go").
   */
  writable: string[];
}

/** Lines of a file to read: from `start` to `end`, both counted from 1 and both included. `end` absent: to the file's end. */
export interface Range {
  start: number;
  end?: number;
}

/**
 * A file read. `text` is exactly the part of the file the range covers: whole lines, each with the
 * line break that ends it in the file. `bytes`, `hash` and `lines` are the whole file's, so a reader
 * can tell whether the file changed since it last read it (§5.2: a file changed mid-session).
 */
export interface FileText {
  status: "read";
  /** The path as normalized. */
  path: string;
  level: LayerLevel;
  kind: FileKind;
  text: string;
  /** The lines `text` covers. Past the file's end, `text` is empty and `end` is `start - 1`. */
  start: number;
  end: number;
  /** The file's lines. A final line break ends the last line and does not start another. */
  lines: number;
  /** The file's size in bytes. */
  bytes: number;
  /** SHA-256 of the whole file, lower-case hex. */
  hash: string;
  /** When the file last changed, in milliseconds since 1970. */
  modified: number;
}

/** Nothing to read at the path: no file there, or a folder (`folder`; list it with `find`). */
export interface FileMissing {
  status: "missing";
  path: string;
  folder?: true;
}

/** What a read gives: the text, nothing there, or a refusal because the path leaves the view. */
export type FileRead = FileText | FileMissing | Refused;

/**
 * What `find` looks for. `path` is the folder to look under (the root when absent); `limit` caps
 * the hits (the host's own cap when absent): a limit above the host's own cap, `Infinity` included,
 * asks for every hit, which the host gives whole or answers as stopped at its cap (`FindStopped`).
 * Under the root, `list` shows each other level's mount as a folder, while `glob` and `grep` look
 * in the chat's own level only; under a mount, a find looks in that level only.
 */
export type FileQuery =
  | { by: "list"; path?: string; /** How many folders deep to list; 1 when absent. */ depth?: number; limit?: number }
  | { by: "glob"; /** A glob over paths below `path`: `**\/*.md`. */ pattern: string; path?: string; limit?: number }
  | {
      by: "grep";
      /** A regular expression (JavaScript syntax), or the text itself with `literal`. */
      pattern: string;
      literal?: boolean;
      ignoreCase?: boolean;
      /** Only files whose path below `path` matches this glob. */
      glob?: string;
      path?: string;
      limit?: number;
    };

/**
 * One thing `find` found. A `list` or `glob` hit is a file or a folder; a `grep` hit is one line of a
 * file, with its number and its text.
 */
export interface FileHit {
  path: string;
  type: "file" | "folder";
  level: LayerLevel;
  /** A file's kind; a folder's is the kind its files take. */
  kind: FileKind;
  /** A file's size in bytes. */
  bytes?: number;
  /** For `grep`: the line's number, from 1. */
  line?: number;
  /** For `grep`: the line's text. */
  text?: string;
}

/**
 * Why a find stopped before it had looked everywhere, each way that happened with its counts: the
 * hits reached the limit and more were there; a grep passed over the files larger than it reads;
 * a grep cut the lines it gave at its line limit; it ran out of time. The host's own bounds are
 * facts here, never words: RPH tells the agent in the words of a file, and how to narrow the search.
 */
export interface FindStopped {
  /** The hits reached `max` (the query's limit, or the host's own cap) and more were there. */
  limit?: { max: number };
  /** A grep passed over `files` files larger than `bytes` bytes, which it does not read. */
  large?: { files: number; bytes: number };
  /** A grep cut `lines` of the lines it gave to `chars` characters each. */
  cut?: { lines: number; chars: number };
  /** It ran out of the `ms` milliseconds it was given. */
  time?: { ms: number };
}

/** What a find gives: the hits, and, when it stopped before it had looked everywhere, why. A host that stops in silence fails the kit. */
export interface Found {
  status: "found";
  hits: FileHit[];
  stopped?: FindStopped;
}

/**
 * A change to one file. `write` makes or replaces it whole; `append` adds to its end, making it if
 * it is not there; `edit` replaces `old` with `new`, which must appear exactly once unless `all`;
 * `delete` removes it.
 */
export type FileOp =
  | { op: "write"; text: string }
  | { op: "append"; text: string }
  | { op: "edit"; old: string; new: string; all?: boolean }
  | { op: "delete" };

/**
 * Who writes. An agent writes only where `Places.writable` says. `"harness"` is RPH itself, writing
 * its own records (the session file and cache, the turn's transcripts, the released reply,
 * §5.3 and §11): it may also write in the session's folder, and nowhere else an agent may not.
 * Nobody writes a `yours` file or a mounted level through this port: those are the user's (§5.1),
 * save the owner's own press below.
 */
export type Writer = AgentRef | "harness";

/**
 * The owner's own press, made through RPH's API on his word (`rules.switch`, C-10): it writes the
 * config file (`Layer.config`) of the chat's level or of the global level, and nothing else. It is
 * no agent's write: nothing records it against a turn.
 */
export type OwnerWrite = "owner";

/** A change made. */
export interface Written {
  status: "written";
  path: string;
  kind: FileKind;
  op: FileOp["op"];
  /** The file's size after the change; 0 once deleted. */
  bytes: number;
  /** SHA-256 of the file after the change, lower-case hex; null once deleted. */
  hash: string | null;
  /** SHA-256 of the file before the change; null when it was not there. */
  before: string | null;
}

/**
 * Why a write, a read or a find was refused. `yours`: a user's file. `generated`: a generated file
 * outside this writer's folders. `mounted`: a file of the global, character or shipped level.
 * `outside`: the path leaves the view. `link`: the path passes through a link. `invalid`: not a
 * path (holding a NUL or a backslash).
 */
export type RefusalReason = "yours" | "generated" | "mounted" | "outside" | "link" | "invalid";

/**
 * A refusal: the place is not one this writer may write (or, for a read or a find, not one in the
 * view). Nothing was changed. The place is judged before the change, so a change that could not
 * apply anyway is still refused there. It carries facts, not words: RPH tells the agent in the
 * words of a file (no prompt text in code), naming where it may write.
 */
export interface Refused {
  status: "refused";
  /** The path as normalized, or as given when it leaves the view or is not a path. */
  path: string;
  reason: RefusalReason;
  /** Where this writer may write: `Places.writable`, and for RPH itself the session's folder too (`Writer`). */
  writable: string[];
}

/**
 * A change that could not apply to a place the writer may write: nothing was changed. `missing`:
 * no file to edit or delete. `folder`: the path names a folder. `no-match`: an edit's `old` is not
 * in the file (an empty `old` never is). `several`: it is there more than once and the edit did not
 * say `all` (`matches` says how often).
 */
export interface Unapplied {
  status: "unapplied";
  path: string;
  reason: "missing" | "folder" | "no-match" | "several";
  matches?: number;
}

export interface FilesPort {
  /**
   * The levels in load order, farthest first: shipped < global < character < chat (§5.2). The chat
   * level is always there, with mount `""`. For a scope that names only the user, the two levels
   * every chat shares, shipped then global, under the same mounts, and no other.
   */
  layers(scope: Scope | UserScope): Promise<Layer[]>;
  /** The chat's notes, session and turn folders, and where agents of this scope may write; for a job of no chat (C-23), its session's folder at the user's level, and no chat's or turn's. */
  places(scope: RunScope): Promise<Places>;
  /**
   * Reads a file, or the lines `range` names. With a scope that names only the user, a path at a
   * character's or a chat's level (the root among them) is refused as `outside`, `writable` empty.
   */
  read(scope: Scope | UserScope, path: string, range?: Range): Promise<FileRead>;
  /**
   * Lists a folder, matches paths by a glob, or finds lines by a pattern. Hits come in the order of
   * their paths, a folder's path read with "/" after it. Links are never followed. A `path` that
   * leaves the view is refused; with a scope that names only the user, so is one at a character's or
   * a chat's level, the root among them. An invalid `pattern` rejects with a `SyntaxError`. The answer
   * gives the hits, and, when the host stopped before it had looked everywhere, why (`FindStopped`):
   * a host never gives a part as if it were the whole.
   */
  find(scope: Scope | UserScope, query: FileQuery): Promise<Found | Refused>;
  /**
   * Changes one file. A place this writer may not write is `Refused`, and nothing changes (§5.1).
   * Every write of an agent is recorded against `scope.turn` where there is one (§5.1: "notes
   * follow the turn"), so a swipe or a delete puts it back. A scope that names only the user writes
   * nowhere: every write so named is refused, `writable` empty.
   */
  write(scope: Scope | UserScope, path: string, op: FileOp, by: Writer | OwnerWrite): Promise<Written | Refused | Unapplied>;
}
