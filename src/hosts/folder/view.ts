// The agents' view of the folder (§5): the chat's folder as the root, the global, character and
// shipped levels mounted read-only, the three kinds of file, and where each writer may write
// (§5.1). Every path is normalized here before anything acts on it; a path that leaves the view or
// passes through a link is refused.

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { FileKind, Layer, LayerLevel, Places, RefusalReason, Scope, Writer } from "../../contract/index";
import { codeOf } from "./disk";

/** Where each mounted level appears in the agents' view. A chat folder's own entry of one of these names is not reachable. */
export const MOUNTS = { shipped: "@shipped/", global: "@global/", character: "@character/" } as const;

/** The config file of the global level and of a chat's (§5.4 "Config"). */
export const CONFIG_FILE = "config.yml";
/** The chat's notes folder (§5 `persistent-workspace/`). */
export const NOTES_FOLDER = "persistent-workspace";
/** The chat's sessions folder (§5 `sessions/`). */
export const SESSIONS_FOLDER = "sessions";

/** The guidance folders of the global and shipped levels (§5). */
const GLOBAL_FOLDERS = { agents: ".agents", skills: ".skills", rules: ".rules", hooks: ".hooks", prompts: ".prompts", tools: ".tools" } as const;
/** The guidance folders of a character level (§5: `AGENTS.md, rules/, agents/, skills/`). Its other folders are chats, outside the view. */
const CHARACTER_FOLDERS = { agents: "agents", rules: "rules", skills: "skills" } as const;
/** The folder names of `CHARACTER_FOLDERS`, for a lookup by name. */
const CHARACTER_FOLDER_NAMES: Record<string, true> = { agents: true, rules: true, skills: true };
/** The guidance folders of a chat (§5). */
const CHAT_FOLDERS = { agents: "agents", rules: "rules", skills: "skills", hooks: "hooks" } as const;
/** The generated files at the top of a chat's folder (§5.1). */
const GENERATED_FILES: Record<string, true> = { "LORE-INDEX.md": true, "PROMPT-MAP.md": true };
/** The folders of a turn agents may write in (§5.1). */
const TURN_FOLDERS = ["queries", "scratch", "output", "cache"] as const;
/**
 * The global level's folders that are not part of it in the view: other chats, and the shipped
 * level, mounted on its own. They are hidden by what they are on disk, not by how a path spells
 * them: on a file system that ignores case, `CHATS` and `chatſ` are `chats`.
 */
const GLOBAL_HIDDEN = ["chats", "defaults"] as const;

/** The levels, farthest first, as every chat of the folder host has them. */
export function folderLayers(): Layer[] {
  return [
    { level: "shipped", mount: MOUNTS.shipped, folders: { ...GLOBAL_FOLDERS } },
    { level: "global", mount: MOUNTS.global, folders: { ...GLOBAL_FOLDERS }, config: CONFIG_FILE },
    { level: "character", mount: MOUNTS.character, folders: { ...CHARACTER_FOLDERS } },
    { level: "chat", mount: "", folders: { ...CHAT_FOLDERS }, config: CONFIG_FILE },
  ];
}

/** A scope's places. Its session's and turn's ids have been checked as safe for a path. */
export function folderPlaces(scope: Scope): Places {
  const notes = `${NOTES_FOLDER}/`;
  const session = `${SESSIONS_FOLDER}/${scope.session}/`;
  if (scope.turn === undefined) return { notes, session, writable: [notes] };
  const turn = `${session}turns/${scope.turn}/`;
  return { notes, session, turn, writable: [notes, ...TURN_FOLDERS.map((f) => `${turn}${f}/`)] };
}

/** Where a writer may write: its places, and for RPH itself the session's folder too (`Writer`). */
export function writableFor(places: Places, writer: Writer): string[] {
  return writer === "harness" ? [...places.writable, places.session] : places.writable;
}

/** Where a chat's levels are on disk: the tree's folder, the chat's character folder under `chats/`, and the chat's own folder in it. */
export interface ChatLocation {
  files: string;
  character: string;
  chat: string;
}

/** Where the levels in view are on disk: a chat's, or, for a scope that names only the user, the tree's folder alone, whose shipped and global levels every chat shares. */
export type TreeLocation = ChatLocation | { files: string };

/** A path in the view, found. */
export interface Located {
  /** The path as normalized, in the agents' view. */
  path: string;
  level: LayerLevel;
  /** Its segments below its level's folder. */
  rest: string[];
  /** Where it is on disk. */
  disk: string;
  kind: FileKind;
  /** What is there now. */
  is: "file" | "folder" | "none";
}

export type Lookup = { ok: true; at: Located } | { ok: false; path: string; reason: RefusalReason };

/** A file's kind by its level and its segments below the level's folder (§5.1). */
export function kindOf(level: LayerLevel, rest: readonly string[]): FileKind {
  if (level !== "chat") return "yours";
  if (rest[0] === NOTES_FOLDER) return "notes";
  if (rest[0] === SESSIONS_FOLDER) return "generated";
  if (rest.length === 1 && rest[0] !== undefined && GENERATED_FILES[rest[0]] === true) return "generated";
  return "yours";
}

