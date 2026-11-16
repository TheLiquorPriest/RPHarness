// The session file (§11): one line per entry, a tree by parent, in the shape pi's coding agent keeps
// its sessions in. The first line says what the file is; every other line is an entry with its own
// id and the id of the entry it follows. Nothing in it is ever changed or deleted: a swipe is a
// branch from the entry before the turn it replaces, and a turn that left the path is marked so,
// its entries kept where they are.
//
// Which entries are on the path is worked out from the file alone, by reading it in order, so a
// harness that starts again finds the session as it stood.
import type { JsonObject, JsonValue, TurnKind, Usage } from "../contract";
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

/**
 * The host closed the session (§11), as the work of `turn` where it named one: closing belongs to that
 * turn. `by`: the owner's own close (S-3), hung after the chat's newest turn, which his `reopen` takes
 * back.
 */
export interface ClosedEntry extends EntryBase {
  type: "closed";
  turn?: string;
  by?: "user";
}

/**
 * The owner took back his own close (S-4): the closing `closing` no longer stands, wherever it is on
 * a path. A mark of his word: it belongs to no turn, and is never the leaf.
 */
export interface ReopenedEntry extends EntryBase {
  type: "reopened";
  closing: string;
  turn?: undefined;
}

/** The host said a turn is off the path (swiped away, deleted). A mark: no entry follows it. */
export interface LeftEntry extends EntryBase {
  type: "left";
  turn: string;
}

/**
 * The host said an earlier attempt is shown again (a swipe flipped back, on an earlier reply too):
 * it is on the path again, in the place of the other attempts at its place, which are off it, and
 * what followed them follows it. A mark: no entry follows it.
 */
export interface ShownEntry extends EntryBase {
  type: "shown";
  turn: string;
}

/**
 * The session's earlier turns were summarized (§11), as the work of `turn`: the summary stands for
 * every turn on the path before `kept`, the turn entry of the first turn kept as it was. The turns it
 * stands for stay in the file, and a path that does not pass through it has them all. With `of:
 * "run"`, the summary is of the turn's own older calls, made mid-run when a call would not fit: it
 * stands for those entries of the turn, which the file keeps, and what a later turn carries is not
 * changed by it (`kept` is the turn's own first entry).
 */
export interface CompactedEntry extends EntryBase {
  type: "compacted";
  turn: string;
  summary: string;
  kept: string;
  of?: "run";
}

/** The host asked for a compaction (§11): the session's next turn compacts at its start. A mark that holds until a compaction is written after it. */
export interface CompactEntry extends EntryBase {
  type: "compact";
  /** It belongs to no turn: the host's word, like a closing that names none. */
  turn?: undefined;
}

/**
 * The owner pressed "Apply now" (R-119): every lead's opening block written before it no longer
 * stands, so the first run of each lead that starts after it makes its block afresh from the files as
 * they stand, and writes it. A mark of the host's word: it belongs to no turn, and is never the leaf.
 */
export interface AppliedEntry extends EntryBase {
  type: "applied";
  turn?: undefined;
}

/**
 * A lead's opening block (§10.2 block 1), as it was made: at the session's first turn for that lead,
 * or afresh by "Apply now". The newest for a lead, in the order of the file, is the one its turns go
 * on with, wherever the turn that made it stands. Kept as plain JSON, so what the block comes to hold
 * is carried here unchanged. A mark: it belongs to no turn, is never the leaf, and no entry follows it.
 */
export interface OpeningEntry extends EntryBase {
  type: "opening";
  lead: string;
  opening: JsonObject;
  turn?: undefined;
}

/**
 * What a turn's runs have spent so far (N-22), written as each run of it ends: the calls and tokens
 * of every agent of its runs, their answers that called tools (`rounds`, absent in a mark written
 * before they were counted), and their wall time in milliseconds, added up. The newest for a turn,
 * in the order of the file, is the turn's: a later run of it (a continue, a run that settles) goes on
 * counting from it, over a restart too. A mark: it is never the leaf, and no entry follows it.
 */
export interface SpentEntry extends EntryBase {
  type: "spent";
  turn: string;
  usage: Usage;
  rounds?: number;
  ms: number;
}

export type SessionEntry = OpeningEntry | OpenedEntry | TurnEntry | IntentEntry | MessageEntry | CallEntry | ResultEntry | ClosedEntry | ReopenedEntry | LeftEntry | ShownEntry | CompactedEntry | CompactEntry | AppliedEntry | SpentEntry;

/** One line of the file, as written. */
export function lineOf(item: SessionHeader | SessionEntry): string {
  return `${JSON.stringify(item)}\n`;
}

