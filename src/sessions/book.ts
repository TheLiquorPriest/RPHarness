// Each session's file (§11), read when something works on it (a turn, a call of the sessions API)
// and held in memory only while something does: once its lines are written and nothing holds it,
// it is let go, and the next to ask reads it again, so the file on disk is what counts. It is
// written through the host's files port as the writer "harness", into the session's folder: one
// whole line per entry, in the order the entries are made. A write that fails is said once while it
// lasts (at its first failure, and again when a write lands), and its lines are not lost: they go
// out again, before anything newer, with the next append, and the file is kept in memory until they
// are on disk. So no entry on disk ever names a parent the file lacks, and the turns after a failed
// write still find the session whole. What is held is bounded by the user's `sessions.unwrittenMiB`:
// past it, a run whose own file cannot be written ends failed (`over`), and what it held stays held.
import type { FileRead, FilesPort, JsonValue, Log, RunScope } from "../contract";
import { lineOf, parseSession, type SessionEntry, type SessionHeader, SessionLog } from "./file";

/** A session's own scope within a run's: the user, the chat where there is one (none for a job of no chat, C-23), and the session. */
export function sessionScope(scope: RunScope, session: string): RunScope {
  return scope.chat === undefined ? { user: scope.user, session } : { user: scope.user, chat: scope.chat, session };
}

/** The chat a session's first line names, where it has one. */
function chatOf(scope: RunScope): { chat?: string } {
  return scope.chat === undefined ? {} : { chat: scope.chat };
}

type Unsaved<E> = E extends SessionEntry ? Omit<E, "id" | "at"> : never;

/** An entry as it is asked for: everything but its id and when, which the file gives it. */
export type NewEntry = Unsaved<SessionEntry>;

/** Why a session file could not be read: as a whole (the host's or the error's words), or some of its lines. */
export type Unreadable = { reason: string } | { lines: number[] };

export interface BookDeps {
  files: FilesPort;
  log: Log;
  /** RPH's own ids, which session entries take (`HarnessOptions.ids`). */
  ids(): string;
  now(): number;
  /** A file something changed was let go: what lists the chat's sessions is brought up to date. */
  changed?(file: SessionFile): void;
}

/** What a file is made with: the book's, and where it tells the book of the bytes it holds and lets go. */
interface FileDeps extends BookDeps {
  held(bytes: number): void;
}

/** Mebibytes, as `sessions.unwrittenMiB` counts them, in bytes. */
export const MIB = 1024 * 1024;

/** One session's file: its tree in memory, and its lines on disk. */
export class SessionFile {
  /** The session's own scope: whose, which chat, which session. */
  readonly scope: RunScope;
  /** Where it is, in the agents' view: `<session>.jsonl` in the session's folder (§5). */
  readonly path: string;
  readonly log: SessionLog;
  /** The characters of its lines held in memory: those read, and those added since. */
  chars = 0;
  header: SessionHeader | undefined;
  readonly #d: FileDeps;
  /** Whether the file has its first line on disk, or holds something that is not to be written over. */
  #begun: boolean;
  /** Whether what is on disk may end part-way through a line (a write cut off, a file that could not be read): the next line then starts a line of its own. */
  #cut: boolean;
  /** Lines not on disk yet: given while an append is under way, or of an append that failed. The next append writes them together, in the order given. */
  #queued = "";
  /** The appends under way, until the queue is empty or one fails. */
  #writing: Promise<void> | undefined;
  /** Whether something was written to it since `takeChanged` was last asked. */
  #changed = false;
  /** The host's reason, or the error's words, while its writes fail: set at the first failure, said once then, and cleared when a write lands. */
  #failure: string | undefined;
  /**
   * Why the file could not be read, where it could not: refused or failed as a whole (`reason`, the
   * host's or the error's words), or lines that do not parse (`lines`, from 1). The turn is told, and
   * goes on from what was read.
   */
  readonly unreadable: Unreadable | undefined;

  constructor(d: FileDeps, scope: RunScope, path: string, header: SessionHeader | undefined, entries: readonly SessionEntry[], begun: boolean, cut: boolean, unreadable?: Unreadable) {
    this.#d = d;
    this.scope = scope;
    this.path = path;
    this.header = header;
    this.log = new SessionLog(entries);
    this.#begun = begun;
    this.#cut = cut;
    this.unreadable = unreadable;
  }

