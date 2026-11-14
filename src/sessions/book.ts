// Each session's file (§11), read once when first asked for and kept while the harness runs, and
// written through the host's files port as the writer "harness", into the session's folder: one
// whole line per entry, in the order the entries are made. A write that fails is logged; the turn
// it records goes on.
import type { FileRead, FilesPort, Log, Scope } from "../contract";
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
  #writing: Promise<void> = Promise.resolve();

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
  add(entry: NewEntry): SessionEntry {
    const full = { ...entry, id: this.#d.ids(), at: this.#d.now() } as SessionEntry;
    this.log.add(full);
    let text = lineOf(full);
    if (!this.#begun) {
      this.#begun = true;
      this.header = { type: "session", version: 1, id: this.scope.session, user: this.scope.user, chat: this.scope.chat, at: full.at };
      text = lineOf(this.header) + text;
    }
    this.#write(text);
    return full;
  }

  /** Begins the file as a branch: its first line names where it was forked from, then the entries it starts from, written as one. */
  copy(entries: readonly SessionEntry[], from: NonNullable<SessionHeader["from"]>): void {
    this.#begun = true;
    this.header = { type: "session", version: 1, id: this.scope.session, user: this.scope.user, chat: this.scope.chat, at: this.#d.now(), from };
    for (const entry of entries) this.log.add(entry);
    this.#write([this.header, ...entries].map(lineOf).join(""));
  }

  /** Resolves once every line given so far is written, or its failure logged. */
  settled(): Promise<void> {
    return this.#writing;
  }

  #write(text: string): void {
    const { files, log } = this.#d;
    this.#writing = this.#writing.then(async () => {
      // After a line cut off part-way, a new line first: the cut one is passed over when the file is read, and this one stays whole.
      const line = this.#cut ? `\n${text}` : text;
      try {
        const done = await files.write(this.scope, this.path, { op: "append", text: line }, "harness");
        this.#cut = done.status !== "written";
        if (done.status !== "written") log.error("The session file could not be written.", { session: this.scope.session, path: this.path, status: done.status, reason: done.reason });
      } catch (error) {
        this.#cut = true;
        log.error("The session file could not be written.", { session: this.scope.session, path: this.path, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}

/** Every session's file the harness has asked for, by user, chat and session. */
export class SessionBook {
  readonly #d: BookDeps;
  readonly #files = new Map<string, Promise<SessionFile>>();

  constructor(d: BookDeps) {
    this.#d = d;
  }

  /** The file of the session a scope names, read from disk the first time; asked again after a read that failed. */
  of(scope: Scope): Promise<SessionFile> {
    const key = JSON.stringify([scope.user, scope.chat, scope.session]);
    let file = this.#files.get(key);
    if (file === undefined) {
      const read = this.#read({ user: scope.user, chat: scope.chat, session: scope.session });
      read.catch(() => {
        if (this.#files.get(key) === read) this.#files.delete(key);
      });
      this.#files.set(key, read);
      file = read;
    }
    return file;
  }

  /** Resolves once every line given so far, to every file, is written. */
  async settled(): Promise<void> {
    const files = await Promise.allSettled([...this.#files.values()]);
    await Promise.all(files.map((file) => (file.status === "fulfilled" ? file.value.settled() : undefined)));
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