/** The counts a kept `Usage` holds, each a number. */
const USAGE_FIELDS = ["calls", "input", "output", "cacheRead", "cacheWrite"] as const;

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
      return optional(v["turn"], str) && optional(v["by"], (by) => by === "user");
    case "reopened":
      return v["turn"] === undefined && str(v["closing"]);
    case "left":
      return str(v["turn"]);
    case "shown":
      return str(v["turn"]);
    case "compacted":
      return str(v["turn"]) && str(v["summary"]) && str(v["kept"]) && optional(v["of"], (of) => of === "run");
    case "compact":
    case "applied":
      return v["turn"] === undefined;
    case "opening":
      return v["turn"] === undefined && str(v["lead"]) && isMapping(v["opening"]);
    case "spent": {
      const usage = v["usage"];
      return str(v["turn"]) && isMapping(usage) && USAGE_FIELDS.every((field) => typeof usage[field] === "number") && (v["rounds"] === undefined || typeof v["rounds"] === "number") && typeof v["ms"] === "number";
    }
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
 *   is in that turn, the leaf goes back to where the turn began;
 * - an earlier attempt the host said is shown again is on the path in the place of the other
 *   attempts at its place, which are off it: what followed them follows it (`parentOf`), and a leaf
 *   in one of them goes to it;
 * - a compaction the host asked for is waiting from its mark until a compaction is written after it,
 *   in the order of the file, wherever either stands; the mark is never the leaf, so a turn at work
 *   when it was given goes on where the session stands;
 * - a lead's opening block stands from its mark until a newer one for that lead is written, or the
 *   owner's "Apply now" mark, in the order of the file, wherever either stands; neither mark is ever
 *   the leaf;
 * - what a turn's runs spent stands from its mark until a newer one for that turn is written; the
 *   mark is never the leaf, nor its turn's tip;
 * - the owner's undo of his close takes that closing back wherever it stands; the mark is never the
 *   leaf.
 *
 * Each entry keeps its place in the file, so what the host said can be told apart from what was
 * written before it (a summary written before a turn it stands for left the path).
 */
export class SessionLog {
  readonly entries: SessionEntry[] = [];
  readonly #byId = new Map<string, SessionEntry>();
  readonly #turns = new Map<string, TurnEntry>();
  /** Each turn's newest entry: where a turn that follows it hangs. */
  readonly #tips = new Map<string, string>();
  /** The turns off the path now, each with the host's word that put it off. */
  readonly #left = new Map<string, LeftEntry | ShownEntry>();
  /** The attempts an earlier one was shown again in place of, each with the attempt shown. */
  readonly #replaced = new Map<string, string>();
  /** Each entry's place in the file, from 0. */
  readonly #places = new Map<string, number>();
  #leaf: string | null = null;
  /** The entry the host opened the session with. */
  #opened: OpenedEntry | undefined;
  /** The host's mark asking for a compaction, while no compaction has been written after it. */
  #asked: CompactEntry | undefined;
  /** Each lead's newest opening block, in the order of the file. */
  readonly #openings = new Map<string, OpeningEntry>();
  /** What each turn's runs spent, the newest mark of each, in the order of the file. */
  readonly #spent = new Map<string, SpentEntry>();
  /** The owner's undo of each closing he took back, by the closing. */
  readonly #reopened = new Map<string, ReopenedEntry>();

  constructor(entries: readonly SessionEntry[] = []) {
    for (const entry of entries) this.add(entry);
  }

