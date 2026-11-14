// The folder host's file port (§5, §5.1): reads and finds over the agents' view, and writes held to
// where each writer may write. An agent's write in a turn goes in the turn's journal, so the lead
// can drop that agent's writes (§13.4).

import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileHit, FileOp, FileQuery, FileRead, FilesPort, LayerLevel, Range, Refused, Scope, Unapplied, Writer, Written } from "../../contract/index";
import type { Serial } from "./disk";
import { codeOf, sha256, writeWhole } from "./disk";
import type { JournalLine } from "./shape";
import type { Site } from "./site";
import type { Located, TopView } from "./view";
import { folderLayers, folderPlaces, kindOf, locate, MOUNTS, refusalFor, topView, viewPath, writableFor } from "./view";

/** The most hits a find gives when its query names no limit. */
export const FIND_LIMIT = 200;
/** Files larger than this many bytes are passed over by grep. */
export const GREP_MAX_BYTES = 1024 * 1024;
/** A grep hit's line is cut to this many UTF-16 code units. */
export const GREP_LINE_MAX = 1000;

/** The journal of agents' writes in a turn. */
export function journalPath(site: Site, chat: string, turn: string): string {
  return join(site.turnRecords(chat, turn), "writes.jsonl");
}

/** The part of a text a range covers, as whole lines with their breaks, and the lines it covers. A final line break ends the last line and does not start another. */
export function cut(text: string, range: Range | undefined): { text: string; start: number; end: number; lines: number } {
  const starts: number[] = text.length === 0 ? [] : [0];
  for (let i = text.indexOf("\n"); i !== -1 && i + 1 < text.length; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lines = starts.length;
  const start = range?.start ?? 1;
  if (!Number.isInteger(start) || start < 1) throw new RangeError(`A range starts at line 1 or later, not ${start}.`);
  if (range?.end !== undefined && !Number.isInteger(range.end)) throw new RangeError(`A range ends at a whole line, not ${range.end}.`);
  const end = Math.min(range?.end ?? lines, lines);
  if (end < start) return { text: "", start, end: start - 1, lines };
  const from = starts[start - 1] ?? text.length;
  const to = end < lines ? (starts[end] ?? text.length) : text.length;
  return { text: text.slice(from, to), start, end, lines };
}

/** The order of the view's paths: a folder sorts as its name with "/" after it, so a walk in this order meets paths in the order of their whole text. */
function byPath(a: { name: string; folder: boolean }, b: { name: string; folder: boolean }): number {
  const ka = a.folder && !a.name.endsWith("/") ? `${a.name}/` : a.name;
  const kb = b.folder && !b.name.endsWith("/") ? `${b.name}/` : b.name;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

interface Walked {
  rest: string[];
  folder: boolean;
  disk: string;
}

/** Everything below a folder, `depth` folders deep, in the order of their paths: no links, nothing but files and folders, and at a level's top only what `top` says is part of the view. */
async function* walk(level: LayerLevel, rest: readonly string[], disk: string, depth: number, top: TopView): AsyncGenerator<Walked> {
  let found;
  try {
    found = await readdir(disk, { withFileTypes: true });
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  const entries: { name: string; folder: boolean }[] = [];
  for (const d of found) {
    if (d.isSymbolicLink() || !(d.isDirectory() || d.isFile())) continue;
    if (rest.length === 0 && !(await top(d.name))) continue;
    entries.push({ name: d.name, folder: d.isDirectory() });
  }
  entries.sort(byPath);
  for (const e of entries) {
    const below = [...rest, e.name];
    const at = join(disk, e.name);
    yield { rest: below, folder: e.folder, disk: at };
    if (e.folder && depth > 1) yield* walk(level, below, at, depth - 1, top);
  }
}

/** The files at or below a found path, in the order of their paths. */
async function* filesAt(at: Located, top: TopView): AsyncGenerator<Walked> {
  if (at.is === "file") {
    yield { rest: at.rest, folder: false, disk: at.disk };
    return;
  }
  for await (const e of walk(at.level, at.rest, at.disk, Number.POSITIVE_INFINITY, top)) if (!e.folder) yield e;
}

/** A file's path below the folder a find looked under; a file found itself is its own name. */
function below(at: Located, rest: readonly string[]): string {
  return at.is === "file" ? (rest.at(-1) ?? "") : rest.slice(at.rest.length).join("/");
}

async function fileHit(level: LayerLevel, rest: string[], disk: string): Promise<FileHit> {
  return { path: viewPath(level, rest), type: "file", level, kind: kindOf(level, rest), bytes: (await stat(disk)).size };
}

/** How often `old` appears in `text`, without overlaps. */
function occurrences(text: string, old: string): number {
  let n = 0;
  for (let i = text.indexOf(old); i !== -1; i = text.indexOf(old, i + old.length)) n++;
  return n;
}

/** Applies a change to a file the writer may write, and gives the result with the file's text before it (null: none). */
async function apply(at: Located, op: FileOp): Promise<{ result: Written | Unapplied; old: string | null }> {
  if (at.is === "folder") return { result: { status: "unapplied", path: at.path, reason: "folder" }, old: null };
  const old = at.is === "file" ? await readFile(at.disk, "utf8") : null;
  let after: string | null;
  switch (op.op) {
    case "write":
      after = op.text;
      break;
    case "append":
      after = (old ?? "") + op.text;
      break;
    case "edit": {
      if (old === null) return { result: { status: "unapplied", path: at.path, reason: "missing" }, old };
      const matches = op.old === "" ? 0 : occurrences(old, op.old);
      if (matches === 0) return { result: { status: "unapplied", path: at.path, reason: "no-match" }, old };
      if (matches > 1 && op.all !== true) return { result: { status: "unapplied", path: at.path, reason: "several", matches }, old };
      after = op.all === true ? old.split(op.old).join(op.new) : old.replace(op.old, () => op.new);
      break;
    }
    case "delete":
      if (old === null) return { result: { status: "unapplied", path: at.path, reason: "missing" }, old };
      after = null;
      break;
  }
  if (after === null) await rm(at.disk);
  else if (op.op === "append" && old !== null) await appendFile(at.disk, op.text, "utf8");
  else await writeWhole(at.disk, after);
  const result: Written = {
    status: "written",
    path: at.path,
    kind: at.kind,
    op: op.op,
    bytes: after === null ? 0 : Buffer.byteLength(after, "utf8"),
    hash: after === null ? null : sha256(after),
    before: old === null ? null : sha256(old),
  };
  return { result, old };
}

/** The file port. `serial` runs one change at a time per file, shared with whatever else changes the tree's files (dropping an agent's writes), so two changes to one file both land. */
export function folderFiles(site: Site, serial: Serial): FilesPort {
  function refusal(scope: Scope, path: string, reason: Refused["reason"], writer: Writer | undefined): Refused {
    const places = folderPlaces(scope);
    return { status: "refused", path, reason, writable: writer === undefined ? places.writable : writableFor(places, writer) };
  }

  async function find(scope: Scope, query: FileQuery): Promise<FileHit[] | Refused> {
    const loc = await site.location(scope);
    const lookup = await locate(loc, query.path ?? "");
    if (!lookup.ok) return refusal(scope, lookup.path, lookup.reason, undefined);
    const at = lookup.at;
    const limit = query.limit ?? FIND_LIMIT;
    const hits: FileHit[] = [];
    if (at.is === "none" || limit <= 0) return hits;
    const top = await topView(loc, at.level);

    if (query.by === "list") {
      if (at.is === "file") return [await fileHit(at.level, at.rest, at.disk)];
      for await (const e of walk(at.level, at.rest, at.disk, query.depth ?? 1, top)) {
        if (hits.length >= limit) break;
        hits.push(e.folder ? { path: viewPath(at.level, e.rest), type: "folder", level: at.level, kind: kindOf(at.level, e.rest) } : await fileHit(at.level, e.rest, e.disk));
      }
      // The root shows where the other levels are mounted; listing a mount shows what is in it.
      if (at.level === "chat" && at.rest.length === 0) {
        for (const level of ["shipped", "global", "character"] as const) hits.push({ path: MOUNTS[level], type: "folder", level, kind: "yours" });
        hits.sort((a, b) => byPath({ name: a.path, folder: a.type === "folder" }, { name: b.path, folder: b.type === "folder" }));
      }
      return hits.slice(0, limit);
    }

    if (query.by === "glob") {
      const glob = new Bun.Glob(query.pattern);
      for await (const f of filesAt(at, top)) {
        if (hits.length >= limit) break;
        if (glob.match(below(at, f.rest))) hits.push(await fileHit(at.level, f.rest, f.disk));
      }
      return hits;
    }

    const pattern = new RegExp(query.literal === true ? query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : query.pattern, query.ignoreCase === true ? "i" : "");
    const only = query.glob === undefined ? undefined : new Bun.Glob(query.glob);
    for await (const f of filesAt(at, top)) {
      if (hits.length >= limit) break;
      if (only !== undefined && !only.match(below(at, f.rest))) continue;
      const bytes = (await stat(f.disk)).size;
      if (bytes > GREP_MAX_BYTES) continue;
      const data = await readFile(f.disk);
      if (data.includes(0)) continue;
      const lines = data.toString("utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (const [i, line] of lines.entries()) {
        if (hits.length >= limit) break;
        if (pattern.test(line)) hits.push({ path: viewPath(at.level, f.rest), type: "file", level: at.level, kind: kindOf(at.level, f.rest), bytes, line: i + 1, text: line.slice(0, GREP_LINE_MAX) });
      }
    }
    return hits;
  }

  return {
    async layers(scope) {
      site.check(scope);
      return folderLayers();
    },

    async places(scope) {
      site.check(scope);
      return folderPlaces(scope);
    },

    async read(scope, path, range): Promise<FileRead> {
      const lookup = await locate(await site.location(scope), path);
      if (!lookup.ok) return refusal(scope, lookup.path, lookup.reason, undefined);
      const at = lookup.at;
      if (at.is === "none") return { status: "missing", path: at.path };
      if (at.is === "folder") return { status: "missing", path: at.path, folder: true };
      const [data, info] = await Promise.all([readFile(at.disk), stat(at.disk)]);
      const part = cut(data.toString("utf8"), range);
      return { status: "read", path: at.path, level: at.level, kind: at.kind, text: part.text, start: part.start, end: part.end, lines: part.lines, bytes: data.byteLength, hash: sha256(data), modified: info.mtimeMs };
    },

    find,

    async write(scope, path, op, by) {
      const loc = await site.location(scope);
      const lookup = await locate(loc, path);
      if (!lookup.ok) return refusal(scope, lookup.path, lookup.reason, by);
      const reason = refusalFor(lookup.at, writableFor(folderPlaces(scope), by));
      if (reason !== undefined) return refusal(scope, lookup.at.path, reason, by);
      return serial.run(lookup.at.disk, async () => {
        // Found again in this file's turn, so a write that waited sees what the one before it left.
        const again = await locate(loc, path);
        if (!again.ok) return refusal(scope, again.path, again.reason, by);
        const { result, old } = await apply(again.at, op);
        if (result.status === "written" && by !== "harness" && scope.turn !== undefined) {
          const line: JournalLine = { agent: by, path: result.path, before: old, after: result.hash };
          const journal = journalPath(site, scope.chat, scope.turn);
          await mkdir(dirname(journal), { recursive: true });
          await appendFile(journal, `${JSON.stringify(line)}\n`, "utf8");
        }
        return result;
      });
    },
  };
}