/** The view path of a level's segments. */
export function viewPath(level: LayerLevel, rest: readonly string[]): string {
  return level === "chat" ? rest.join("/") : `${MOUNTS[level]}${rest.join("/")}`;
}

/** A folder's identity on disk (its device and inode), without following a link; undefined when nothing is there or it is no folder. */
async function folderIdentity(path: string): Promise<string | undefined> {
  let found;
  try {
    found = await lstat(path, { bigint: true });
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  return found.isDirectory() ? `${found.dev}:${found.ino}` : undefined;
}

/** Whether an entry right under a level's own folder, by its name as given, is part of the view. */
export type TopView = (name: string) => Promise<boolean>;

/**
 * What is part of the view right under a level's own folder. At the global level, everything but
 * the folders `GLOBAL_HIDDEN` names, matched by what they are on disk; at a character level, its
 * files and its guidance folders by their exact names, every other folder there being a chat;
 * everything at the others.
 */
export async function topView(loc: TreeLocation, level: LayerLevel): Promise<TopView> {
  const folder = levelFolder(loc, level);
  if (level === "global") {
    const hidden = new Set<string>();
    for (const name of GLOBAL_HIDDEN) {
      const at = await folderIdentity(join(loc.files, name));
      if (at !== undefined) hidden.add(at);
    }
    return async (name) => {
      const at = await folderIdentity(join(folder, name));
      return at === undefined || !hidden.has(at);
    };
  }
  if (level === "character") return async (name) => CHARACTER_FOLDER_NAMES[name] === true || (await folderIdentity(join(folder, name))) === undefined;
  return async () => true;
}

/** The segments from the tree's folder down to a level's own folder. A location with no chat has no character's or chat's level: `locate` refuses a path there before it asks. */
function levelBase(loc: TreeLocation, level: LayerLevel): string[] {
  if (level === "shipped") return ["defaults"];
  if (level === "global") return [];
  if (!("chat" in loc)) throw new Error(`A view with no chat in it has no ${level} level.`);
  return level === "chat" ? ["chats", loc.character, loc.chat] : ["chats", loc.character];
}

/** A level's folder on disk. */
export function levelFolder(loc: TreeLocation, level: LayerLevel): string {
  return join(loc.files, ...levelBase(loc, level));
}

/**
 * Finds a path of the view. Refused: `invalid` (empty of meaning, a NUL, a backslash), `outside`
 * (above the root, into a part of a mounted level that is not in the view, or, with no chat in view,
 * at a character's or a chat's level, the root among them), `link` (any part of it on disk is a link).
 */
export async function locate(loc: TreeLocation, path: string): Promise<Lookup> {
  if (path.includes("\0") || path.includes("\\")) return { ok: false, path, reason: "invalid" };
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.pop() === undefined) return { ok: false, path, reason: "outside" };
      continue;
    }
    segments.push(part);
  }
  const first = segments[0];
  const level: LayerLevel = first === "@global" ? "global" : first === "@character" ? "character" : first === "@shipped" ? "shipped" : "chat";
  const rest = level === "chat" ? segments : segments.slice(1);
  const normalized = viewPath(level, rest);
  if (!("chat" in loc) && (level === "chat" || level === "character")) return { ok: false, path: normalized, reason: "outside" };
  const top = rest[0];
  if (top !== undefined && !(await (await topView(loc, level))(top))) return { ok: false, path: normalized, reason: "outside" };

  // Links are not followed (§5.1): every part that exists, from the tree's folder down, is looked at itself.
  const parts = [...levelBase(loc, level), ...rest];
  let is: Located["is"] = "folder";
  for (let i = 1; i <= parts.length; i++) {
    let found;
    try {
      found = await lstat(join(loc.files, ...parts.slice(0, i)));
    } catch (error) {
      const code = codeOf(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        is = "none";
        break;
      }
      throw error;
    }
    if (found.isSymbolicLink()) return { ok: false, path: normalized, reason: "link" };
    if (!found.isDirectory()) {
      is = i === parts.length && found.isFile() ? "file" : "none";
      break;
    }
  }
  return { ok: true, at: { path: normalized, level, rest, disk: join(loc.files, ...parts), kind: kindOf(level, rest), is } };
}

/**
 * Why a writer may not write at a path, or undefined when it may: only inside one of its writable
 * folders (§5.1). A mounted level is no one's to write through the port; a generated file outside
 * the writer's folders is refused as generated; everything else outside them is the user's.
 */
export function refusalFor(at: Located, writable: readonly string[]): RefusalReason | undefined {
  if (at.level !== "chat") return "mounted";
  if (writable.some((w) => at.path.startsWith(w) && at.path.length > w.length)) return undefined;
  return at.kind === "generated" ? "generated" : "yours";
}