  add(entry: SessionEntry): void {
    if (this.#byId.has(entry.id)) return;
    this.#places.set(entry.id, this.entries.length);
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
        if (entry.follows !== undefined) {
          this.#left.delete(entry.follows);
          this.#replaced.delete(entry.follows);
        }
        this.#leaf = entry.id;
        return;
      case "left": {
        // Its first word holds while it is off the path: saying it again changes nothing.
        if (!this.#left.has(entry.turn)) this.#left.set(entry.turn, entry);
        const at = this.#leaf === null ? undefined : this.#byId.get(this.#leaf);
        const begun = this.#turns.get(entry.turn);
        if (at !== undefined && at.type !== "opened" && at.turn === entry.turn && begun !== undefined) this.#leaf = this.#back(begun.parent);
        return;
      }
      case "shown": {
        const shown = this.#turns.get(entry.turn);
        if (shown === undefined) return;
        this.#left.delete(entry.turn);
        this.#replaced.delete(entry.turn);
        const place = this.#placeOf(shown);
        const at = this.#leaf === null ? undefined : this.#byId.get(this.#leaf);
        for (const other of this.#turns.values()) {
          if (other.turn === entry.turn || this.#placeOf(other) !== place) continue;
          if (!this.#left.has(other.turn)) this.#left.set(other.turn, entry);
          this.#replaced.set(other.turn, entry.turn);
          if (at !== undefined && at.type !== "opened" && at.turn === other.turn) this.#leaf = this.#tips.get(entry.turn) ?? shown.id;
        }
        return;
      }
      case "compact":
        this.#asked = entry;
        return;
      case "opening":
        this.#openings.set(entry.lead, entry);
        return;
      case "applied":
        this.#openings.clear();
        return;
      case "spent":
        this.#spent.set(entry.turn, entry);
        return;
      case "reopened":
        if (!this.#reopened.has(entry.closing)) this.#reopened.set(entry.closing, entry);
        return;
      default: {
        if (entry.type === "compacted" && entry.of === undefined) this.#asked = undefined;
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

  /** The host's mark asking for a compaction, while none has been written since. */
  get asked(): CompactEntry | undefined {
    return this.#asked;
  }

  /** A lead's newest opening block, in the order of the file: the one its turns go on with. */
  opening(lead: string): OpeningEntry | undefined {
    return this.#openings.get(lead);
  }

  /** Each lead's newest opening block, in the order they were written. */
  openings(): OpeningEntry[] {
    return [...this.#openings.values()].sort((a, b) => this.place(a.id) - this.place(b.id));
  }

  /** What a turn's runs have spent so far: its newest mark, in the order of the file. */
  spent(turn: string): SpentEntry | undefined {
    return this.#spent.get(turn);
  }

  /** The owner's undo that took back the closing `id`, if he took it back. */
  reopened(id: string): ReopenedEntry | undefined {
    return this.#reopened.get(id);
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

  /** The host's word that put a turn off the path, while it is off it. */
  leftBy(turn: string): LeftEntry | ShownEntry | undefined {
    return this.#left.get(turn);
  }

  /** Whether a turn is off the path by the host's word given after the entry `id` was written. */
  leftAfter(turn: string, id: string): boolean {
    const mark = this.#left.get(turn);
    return mark !== undefined && this.place(mark.id) > this.place(id);
  }

  /** An entry's place in the file, from 0; -1 for one the file does not hold. */
  place(id: string): number {
    return this.#places.get(id) ?? -1;
  }

  /**
   * Where a turn hangs that follows `follows`, as the request names it (`TurnRequest.parent`): left
   * out, the session's latest turn, where its path ends now; a turn of this session, that turn's
   * newest entry; `null`, or a turn that is not this session's, where the session began (the entry
   * it was opened with, or nothing).
   */
  anchor(follows: string | null | undefined): string | null {
    if (follows === undefined) return this.#leaf;
    const tip = follows === null ? undefined : this.#tips.get(follows);
    return tip ?? this.#opened?.id ?? null;
  }

  /**
   * The entries from the first down to `to`, in that order. What followed an attempt another was
   * shown again in place of follows the attempt shown (`parentOf`); `raw`, each entry's own parent
   * alone, as the file was written.
   */
  path(to: string | null, raw = false): SessionEntry[] {
    const out: SessionEntry[] = [];
    let at = to === null ? undefined : this.#byId.get(to);
    while (at !== undefined) {
      out.push(at);
      const parent = raw ? at.parent : this.parentOf(at);
      at = parent === null ? undefined : this.#byId.get(parent);
    }
    return out.reverse();
  }

  /** The entry an entry follows on a path: its own parent, but where that is an attempt an earlier one was shown again in place of, and the entry is not that attempt's own, the newest entry of the attempt shown. */
  parentOf(entry: SessionEntry): string | null {
    if (entry.parent === null || this.#replaced.size === 0) return entry.parent;
    const parent = this.#byId.get(entry.parent);
    const turn = parent === undefined || parent.type === "opened" ? undefined : parent.turn;
    if (turn === undefined || (entry.type !== "opened" && entry.turn === turn)) return entry.parent;
    const shown = this.#replaced.get(turn);
    return shown === undefined ? entry.parent : (this.#tips.get(shown) ?? entry.parent);
  }

  /** The entry that stands on a path in place of `id`: the first entry of the attempt shown again in place of the turn `id` begins, or `id` itself. */
  inPlaceOf(id: string): string {
    const entry = this.#byId.get(id);
    const shown = entry?.type === "turn" ? this.#replaced.get(entry.turn) : undefined;
    return shown === undefined ? id : (this.#turns.get(shown)?.id ?? id);
  }

  /** Where a turn began, by the turn it followed (the attempts at one place begin after the same turn, wherever that turn had got to), or the entry it hangs from outside any turn. */
  #placeOf(begun: TurnEntry): string | null {
    const parent = begun.parent === null ? undefined : this.#byId.get(begun.parent);
    if (parent === undefined) return begun.parent;
    return parent.type === "opened" || parent.turn === undefined ? `entry ${parent.id}` : `turn ${parent.turn}`;
  }

  /** Where the leaf goes back to from a turn that left: the newest entry of the turn it hung from, or the entry itself outside any turn. */
  #back(parent: string | null): string | null {
    const entry = parent === null ? undefined : this.#byId.get(parent);
    if (entry === undefined) return null;
    const turn = entry.type === "opened" ? undefined : entry.turn;
    return turn === undefined ? entry.id : (this.#tips.get(turn) ?? entry.id);
  }
}