  /** Adds an entry: in the tree at once, on disk after every entry before it. The file is begun with its first line if it has none yet. */
  add<E extends NewEntry>(entry: E): E & { id: string; at: number } {
    const full = { ...entry, id: this.#d.ids(), at: this.#d.now() };
    const saved = full as unknown as SessionEntry;
    this.log.add(saved);
    let text = lineOf(saved);
    if (!this.#begun) {
      this.#begun = true;
      this.header = { type: "session", version: 1, id: this.scope.session, user: this.scope.user, ...chatOf(this.scope), at: full.at };
      text = lineOf(this.header) + text;
    }
    this.#write(text);
    return full;
  }

  /** Begins the file of an agent's run that is a session of its own: its first line names what it is and what started it. A file begun already is left as it is. */
  begin(run: Required<Pick<SessionHeader, "kind" | "parent" | "agent">>): void {
    if (this.#begun) return;
    this.#begun = true;
    this.header = { type: "session", version: 1, id: this.scope.session, user: this.scope.user, ...chatOf(this.scope), at: this.#d.now(), ...run };
    this.#write(lineOf(this.header));
  }

  /** Begins the file as a branch: its first line names where it was forked from, then the entries it starts from, written as one. */
  copy(entries: readonly SessionEntry[], from: NonNullable<SessionHeader["from"]>): void {
    this.#begun = true;
    this.header = { type: "session", version: 1, id: this.scope.session, user: this.scope.user, ...chatOf(this.scope), at: this.#d.now(), from };
    for (const entry of entries) this.log.add(entry);
    this.#write([this.header, ...entries].map(lineOf).join(""));
  }

  /** Resolves once every line given so far is written, or its failure logged. */
  async settled(): Promise<void> {
    await this.#writing;
  }

  /** Whether lines given are still not on disk: an append is under way, or one failed and its lines wait for the next. */
  get unwritten(): boolean {
    return this.#queued !== "" || this.#writing !== undefined;
  }

  /** Why its writes fail, while they do: the host's reason (a refusal's, an unapplied change's) or the error's words. */
  get failure(): string | undefined {
    return this.#failure;
  }

  /** Whether something was written to it since this was last asked: asking clears it. */
  takeChanged(): boolean {
    const was = this.#changed;
    this.#changed = false;
    return was;
  }

  /** Tries again what an append could not write, and resolves as `settled` does. */
  async flush(): Promise<void> {
    if (this.#queued !== "") this.#writing ??= this.#drain();
    await this.#writing;
  }

  #write(text: string): void {
    this.#changed = true;
    this.chars += text.length;
    this.#queued += text;
    this.#d.held(Buffer.byteLength(text, "utf8"));
    this.#writing ??= this.#drain();
  }

  /**
   * Appends what is queued, one append at a time, until nothing is, or until one fails: its lines then
   * wait, first in the queue, for the next. A failure is said at the first (warn, with the file and the
   * reason), not again while it lasts, and once more when a write lands (info, with how many lines went out late).
   */
  async #drain(): Promise<void> {
    const { files, log } = this.#d;
    try {
      while (this.#queued !== "") {
        const lines = this.#queued;
        this.#queued = "";
        // After a line cut off part-way, a new line first: the cut one is passed over when the file is read, and these stay whole.
        const text = this.#cut ? `\n${lines}` : lines;
        let failed: Record<string, JsonValue> | undefined;
        let reason = "";
        try {
          const done = await files.write(this.scope, this.path, { op: "append", text }, "harness");
          if (done.status !== "written") {
            reason = done.reason;
            failed = { status: done.status, reason };
          }
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
          failed = { error: reason };
        }
        this.#cut = failed !== undefined;
        if (failed === undefined) {
          this.#d.held(-Buffer.byteLength(lines, "utf8"));
          if (this.#failure !== undefined) log.info("The session file is written again; the lines it held went out late.", { session: this.scope.session, path: this.path, lines: lineCount(lines) });
          this.#failure = undefined;
          continue;
        }
        // Some of them may be on disk already, cut off or whole: a line read twice is the same entry, and the reader keeps it once.
        this.#queued = lines + this.#queued;
        if (this.#failure === undefined) log.warn("The session file could not be written; its lines are held, and go out with the next write that lands.", { session: this.scope.session, path: this.path, ...failed });
        this.#failure = reason;
        return;
      }
    } finally {
      this.#writing = undefined;
    }
  }
}

/** How many lines a text of whole lines holds. */
function lineCount(text: string): number {
  let count = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count += 1;
  return count;
}

/** A session's file while something works on it. */
export interface HeldFile {
  file: SessionFile;
  /** Done with it: once nothing holds it and its lines are written, the book lets it go. */
  release(): void;
}

interface Kept {
  file: Promise<SessionFile>;
  holds: number;
  /** The file once read. */
  read?: SessionFile;
}

/**
 * The session files something is working on, by user, chat and session, and the ones used last
 * kept read between their turns (`held`, the user's `sessions.held`): a session's next turn reads
 * nothing again, and past that many the one used least recently is let go, to be read whole when
 * next asked for. A file that could not be read is never kept: the next to ask reads it again. The
 * lines its files hold that are not on disk yet are counted, every file's, against `heldMost`.
 */
export class SessionBook {
  readonly #d: BookDeps;
  /** What each file is made with: the book's, and the count of what it holds. */
  readonly #fileDeps: FileDeps;
  readonly #files = new Map<string, Kept>();
  /** The files nothing holds now that are kept read, by key, the one used least recently first. */
  readonly #idle = new Set<string>();
  /** How many files nothing holds are kept read between their turns (`sessions.held`), as the latest turn read the setting. */
  held = 8;
  /** The bytes of lines given to every file and not on disk yet. */
  #heldBytes = 0;
  /** The most of them held while files cannot be written (`sessions.unwrittenMiB`), in bytes, as the latest run read the setting. */
  heldMost = 64 * MIB;

  constructor(d: BookDeps) {
    this.#d = d;
    this.#fileDeps = {
      ...d,
      held: (bytes) => {
        this.#heldBytes += bytes;
      },
    };
  }

  /** Whether the lines held are past `heldMost`: a run whose own file cannot be written then stops, and ends failed. Its lines stay held. */
  get over(): boolean {
    return this.#heldBytes > this.heldMost;
  }

  /** How many session files are held in memory now, those worked on and those kept read between their turns, and the characters of their lines. */
  heldNow(): { files: number; chars: number } {
    let chars = 0;
    for (const kept of this.#files.values()) chars += kept.read?.chars ?? 0;
    return { files: this.#files.size, chars };
  }

  /** The file of the session a scope names, held until released: read from disk when nothing holds it, and the same file for all that hold it at once. */
  async hold(scope: RunScope): Promise<HeldFile> {
    const key = JSON.stringify([scope.user, scope.chat ?? null, scope.session]);
    let kept = this.#files.get(key);
    if (kept === undefined) {
      kept = { file: this.#read(sessionScope(scope, scope.session)), holds: 0 };
      this.#files.set(key, kept);
    }
    this.#idle.delete(key);
    kept.holds += 1;
    const held = kept;
    let file: SessionFile;
    try {
      file = await held.file;
      held.read = file;
    } catch (error) {
      this.#let(key, held);
      throw error;
    }
    let released = false;
    return {
      file,
      release: () => {
        if (released) return;
        released = true;
        // Told as it is let go, before the holder goes on: a listing asked next finds it.
        if (file.takeChanged()) this.#d.changed?.(file);
        this.#let(key, held);
      },
    };
  }

  /** Works on the file of the session a scope names, holding it until the work is done. */
  async with<T>(scope: RunScope, work: (file: SessionFile) => T | Promise<T>): Promise<T> {
    const { file, release } = await this.hold(scope);
    try {
      return await work(file);
    } finally {
      release();
    }
  }

  /**
   * One holder fewer: with none left, the file is kept read among the idle ones once its lines are
   * written, unless something holds it again by then; the idle past `held` are let go, the least
   * recently used first. A file whose lines an append could not write is kept, so the next to hold it
   * finds its tree whole, and those lines go out first with the next it writes; one that could not be
   * read is let go, so the next to ask reads it again.
   */
  #let(key: string, kept: Kept): void {
    kept.holds -= 1;
    if (kept.holds > 0) return;
    const drop = (): void => {
      if (kept.holds === 0 && this.#files.get(key) === kept) this.#files.delete(key);
    };
    void kept.file.then(async (file) => {
      await file.settled();
      if (file.unwritten || kept.holds > 0 || this.#files.get(key) !== kept) return;
      if (file.unreadable !== undefined && "reason" in file.unreadable) return drop();
      this.#idle.delete(key);
      this.#idle.add(key);
      this.#trim();
    }, drop);
  }

  /** Lets go of the idle files past `held`, the least recently used first. */
  #trim(): void {
    for (const key of this.#idle) {
      if (this.#idle.size <= this.held) return;
      this.#idle.delete(key);
      const kept = this.#files.get(key);
      if (kept !== undefined && kept.holds === 0) this.#files.delete(key);
    }
  }

  /** Resolves once every line given so far, to every file, is written, or its failure logged: lines an append could not write are tried once more. */
  async settled(): Promise<void> {
    const files = await Promise.allSettled([...this.#files.values()].map((kept) => kept.file));
    await Promise.all(files.map((file) => (file.status === "fulfilled" ? file.value.flush() : undefined)));
  }

  async #read(scope: RunScope): Promise<SessionFile> {
    const { files, log } = this.#d;
    const places = await files.places(scope);
    const path = `${places.session}${scope.session}.jsonl`;
    let read: FileRead;
    try {
      read = await files.read(scope, path);
    } catch (error) {
      // Nothing of it can be known: the session goes on from nothing, the turn is told, and what is added is put after whatever the file holds, on a line of its own.
      const reason = error instanceof Error ? error.message : String(error);
      log.error("The session file could not be read; nothing of its earlier turns is known.", { session: scope.session, path, error: reason });
      return new SessionFile(this.#fileDeps, scope, path, undefined, [], true, true, { reason });
    }
    if (read.status === "missing") return new SessionFile(this.#fileDeps, scope, path, undefined, [], false, false);
    if (read.status === "refused") {
      log.error("The session file could not be read; nothing of its earlier turns is known.", { session: scope.session, path, reason: read.reason });
      return new SessionFile(this.#fileDeps, scope, path, undefined, [], true, true, { reason: read.reason });
    }
    const parsed = parseSession(read.text);
    if (parsed.unread.length > 0) log.warn("Lines of the session file could not be read and are passed over.", { session: scope.session, path, lines: parsed.unread });
    const file = new SessionFile(this.#fileDeps, scope, path, parsed.header, parsed.entries, true, read.text !== "" && !read.text.endsWith("\n"), parsed.unread.length > 0 ? { lines: parsed.unread } : undefined);
    file.chars = read.text.length;
    return file;
  }
}
