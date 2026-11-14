// What the kit's cases share: the host under test, the seed it holds, the place it keeps its
// state, and a few measures the cases take (hashes, a picture of every file in the view).

import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Environment, FileHit, Layer, LayerLevel, Refused, Scope } from "../../contract/index";
import type { KitSeed } from "./seed";

/** A host made for the kit. */
export interface KitHost {
  env: Environment;
  /** Ends the host: everything it keeps is written, so a new host over the same place sees it. */
  close(): Promise<void>;
}

/**
 * Makes a host over `place`, an empty folder the kit made, holding `seed`. Everything the host
 * keeps for it lives under `place`. Called again with the same place, it opens what is there.
 */
export type KitFactory = (seed: KitSeed, place: string) => Promise<KitHost>;

/** What every case reads once the kit's host is made. */
export interface KitContext {
  seed: KitSeed;
  make: KitFactory;
  place: string;
  host: KitHost;
  env: Environment;
  scope: Scope & { turn: string };
}

/** SHA-256 of a text's UTF-8, lower-case hex. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The layout's hash of a text: the first 32 hex digits of its SHA-256. */
export function layoutHash(text: string): string {
  return sha256(text).slice(0, 32);
}

/** A level's mount, from the host's layers. */
export function mountOf(layers: readonly Layer[], level: LayerLevel): string {
  const layer = layers.find((l) => l.level === level);
  if (layer === undefined) throw new Error(`The host has no ${level} level.`);
  return layer.mount;
}

/** Whether `find` gave hits rather than a refusal. */
export function hitsOf(found: FileHit[] | Refused): FileHit[] {
  if (!Array.isArray(found)) throw new Error(`find was refused (${found.reason}) at ${found.path}.`);
  return found;
}

/** Every file in the view, at every level, with its hash: what a refused write must leave as it was. */
export async function viewPicture(env: Environment, scope: Scope): Promise<Record<string, string>> {
  const picture: Record<string, string> = {};
  for (const layer of await env.files.layers(scope)) {
    for (const hit of hitsOf(await env.files.find(scope, { by: "glob", pattern: "**/*", path: layer.mount, limit: 10_000 }))) {
      if (hit.type !== "file") continue;
      const read = await env.files.read(scope, hit.path);
      picture[hit.path] = read.status === "read" ? read.hash : read.status;
    }
  }
  return picture;
}

/** Every path under a folder whose last part is `name`, at any depth, links passed over. */
export async function pathsNamed(folder: string, name: string): Promise<string[]> {
  let found;
  try {
    found = await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of found) {
    const at = join(folder, d.name);
    if (d.name === name) out.push(at);
    if (d.isDirectory() && !d.isSymbolicLink()) out.push(...(await pathsNamed(at, name)));
  }
  return out;
}

/**
 * Where a file named `name` landed that a host should never have written: anywhere under `place`,
 * where the host keeps everything, or right beside `place` or any folder above it, where a path
 * that climbed out of the view would put it.
 */
export async function landed(place: string, name: string): Promise<string[]> {
  const out = await pathsNamed(place, name);
  for (let folder = dirname(place); ; folder = dirname(folder)) {
    const at = join(folder, name);
    if (await access(at).then(() => true, () => false)) out.push(at);
    if (dirname(folder) === folder) break;
  }
  return out;
}
