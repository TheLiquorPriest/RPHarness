// The session file (§11): one line per entry, a tree by parent, in the shape pi's coding agent keeps
// its sessions in. The first line says what the file is; every other line is an entry with its own
// id and the id of the entry it follows. Nothing in it is ever changed or deleted: a swipe is a
// branch from the entry before the turn it replaces, and a turn that left the path is marked so,
// its entries kept where they are.
//
// Which entries are on the path is worked out from the file alone, by reading it in order, so a
// harness that starts again finds the session as it stood.
import type { JsonValue, TurnKind } from "../contract";
import { isMapping } from "../files/header";

/** The file's first line: which session, whose, when it began, and for a branch, where it was forked from. */
export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  user: string;
  chat: string;
  at: number;
  from?: { chat: string; session: string; turn: string };
}

interface EntryBase {
  id: string;
  /** The entry this one follows; null for the first of a tree. */
  parent: string | null;
  /** When it was written, in milliseconds since 1970. */
  at: number;
}

/** The host opened the session (§11: a scene opens), with the summary it opened with. */
export interface OpenedEntry extends EntryBase {
  type: "opened";
  summary?: string;
}

/** A turn began: the request's turn, its kind, its lead, and the turn it follows as the request named it. */
export interface TurnEntry extends EntryBase {
  type: "turn";
  turn: string;
  kind: TurnKind;
  lead: string;
  follows?: string;
  /** Where the turn was played, for a turn a branch took over from another session; absent, in this file's own session. */
  played?: { chat: string; session: string };
}

/** The lead's intent record (§10.3), as it was written. */
export interface IntentEntry extends EntryBase {
  type: "intent";
  turn: string;
  text: string;
}

/** What the lead wrote in one model call: its text and why the call stopped. Its thinking is never kept. */
export interface MessageEntry extends EntryBase {
  type: "message";
  turn: string;
  call: number;
  text: string;
  stop: string;
  error?: string;
}

/** A tool call of the lead, as it ran: by `tool_use` when `via` says so, marked closing when the lead said so. */
export interface CallEntry extends EntryBase {
  type: "call";
  turn: string;
  callId: string;
  tool: string;
  args: JsonValue;
  closing?: true;
  via?: "tool_use";
}

/** What came back to a call, as the lead read it: its text, the reports after it, and whether it failed. Pictures are not kept. */
export interface ResultEntry extends EntryBase {
  type: "result";
  turn: string;
  callId: string;
  tool: string;
  text: string;
  reports?: string[];
  error?: true;
}

/** The host closed the session (§11), as the work of `turn` where it named one: closing belongs to that turn. */
export interface ClosedEntry extends EntryBase {
  type: "closed";
  turn?: string;
}

/** The host said a turn is off the path (swiped away, deleted). A mark: no entry follows it. */
export interface LeftEntry extends EntryBase {
  type: "left";
  turn: string;
}

export type SessionEntry = OpenedEntry | TurnEntry | IntentEntry | MessageEntry | CallEntry | ResultEntry | ClosedEntry | LeftEntry;

/** One line of the file, as written. */
export function lineOf(item: SessionHeader | SessionEntry): string {
  return `${JSON.stringify(item)}\n`;
}

const KINDS: Record<TurnKind, true> = { new: true, swipe: true, regenerate: true, continue: true, impersonate: true };

function str(v: unknown): v is string {
  return typeof v === "string";
}

function optional(v: unknown, test: (v: unknown) => boolean): boolean {
  return v === undefined || test(v);
}

/** Whether a parsed line is an entry of its kind, with every field it must have. */
function isEntry(v: Record<string, unknown>): boolean {
  if (!str(v["id"]) || !(v["parent"] === null || str(v["parent"])) || typeof v["at"] !== "number") return false;
  switch (v["type"]) {
    case "opened":
      return optional(v["summary"], str);
    case "turn":
      return str(v["turn"]) && str(v["kind"]) && Object.hasOwn(KINDS, v["kind"]) && str(v["lead"]) && optional(v["follows"], str) && optional(v["played"], (p) => isMapping(p) && str(p["chat"]) && str(p["session"]));
    case "intent":
      return str(v["turn"]) && str(v["text"]);
    case "message":
      return str(v["turn"]) && typeof v["call"] === "number" && str(v["text"]) && str(v["stop"]) && optional(v["error"], str);
    case "call":
      return str(v["turn"]) && str(v["callId"]) && str(v["tool"]) && v["args"] !== undefined;
    case "result":
      return str(v["turn"]) && str(v["callId"]) && str(v["tool"]) && str(v["text"]) && optional(v["reports"], (r) => Array.isArray(r) && r.every(str));
    case "closed":
      return optional(v["turn"], str);
    case "left":
      return str(v["turn"]);
    default:
      return false;
  }
}

function isHeader(v: Record<string, unknown>): boolean {
  return v["type"] === "session" && str(v["id"]) && str(v["user"]) && str(v["chat"]) && typeof v["at"] === "number";
}

