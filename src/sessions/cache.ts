// The session's cache (§11, §5's `sessions/<session-id>/cache/`, R-111): what stays valid across a
// scene's turns, kept at hand so it is not rebuilt or read again each turn. RPH keeps the scratch
// files a session carries (`sessions.carried`: the scene sheet), the lore entries an agent read in
// full, and the scene's prompt map; the host keeps its own files beside them (RPE: each on-stage
// character's base view, the map's drawn layer). Agents read the folder and write nothing there
// (§5.1). Each version RPH keeps is a file of its own, named by what it is and its text's hash, and
// an entry of the session file names it as the work of the turn that kept it: the newest of each on a
// path is what stands there, so a swipe or a delete finds the cache as it stood at that turn's start.
// A branch copies the folder as it stood, the host's files with RPH's.
import { createHash } from "node:crypto";
import type { FilesPort, JsonObject, Log, Places, Scope } from "../contract";
import type { SessionFile } from "./book";
import type { CachedEntry, SessionLog } from "./file";

/** The cache's folder in a session's (§5). */
export const CACHE = "cache/";

/** The key a lore entry read in full is kept under. */
export function loreKey(id: string): string {
  return `lore/${id}`;
}

/** The key the scene's prompt map is kept under. */
export const PROMPT_MAP_KEY = "prompt-map";

/** What stands in the cache on the path that ends at `to`: the newest entry of each key, a turn off the path's left out. */
export function standing(log: SessionLog, to: string | null): Map<string, CachedEntry> {
  const out = new Map<string, CachedEntry>();
  for (const entry of log.path(to)) if (entry.type === "cached" && !log.left(entry.turn)) out.set(entry.key, entry);
  return out;
}

/** A version's file name: what it is, then its text's hash, keeping the key's own ending (`scratch-scene-<hash>.md`). */
function nameOf(key: string, text: string): string {
  const base = key.replaceAll("/", "-");
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}-${hash}${base.slice(dot)}` : `${base}-${hash}.md`;
}

export interface CacheDeps {
  files: FilesPort;
  /** The session's scope. */
  scope: Scope;
  places: Places;
  log: Log;
}

/**
 * Keeps `text` under `key` as the work of `turn`, unless the same text stands there already: its
 * file in the cache folder, written as the writer "harness", and the entry that names it. The entry
 * that stands for the key, as it now does.
 */
export async function keepCached(file: SessionFile, d: CacheDeps, turn: string, key: string, text: string, meta?: JsonObject): Promise<CachedEntry | undefined> {
  const name = nameOf(key, text);
  const now = standing(file.log, file.log.tip(turn) ?? file.log.leaf).get(key);
  if (now?.file === name && JSON.stringify(now.meta ?? {}) === JSON.stringify(meta ?? {})) return now;
  const written = await d.files.write(d.scope, `${d.places.session}${CACHE}${name}`, { op: "write", text }, "harness");
  if (written.status !== "written") {
    d.log.warn("What the session's cache keeps could not be written; the scene goes on without it.", { session: d.scope.session, key, status: written.status });
    return undefined;
  }
  return file.add({ type: "cached", parent: file.log.tip(turn) ?? file.log.leaf, turn, key, file: name, ...(meta !== undefined ? { meta } : {}) });
}

/** The text a cache entry names, as its file holds it; undefined where it cannot be read. */
export async function readCached(d: CacheDeps, entry: CachedEntry): Promise<string | undefined> {
  const read = await d.files.read(d.scope, `${d.places.session}${CACHE}${entry.file}`);
  if (read.status === "read") return read.text;
  d.log.warn("A file the session's cache names could not be read; it is passed over.", { session: d.scope.session, key: entry.key, file: entry.file, status: read.status });
  return undefined;
}

/** Every file of the cache folder that RPH did not keep: the host's own, by its path. */
export async function hostCached(d: CacheDeps, log: SessionLog): Promise<string[]> {
  const folder = `${d.places.session}${CACHE}`;
  const found = await d.files.find(d.scope, { by: "glob", pattern: "**/*", path: folder, limit: Number.MAX_SAFE_INTEGER });
  if (found.status === "refused") return [];
  const own = new Set(log.entries.flatMap((entry) => (entry.type === "cached" ? [`${folder}${entry.file}`] : [])));
  return found.hits.flatMap((hit) => (hit.type === "file" && !own.has(hit.path) ? [hit.path] : []));
}

/** Copies a session's cache folder into a branch's, the host's files with RPH's, each as it stands (§10.10). */
export async function copyCache(files: FilesPort, from: { scope: Scope; places: Places }, to: { scope: Scope; places: Places }, log: Log): Promise<void> {
  const folder = `${from.places.session}${CACHE}`;
  const found = await files.find(from.scope, { by: "glob", pattern: "**/*", path: folder, limit: Number.MAX_SAFE_INTEGER });
  if (found.status === "refused") return;
  for (const hit of found.hits) {
    if (hit.type !== "file") continue;
    const read = await files.read(from.scope, hit.path);
    if (read.status !== "read") continue;
    const written = await files.write(to.scope, `${to.places.session}${CACHE}${hit.path.slice(folder.length)}`, { op: "write", text: read.text }, "harness");
    if (written.status !== "written") log.warn("A file of the session's cache could not be copied to its branch.", { from: from.scope.session, to: to.scope.session, path: hit.path, status: written.status });
  }
}
