// What the lead's context holds from its session's earlier turns (§11, §10.2 block 3), by the
// request's `carry`: what the lead did in each (continuing: its intent records, its calls and what
// came back), its own record of each (records: the file the carried part's header names, in that
// turn's folder), or only the summary the session opened with (nothing). Where the session was
// compacted, the newest summary on the path stands for the turns before the first it kept, and only
// the turns from there are carried. The fields here are laid out by the carried part; every word the
// lead reads of them is the part's, its own, a tool's, a summary's or the host's. The session file
// keeps no thinking, so none is ever carried.
import type { Carry, FilesPort, JsonObject, Log, Scope } from "../contract";
import type { Fields } from "../files/api";
import { isMapping } from "../files/header";
import { tokensOf } from "../model/tokens";
import type { CompactedEntry, ResultEntry, SessionEntry, SessionLog, TurnEntry } from "./file";

/** One of the session's turns on a path, with its own entries on that path, in the order written. */
export interface PathTurn {
  entry: TurnEntry;
  /** Its place among the session's turns on the path, from 1. */
  n: number;
  entries: SessionEntry[];
}

/** The session's turns on a path, oldest first: a turn that left the path is not among them, nor are its entries. */
function turnsOn(log: SessionLog, path: readonly SessionEntry[]): PathTurn[] {
  const turns: PathTurn[] = [];
  const byTurn = new Map<string, PathTurn>();
  for (const entry of path) {
    if (entry.type === "turn") {
      if (log.left(entry.turn)) continue;
      const turn = { entry, n: turns.length + 1, entries: [] };
      turns.push(turn);
      byTurn.set(entry.turn, turn);
    } else if (entry.type !== "opened" && entry.turn !== undefined) byTurn.get(entry.turn)?.entries.push(entry);
  }
  return turns;
}

/** The session's turns on the path that ends at `to`, oldest first: a turn that left the path is not among them, nor are its entries. */
export function pathTurns(log: SessionLog, to: string | null): PathTurn[] {
  return turnsOn(log, log.path(to));
}

/** The newest summary on a path. */
function newestSummary(path: readonly SessionEntry[]): CompactedEntry | undefined {
  return path.findLast((entry): entry is CompactedEntry => entry.type === "compacted");
}

/** The turns a summary leaves as they were: those on the path from the first it kept. With no summary, every one. */
function unsummarized(turns: readonly PathTurn[], path: readonly SessionEntry[], compacted: CompactedEntry | undefined): PathTurn[] {
  if (compacted === undefined) return [...turns];
  const start = path.findIndex((entry) => entry.id === compacted.kept);
  // The turn it kept first is not on this path: the turn the summary was written for, before its own entry.
  if (start < 0) return [];
  const after = new Set(path.slice(start).map((entry) => entry.id));
  return turns.filter((turn) => after.has(turn.entry.id));
}

/** A turn's intent records and calls, in order, each call with what came back on the path. */
function itemsOf(turn: PathTurn): JsonObject[] {
  const results = new Map<string, ResultEntry>();
  for (const entry of turn.entries) if (entry.type === "result") results.set(entry.callId, entry);
  return turn.entries.flatMap((entry): JsonObject[] => {
    if (entry.type === "intent") return [{ intent: entry.text }];
    if (entry.type !== "call") return [];
    const call: JsonObject = { tool: entry.tool, args: JSON.stringify(entry.args) };
    const result = results.get(entry.callId);
    if (result !== undefined) call["result"] = result.text.trimEnd();
    if (result?.error === true) call["error"] = true;
    if (result?.reports !== undefined) call["reports"] = result.reports;
    return [{ call }];
  });
}

export interface CarriedInput {
  carry: Carry;
  tree: SessionLog;
  /** The entry the turn being answered hangs from: its path is what the session carries. */
  from: string | null;
  /** The session the turn is played in. */
  scope: Scope;
  files: FilesPort;
  log: Log;
  /** The carried part's `record`: the file, in a turn's folder, that holds the lead's record of that turn. */
  record?: string;
  /** A summary written for the turn being answered, which stands in place of the newest on the path it carries from. */
  compacted?: CompactedEntry;
}

/** The carried part's fields: the mode, the summary the turns follow, and the turns. Undefined when there is neither summary nor turn. */
function fieldsOf(carry: Carry, summary: string | undefined, turns: readonly JsonObject[]): Fields | undefined {
  if ((summary === undefined || summary === "") && turns.length === 0) return undefined;
  return { ...(carry !== "nothing" ? { [carry]: true } : {}), ...(summary !== undefined && summary !== "" ? { summary } : {}), turns: [...turns] };
}

