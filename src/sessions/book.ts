// Each session's file (§11), read when something works on it (a turn, a call of the sessions API)
// and held in memory only while something does: once its lines are written and nothing holds it,
// it is let go, and the next to ask reads it again, so the file on disk is what counts. It is
// written through the host's files port as the writer "harness", into the session's folder: one
// whole line per entry, in the order the entries are made. A write that fails is logged and its
// lines are not lost: they go out again, before anything newer, with the next append, and the file
// is kept in memory until they are on disk. So no entry on disk ever names a parent the file
// lacks, and the turns after a failed write still find the session whole. The turn it records goes on.
import type { FileRead, FilesPort, JsonValue, Log, Scope } from "../contract";
import { lineOf, parseSession, type SessionEntry, type SessionHeader, SessionLog } from "./file";

type Unsaved<E> = E extends SessionEntry ? Omit<E, "id" | "at"> : never;

/** An entry as it is asked for: everything but its id and when, which the file gives it. */
export type NewEntry = Unsaved<SessionEntry>;

export interface BookDeps {
  files: FilesPort;
  log: Log;
  /** RPH's own ids, which session entries take (`HarnessOptions.ids`). */
  ids(): string;
  now(): number;
}

/** One session's file: its tree in memory, and its lines on disk. */
export class SessionFile {
  /** The session's own scope: whose, which chat, which session. */
  readonly scope: Scope;
  /** Where it is, in the agents' view: `<session>.jsonl` in the session's folder (§5). */
  readonly path: string;
  readonly log: SessionLog;
  header: SessionHeader | undefined;
  readonly #d: BookDeps;
  /** Whether the file has its first line on disk, or holds something that is not to be written over. */
  #begun: boolean;
  /** Whether what is on disk may end part-way through a line (a write cut off, a file that could not be read): the next line then starts a line of its own. */
  #cut: boolean;
  /** Lines not on disk yet: given while an append is under way, or of an append that failed. The next append writes them together, in the order given. */
  #queued = "";
  /** The appends under way, until the queue is empty or one fails. */
  #writing: Promise<void> | undefined;

  constructor(d: BookDeps, scope: Scope, path: string, header: SessionHeader | undefined, entries: readonly SessionEntry[], begun: boolean, cut: boolean) {
    this.#d = d;
    this.scope = scope;
    this.path = path;
    this.header = header;
    this.log = new SessionLog(entries);
    this.#begun = begun;
    this.#cut = cut;
  }