/** A session file read: its header, its entries in the order written, and the lines that could not be read (a write cut off part-way). */
export interface ParsedSession {
  header?: SessionHeader;
  entries: SessionEntry[];
  /** Line numbers, from 1. */
  unread: number[];
}

export function parseSession(text: string): ParsedSession {
  const out: ParsedSession = { entries: [], unread: [] };
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      out.unread.push(index + 1);
      continue;
    }
    if (isMapping(value) && out.header === undefined && out.entries.length === 0 && isHeader(value)) out.header = value as unknown as SessionHeader;
    else if (isMapping(value) && isEntry(value)) out.entries.push(value as unknown as SessionEntry);
    else out.unread.push(index + 1);
  }
  return out;
}

/**
 * A session's entries as a tree, with where it stands. The path is followed by parent from an
 * entry up to the first. What stands is worked out as each entry is added, in the order of the
 * file:
 *
 * - a turn's first entry is the session's position (its leaf);
 * - a later entry of a turn, or a closing, is the leaf when it follows the leaf (an older turn
 *   still at work after a newer one began goes on in its own branch);
 * - a turn the host said left the path is off it, its entries with it, wherever it stands on a
 *   path, until a later turn names it as the turn it follows (a swipe shown again); when the leaf
 *   is in that turn, the leaf goes back to where the turn began.
 */
export class SessionLog {
  readonly entries: SessionEntry[] = [];
  readonly #byId = new Map<string, SessionEntry>();
  readonly #turns = new Map<string, TurnEntry>();
  /** Each turn's newest entry: where a turn that follows it hangs. */
  readonly #tips = new Map<string, string>();
  /** The turns off the path now. */
  readonly #left = new Set<string>();
  #leaf: string | null = null;
  /** The entry the host opened the session with. */
  #opened: OpenedEntry | undefined;

  constructor(entries: readonly SessionEntry[] = []) {
    for (const entry of entries) this.add(entry);
  }

  add(entry: SessionEntry): void {
    if (this.#byId.has(entry.id)) return;
    this.entries.push(entry);
    this.#byId.set(entry.id, entry);
    switch (entry.type) {
      case "opened":
        this.#opened ??= entry;
        this.#leaf = entry.id;
        return;
      case "turn":
        this.#turns.set(entry.turn, entry);
        this.#tips.set(entry.turn, entry.id);
        if (entry.follows !== undefined) this.#left.delete(entry.follows);
        this.#leaf = entry.id;
        return;
      case "left": {
        this.#left.add(entry.turn);
        const at = this.#leaf === null ? undefined : this.#byId.get(this.#leaf);
        const begun = this.#turns.get(entry.turn);
        if (at !== undefined && at.type !== "opened" && at.turn === entry.turn && begun !== undefined) this.#leaf = this.#back(begun.parent);
        return;
      }
      default: {
        if (entry.turn !== undefined) this.#tips.set(entry.turn, entry.id);
        if (this.#leaf === entry.parent) this.#leaf = entry.id;
        return;
      }
    }
  }

  get(id: string): SessionEntry | undefined {
    return this.#byId.get(id);
  }

  /** The session's own position: where its path ends now. */
  get leaf(): string | null {
    return this.#leaf;
  }

  get opened(): OpenedEntry | undefined {
    return this.#opened;
  }

  /** A turn's first entry. */
  turn(turn: string): TurnEntry | undefined {
    return this.#turns.get(turn);
  }

  /** A turn's newest entry. */
  tip(turn: string): string | undefined {
    return this.#tips.get(turn);
  }

  /** Whether the host said a turn left the path, and no turn has followed it since. */
  left(turn: string): boolean {
    return this.#left.has(turn);
  }

  /**
   * Where a turn hangs that follows `follows`: the newest entry of that turn when it is one of this
   * session's; otherwise, for the first turn of a session and every swipe of it, where the session
   * began (the entry it was opened with, or nothing).
   */
  anchor(follows: string | undefined): string | null {
    const tip = follows === undefined ? undefined : this.#tips.get(follows);
    return tip ?? this.#opened?.id ?? null;
  }

  /** The entries from the first down to `to`, in that order. */
  path(to: string | null): SessionEntry[] {
    const out: SessionEntry[] = [];
    let at = to === null ? undefined : this.#byId.get(to);
    while (at !== undefined) {
      out.push(at);
      at = at.parent === null ? undefined : this.#byId.get(at.parent);
    }
    return out.reverse();
  }

  /** Where the leaf goes back to from a turn that left: the newest entry of the turn it hung from, or the entry itself outside any turn. */
  #back(parent: string | null): string | null {
    const entry = parent === null ? undefined : this.#byId.get(parent);
    if (entry === undefined) return null;
    const turn = entry.type === "opened" ? undefined : entry.turn;
    return turn === undefined ? entry.id : (this.#tips.get(turn) ?? entry.id);
  }
}