/**
 * The carried part's fields for a turn, or undefined when the session carries nothing for it: no
 * summary, and no earlier turn with anything of the mode's to show. A turn the mode has nothing of
 * (no intent record or call; no record file) is left out, and the others keep their places. The
 * mode "nothing" carries only the summary the session opened with, never a compaction's.
 */
export async function carriedFields(input: CarriedInput): Promise<Fields | undefined> {
  const { carry, tree, from } = input;
  const path = tree.path(from);
  const opened = path.findLast((entry) => entry.type === "opened")?.summary;
  if (carry === "nothing") return fieldsOf(carry, opened, []);
  const compacted = input.compacted ?? newestSummary(path);
  const turns = unsummarized(turnsOn(tree, path), path, compacted);
  return fieldsOf(carry, compacted?.summary ?? opened, carry === "continuing" ? continuing(turns) : await records(input, turns));
}

/** What the records a block of the records mode carries weigh, by the model layer's estimate: each record's text, and not the summary they follow. */
export function recordsTokens(fields: Fields | undefined, charsPerToken: number): number {
  const turns = fields?.["records"] === true ? fields["turns"] : undefined;
  if (!Array.isArray(turns)) return 0;
  let tokens = 0;
  for (const turn of turns) if (isMapping(turn) && typeof turn["text"] === "string") tokens += tokensOf(turn["text"], charsPerToken);
  return tokens;
}

/** What a compaction at a place on the path would summarize (§11). */
export interface Compaction {
  /** The turns the summary is to stand for, oldest first. */
  turns: PathTurn[];
  /** The turn entry of the first turn it keeps as it was; absent when it keeps none and is written for no turn. */
  kept?: string;
  /** How many of the earlier turns it keeps as they were. */
  keptTurns: number;
}

/**
 * What a compaction where a turn's work starts (`from`) would summarize: the turns carried there
 * but the newest `keep` of them, and never the turn being answered (`current`). Undefined when that
 * leaves none.
 */
export function compactionAt(log: SessionLog, from: string | null, current: TurnEntry | undefined, keep: number): Compaction | undefined {
  const path = log.path(from);
  const earlier = unsummarized(turnsOn(log, path), path, newestSummary(path)).filter((turn) => turn.entry.turn !== current?.turn);
  const cut = Math.max(0, earlier.length - keep);
  if (cut === 0) return undefined;
  const kept = earlier[cut]?.entry.id ?? current?.id;
  return { turns: earlier.slice(0, cut), keptTurns: earlier.length - cut, ...(kept !== undefined ? { kept } : {}) };
}

/** The carried part's fields for what a compaction summarizes: the summary it starts from, and the turns it is to stand for, as the mode carries them. */
export async function compactionFields(input: CarriedInput, turns: readonly PathTurn[]): Promise<Fields | undefined> {
  const path = input.tree.path(input.from);
  const summary = newestSummary(path)?.summary ?? path.findLast((entry) => entry.type === "opened")?.summary;
  return fieldsOf(input.carry, summary, input.carry === "continuing" ? continuing(turns) : input.carry === "records" ? await records(input, turns) : []);
}

function continuing(turns: readonly PathTurn[]): JsonObject[] {
  return turns.flatMap((turn) => {
    const items = itemsOf(turn);
    return items.length > 0 ? [{ n: turn.n, items }] : [];
  });
}

/** Each turn's record, read from its folder now: a turn whose file is not there, is empty, or cannot be read, carries nothing. */
async function records(input: CarriedInput, turns: readonly PathTurn[]): Promise<JsonObject[]> {
  const { files, scope, record, log } = input;
  if (record === undefined || record === "") return [];
  const read = await Promise.all(
    turns.map(async (turn): Promise<JsonObject[]> => {
      try {
        // A turn a branch took over is read where it was played.
        const where = { user: scope.user, chat: turn.entry.played?.chat ?? scope.chat, session: turn.entry.played?.session ?? scope.session, turn: turn.entry.turn };
        const places = await files.places(where);
        if (places.turn === undefined) return [];
        const file = await files.read(where, `${places.turn}${record}`);
        return file.status === "read" && file.text.trim() !== "" ? [{ n: turn.n, text: file.text.trimEnd() }] : [];
      } catch (error) {
        log.warn("A turn's record could not be read; that turn carries nothing.", { turn: turn.entry.turn, record, error: error instanceof Error ? error.message : String(error) });
        return [];
      }
    }),
  );
  return read.flat();
}