  /** Adds an entry: in the tree at once, on disk after every entry before it. The file is begun with its first line if it has none yet. */
  add<E extends NewEntry>(entry: E): E & { id: string; at: number } {
    const full = { ...entry, id: this.#d.ids(), at: this.#d.now() };
    const saved = full as unknown as SessionEntry;
    this.log.add(saved);
    let text = lineOf(saved);
    if (!this.#begun) {
      this.#begun = true;
      this.header = { type: "session", version: 1, id: this.scope.session, user: this.scope.user, chat: this.scope.chat, at: full.at };
      text = lineOf(this.header) + text;
    }
    this.#write(text);
    return full;
  }

  /** Begins the file of an agent's run that is a session of its own: its first line names what it is and what started it. A file begun already is left as it is. */
  begin(run: Required<Pick<SessionHeader, "kind" | "parent" | "agent">>): void {
    if (this.#begun) return;
    this.#begun = true;
    this.header = { type: "session", version: 1, id: this.scope.session, user: this.scope.user, chat: this.scope.chat, at: this.#d.now(), ...run };
    this.#write(lineOf(this.header));
  }

  /** Begins the file as a branch: its first line names where it was forked from, then the entries it starts from, written as one. */
  copy(entries: readonly SessionEntry[], from: NonNullable<SessionHeader["from"]>): void {
    this.#begun = true;
    this.header = { type: "session", version: 1, id: this.scope.session, user: this.scope.user, chat: this.scope.chat, at: this.#d.now(), from };
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

  /** Tries again what an append could not write, and resolves as `settled` does. */
  async flush(): Promise<void> {
    if (this.#queued !== "") this.#writing ??= this.#drain();
    await this.#writing;
  }

  #write(text: string): void {
    this.#queued += text;
    this.#writing ??= this.#drain();
  }

  /** Appends what is queued, one append at a time, until nothing is, or until one fails: its lines then wait, first in the queue, for the next. */
  async #drain(): Promise<void> {
    const { files, log } = this.#d;
    try {
      while (this.#queued !== "") {
        const lines = this.#queued;
        this.#queued = "";
        // After a line cut off part-way, a new line first: the cut one is passed over when the file is read, and these stay whole.
        const text = this.#cut ? `\n${lines}` : lines;
        let failed: Record<string, JsonValue> | undefined;
        try {
          const done = await files.write(this.scope, this.path, { op: "append", text }, "harness");
          if (done.status !== "written") failed = { status: done.status, reason: done.reason };
        } catch (error) {
          failed = { error: error instanceof Error ? error.message : String(error) };
        }
        this.#cut = failed !== undefined;
        if (failed === undefined) continue;
        // Some of them may be on disk already, cut off or whole: a line read twice is the same entry, and the reader keeps it once.
        this.#queued = lines + this.#queued;
        log.error("The session file could not be written; its lines are kept, and go out again with the next.", { session: this.scope.session, path: this.path, ...failed });
        return;
      }
    } finally {
      this.#writing = undefined;
    }
  }
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
}

/** The session files something is working on, by user, chat and session. */
export class SessionBook {
  readonly #d: BookDeps;
  readonly #files = new Map<string, Kept>();

  constructor(d: BookDeps) {
    this.#d = d;
  }

  /** The file of the session a scope names, held until released: read from disk when nothing holds it, and the same file for all that hold it at once. */
  async hold(scope: Scope): Promise<HeldFile> {
    const key = JSON.stringify([scope.user, scope.chat, scope.session]);
    let kept = this.#files.get(key);
    if (kept === undefined) {
      kept = { file: this.#read({ user: scope.user, chat: scope.chat, session: scope.session }), holds: 0 };
      this.#files.set(key, kept);
    }
    kept.holds += 1;
    const held = kept;
    let file: SessionFile;
    try {
      file = await held.file;
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
        this.#let(key, held);
      },
    };
  }

  /** Works on the file of the session a scope names, holding it until the work is done. */
  async with<T>(scope: Scope, work: (file: SessionFile) => T | Promise<T>): Promise<T> {
    const { file, release } = await this.hold(scope);
    try {
      return await work(file);
    } finally {
      release();
    }
  }

  /**
   * One holder fewer: with none left, the file is let go once its lines are written, unless
   * something holds it again by then. A file whose lines an append could not write is kept, so the
   * next to hold it finds its tree whole, and those lines go out first with the next it writes.
   */
  #let(key: string, kept: Kept): void {
    kept.holds -= 1;
    if (kept.holds > 0) return;
    const drop = (): void => {
      if (kept.holds === 0 && this.#files.get(key) === kept) this.#files.delete(key);
    };
    void kept.file.then(async (file) => {
      await file.settled();
      if (!file.unwritten) drop();
    }, drop);
  }

  /** Resolves once every line given so far, to every file, is written, or its failure logged: lines an append could not write are tried once more. */
  async settled(): Promise<void> {
    const files = await Promise.allSettled([...this.#files.values()].map((kept) => kept.file));
    await Promise.all(files.map((file) => (file.status === "fulfilled" ? file.value.flush() : undefined)));
  }

  async #read(scope: Scope): Promise<SessionFile> {
    const { files, log } = this.#d;
    const places = await files.places(scope);
    const path = `${places.session}${scope.session}.jsonl`;
    let read: FileRead;
    try {
      read = await files.read(scope, path);
    } catch (error) {
      // Nothing of it can be known: the session goes on from nothing, and what is added is put after whatever the file holds, on a line of its own.
      log.error("The session file could not be read; nothing of its earlier turns is known.", { session: scope.session, path, error: error instanceof Error ? error.message : String(error) });
      return new SessionFile(this.#d, scope, path, undefined, [], true, true);
    }
    if (read.status === "missing") return new SessionFile(this.#d, scope, path, undefined, [], false, false);
    if (read.status === "refused") {
      log.error("The session file could not be read; nothing of its earlier turns is known.", { session: scope.session, path, reason: read.reason });
      return new SessionFile(this.#d, scope, path, undefined, [], true, true);
    }
    const parsed = parseSession(read.text);
    if (parsed.unread.length > 0) log.warn("Lines of the session file could not be read and are passed over.", { session: scope.session, path, lines: parsed.unread });
    return new SessionFile(this.#d, scope, path, parsed.header, parsed.entries, true, read.text !== "" && !read.text.endsWith("\n"));
  }
}
