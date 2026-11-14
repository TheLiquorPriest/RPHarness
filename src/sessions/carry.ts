// What the lead's context holds from its session's earlier turns (§11, §10.2 block 3), by the
// request's `carry`: what the lead did in each (continuing: its intent records, its calls and what
// came back), its own record of each (records: the file the carried part's header names, in that
// turn's folder), or only the summary the session opened with (nothing). The fields here are laid
// out by the carried part; every word the lead reads of them is the part's, its own, a tool's or
// the host's. The session file keeps no thinking, so none is ever carried.
import type { Carry, FilesPort, JsonObject, Log, Scope } from "../contract";
import type { Fields } from "../files/api";
import type { ResultEntry, SessionEntry, SessionLog, TurnEntry } from "./file";

/** One of the session's turns on a path, with its own entries on that path, in the order written. */
export interface PathTurn {
  entry: TurnEntry;
  /** Its place among the session's turns on the path, from 1. */
  n: number;
  entries: SessionEntry[];
}

/** The session's turns on the path that ends at `to`, oldest first: a turn that left the path is not among them, nor are its entries. */
export function pathTurns(log: SessionLog, to: string | null): PathTurn[] {
  const turns: PathTurn[] = [];
  const byTurn = new Map<string, PathTurn>();
  for (const entry of log.path(to)) {
    if (entry.type === "turn") {
      if (log.left(entry.turn)) continue;
      const turn = { entry, n: turns.length + 1, entries: [] };
      turns.push(turn);
      byTurn.set(entry.turn, turn);
    } else if (entry.type !== "opened" && entry.turn !== undefined) byTurn.get(entry.turn)?.entries.push(entry);
  }
  return turns;
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
}

/**
 * The carried part's fields for a turn, or undefined when the session carries nothing for it: no
 * summary, and no earlier turn with anything of the mode's to show. A turn the mode has nothing of
 * (no intent record or call; no record file) is left out, and the others keep their places.
 */
export async function carriedFields(input: CarriedInput): Promise<Fields | undefined> {
  const { carry, tree, from } = input;
  const summary = tree.path(from).findLast((entry) => entry.type === "opened")?.summary;
  const turns = carry === "continuing" ? continuing(pathTurns(tree, from)) : carry === "records" ? await records(input) : [];
  if ((summary === undefined || summary === "") && turns.length === 0) return undefined;
  return { ...(carry !== "nothing" ? { [carry]: true } : {}), ...(summary !== undefined && summary !== "" ? { summary } : {}), turns };
}

function continuing(turns: readonly PathTurn[]): JsonObject[] {
  return turns.flatMap((turn) => {
    const items = itemsOf(turn);
    return items.length > 0 ? [{ n: turn.n, items }] : [];
  });
}

/** Each earlier turn's record, read from its folder now: a turn whose file is not there, is empty, or cannot be read, carries nothing. */
async function records(input: CarriedInput): Promise<JsonObject[]> {
  const { files, scope, record, log } = input;
  if (record === undefined || record === "") return [];
  const read = await Promise.all(
    pathTurns(input.tree, input.from).map(async (turn): Promise<JsonObject[]> => {
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
