// The levels of the tree as the host gives them (`FilesPort`): which files of each kind each level
// holds, their texts, and what the levels' config files switch off, add, add to stacks and pin. The
// names of the levels, their folders and their config files are the host's; nothing here names one.

import type { FileText, FilesPort, FindStopped, GuidanceKind, Layer, LayerLevel, Scope, UserScope } from "../contract/index";
import type { Problem } from "./api";
import { CONFIG_KEYS } from "./api";
import type { At } from "./header";
import { fieldLine, isMapping, nameList, normalized, parseYaml, problemAt, WrittenItems } from "./header";

/** What a listing looks for: instruction files at each level's root, or the files of one kind of guidance (`examples`: the rules under `<rules>/examples/`; `manifests`: the owner's tools' manifests, `<tools>/<name>.json`). */
export type Listing = "instructions" | "agents" | "rules" | "examples" | "skills" | "prompts" | "tools" | "manifests";

/** A file found at one level, by the name it goes by. */
export interface FileRef {
  name: string;
  path: string;
  level: LayerLevel;
}

/** One level's `instructions:` list, or one agent's list in a level's mapping, and where it is written. */
export interface InstructionsList {
  /** The agent it is for; absent: every agent whose definition reads at least one instruction file. */
  agent?: string;
  /** As written: instruction files by name (`STYLE`), or paths or globs in the agents' view (`house/*.md`). */
  entries: string[];
  /** The line each entry is written on, by its place in `entries`; undefined where its text was not found as written (the list's line stands for it). */
  lines: (number | undefined)[];
  /** The config file it is in, and the line of the list: the agent's, in a mapping, else the key's. */
  at: At;
  line?: number;
}

/** A file pinned for an agent (`pins:`, R-174), and where the pin is written. */
export interface Pin {
  /** Its path in the chat's view (`persistent-workspace/plan.md`, `@global/persistent-workspace/x.md`). */
  file: string;
  /** The definition it is pinned for. */
  agent: string;
  /** The config file it is in, and the line the pin is written on (the key's, where its text was not found). */
  at: At;
  line?: number;
}

/** What the levels' config files say, farthest first, nearest last. */
export interface Config {
  /** Names switched off, as `itemKey` gives them. */
  off: Set<string>;
  /** Instruction files read at every level that has one, farther first, as any level's config names them. */
  layered: Set<string>;
  /** For each situation, the instruction files the nearest config that names it adds to the briefing. */
  added: Map<string, string[]>;
  /** What each level's `instructions:` adds to stacks, the farthest level's first. */
  instructions: InstructionsList[];
  /** Every level's pins, the farthest level's first, each in its list's order. */
  pins: Pin[];
}

/** A listing's files: the owner's, which are guidance, and those that are not (agents' notes, generated files), each by name, each name's files farthest first. */
interface Listed {
  yours: Map<string, FileRef[]>;
  others: Map<string, FileRef[]>;
}

const KINDS: readonly GuidanceKind[] = ["agents", "skills", "rules", "hooks", "prompts", "tools"];

/** The levels' order, farthest first. */
export const LEVEL_ORDER: readonly LayerLevel[] = ["shipped", "global", "character", "chat"];

/** The name `off:` lists and stack entries know an item by: an instruction file's own name, anything else's kind and name (`rules/consent`); a tool's manifest goes by its tool's (`tools/<name>`). */
export function itemKey(kind: Listing, name: string): string {
  if (kind === "instructions") return name;
  return `${kind === "examples" ? "rules/examples" : kind === "manifests" ? "tools" : kind}/${name}`;
}

/** The kind a folder's name is, at any level, or the kind's own word. */
function kindOfFolder(name: string, layers: readonly Layer[]): GuidanceKind | undefined {
  const word = KINDS.find((k) => k === name);
  if (word !== undefined) return word;
  for (const layer of layers) {
    for (const kind of KINDS) if (layer.folders[kind]?.replace(/\/+$/, "") === name) return kind;
  }
  return undefined;
}

/** An item as `itemKey` names it, from an `off:` entry or a `needs:` name however the Files page or the user wrote it: with a mount, a level's own folder name, `.md` or `/SKILL.md`. */
export function writtenKey(entry: string, layers: readonly Layer[]): string {
  let s = entry.trim().replace(/^(?:\.\/|\/)+/, "");
  const mounted = layers.find((l) => l.mount !== "" && s.startsWith(l.mount));
  if (mounted !== undefined) s = s.slice(mounted.mount.length);
  if (s.endsWith("/SKILL.md")) s = s.slice(0, -"/SKILL.md".length);
  else if (s.endsWith(".md")) s = s.slice(0, -".md".length);
  const slash = s.indexOf("/");
  if (slash > 0) {
    const kind = kindOfFolder(s.slice(0, slash), layers);
    if (kind !== undefined) return `${kind}/${s.slice(slash + 1)}`;
  }
  return s;
}

/** Where a listing looks at one level, as a path in the agents' view; undefined when the level holds no such folder. */
function base(layer: Layer, listing: Listing): string | undefined {
  if (listing === "instructions") return layer.mount;
  const folder = layer.folders[listing === "examples" ? "rules" : listing === "manifests" ? "tools" : listing]?.replace(/\/+$/, "");
  if (folder === undefined) return undefined;
  return `${layer.mount}${folder}${listing === "examples" ? "/examples" : ""}`;
}

/** A file's name, from its path below the listing's folder; undefined when it is not one of the listing's files. */
function nameOf(listing: Listing, rest: string): string | undefined {
  const m = (listing === "skills" ? /^([^/]+)\/SKILL\.md$/ : listing === "manifests" ? /^([^/]+)\.json$/ : /^([^/]+)\.md$/).exec(rest);
  return m?.[1];
}

/** The texts of a config item's values, in the order they are written: what finds the item's line. */
function scalars(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalars);
  return isMapping(value) ? Object.values(value).flatMap(scalars) : [];
}

/** Why a host stopped a listing or a search before its end, in a problem's words. */
export function stoppedWhy(stopped: FindStopped): string {
  const why = [...(stopped.limit !== undefined ? [`at its cap of ${stopped.limit.max} files`] : []), ...(stopped.time !== undefined ? [`when its ${stopped.time.ms} ms ran out`] : [])];
  return why.length === 0 ? "before its end" : why.join(" and ");
}

export class Tree {
  readonly files: FilesPort;
  readonly scope: Scope | UserScope;
  /** What went wrong reading: a refusal, or a port that failed. */
  readonly problems: Problem[] = [];
  #layers: Promise<Layer[]> | undefined;
  readonly #listed = new Map<Listing, Promise<Listed>>();
  readonly #reads = new Map<string, Promise<FileText | undefined>>();
  #config: Promise<Config> | undefined;

  constructor(files: FilesPort, scope: Scope | UserScope) {
    this.files = files;
    this.scope = scope;
  }

  layers(): Promise<Layer[]> {
    this.#layers ??= this.files.layers(this.scope);
    return this.#layers;
  }

  /** The files of a listing, by name, each name's files farthest first. */
  async found(listing: Listing): Promise<Map<string, FileRef[]>> {
    return (await this.#listing(listing)).yours;
  }

  /** The files a listing finds that are not the owner's (agents' notes, generated files), by name: never guidance, though a name the user wrote may find only them. */
  async notYours(listing: Listing): Promise<Map<string, FileRef[]>> {
    return (await this.#listing(listing)).others;
  }

  #listing(listing: Listing): Promise<Listed> {
    let listed = this.#listed.get(listing);
    if (listed === undefined) {
      listed = this.#list(listing);
      this.#listed.set(listing, listed);
    }
    return listed;
  }

  async #list(listing: Listing): Promise<Listed> {
    const layers = await this.layers();
    const perLevel = await Promise.all(
      layers.map(async (layer): Promise<{ ref: FileRef; yours: boolean }[]> => {
        const path = base(layer, listing);
        if (path === undefined) return [];
        let found;
        try {
          // Every file in the folder (§5.2 "everything loaded", R-183): a find that names no limit stops
          // at the host's own cap, which is for an agent's search, not for loading the owner's guidance.
          found = await this.files.find(this.scope, { by: "list", path, depth: listing === "skills" ? 2 : 1, limit: Number.POSITIVE_INFINITY });
        } catch (error) {
          this.problems.push({ path, level: layer.level, message: `The folder could not be listed: ${error instanceof Error ? error.message : String(error)}` });
          return [];
        }
        if (found.status === "refused") {
          this.problems.push({ path, level: layer.level, message: `The host refused to list this folder (${found.reason}).` });
          return [];
        }
        // Every file is loaded (R-183): a listing the host cut is said, never taken as the whole.
        if (found.stopped !== undefined) this.problems.push({ path, level: layer.level, message: `The host stopped listing this folder ${stoppedWhy(found.stopped)}, so the files past where it stopped are not loaded.` });
        const prefix = path === "" || path.endsWith("/") ? path : `${path}/`;
        return found.hits.flatMap((hit) => {
          if (hit.type !== "file" || !hit.path.startsWith(prefix)) return [];
          const name = nameOf(listing, hit.path.slice(prefix.length));
          return name === undefined ? [] : [{ ref: { name, path: hit.path, level: layer.level }, yours: hit.kind === "yours" }];
        });
      }),
    );
    const listed: Listed = { yours: new Map(), others: new Map() };
    for (const refs of perLevel) {
      for (const { ref, yours } of refs) {
        const byName = yours ? listed.yours : listed.others;
        byName.set(ref.name, [...(byName.get(ref.name) ?? []), ref]);
      }
    }
    return listed;
  }

  /** A file's text; undefined when it is gone, or could not be read (a problem says why). */
  read(path: string): Promise<FileText | undefined> {
    let read = this.#reads.get(path);
    if (read === undefined) {
      read = this.#read(path);
      this.#reads.set(path, read);
    }
    return read;
  }

  async #read(path: string): Promise<FileText | undefined> {
    try {
      const read = await this.files.read(this.scope, path);
      if (read.status === "read") return read;
      if (read.status === "refused") this.problems.push({ path, message: `The host refused to read this file (${read.reason}).` });
      return undefined;
    } catch (error) {
      this.problems.push({ path, message: `The file could not be read: ${error instanceof Error ? error.message : String(error)}` });
      return undefined;
    }
  }

  /** What the levels' config files switch off, add, add to stacks and pin. */
  config(): Promise<Config> {
    this.#config ??= this.#readConfig();
    return this.#config;
  }

  async #readConfig(): Promise<Config> {
    const layers = await this.layers();
    const config: Config = { off: new Set(), layered: new Set(), added: new Map(), instructions: [], pins: [] };
    const files = await Promise.all(layers.map((layer) => (layer.config === undefined ? undefined : this.read(`${layer.mount}${layer.config}`))));
    for (const file of files) {
      if (file === undefined) continue;
      const at = { path: file.path, level: file.level };
      const lines = normalized(file.text).split("\n");
      const parsed = parseYaml(lines, 1, at, "the config");
      if ("problem" in parsed) {
        this.problems.push(parsed.problem);
        continue;
      }
      if (parsed.value === null || parsed.value === undefined) continue;
      if (!isMapping(parsed.value)) {
        this.problems.push(problemAt(at, 1, "The config must be `name: value` lines, one setting to a line."));
        continue;
      }
      const off = parsed.value[CONFIG_KEYS.off];
      const offNames = nameList(off);
      if (offNames === undefined) this.problems.push(problemAt(at, fieldLine(lines, CONFIG_KEYS.off, 1), "`off:` is a list of the files switched off: `off: [rules/perceptions-owed, WORLD]`."));
      else for (const name of offNames) config.off.add(writtenKey(name, layers));

      const layered = nameList(parsed.value[CONFIG_KEYS.layered]);
      if (layered === undefined) this.problems.push(problemAt(at, fieldLine(lines, CONFIG_KEYS.layered, 1), "`layered:` is a list of instruction files read at every level that has one, farther first: `layered: [AGENTS]`."));
      else for (const name of layered) config.layered.add(writtenKey(name, layers));

      const instructions = parsed.value[CONFIG_KEYS.instructions];
      if (instructions !== undefined && instructions !== null) {
        const written = new WrittenItems(lines, CONFIG_KEYS.instructions, 1);
        const line = written.field;
        const listOf = (entries: string[], listLine: number | undefined, agent?: string): InstructionsList => ({ ...(agent !== undefined ? { agent } : {}), entries, lines: entries.map((entry) => written.find(entry)), at, ...(listLine !== undefined ? { line: listLine } : {}) });
        if (isMapping(instructions)) {
          for (const [agent, value] of Object.entries(instructions)) {
            const agentLine = written.find(agent, true) ?? line;
            const entries = nameList(value);
            if (entries === undefined) this.problems.push(problemAt(at, agentLine, `\`instructions:\` gives \`${agent}\` something other than a list of files: \`${agent}: [STYLE, house/canon.md]\`.`));
            else config.instructions.push(listOf(entries, agentLine, agent));
          }
        } else {
          const entries = nameList(instructions);
          if (entries === undefined) this.problems.push(problemAt(at, line, "`instructions:` is a list of files added to the stack of every agent that reads instruction files, `instructions: [STYLE, house/canon.md]`, or such a list for each agent by name: `instructions: { gm: [house/rules.md] }`."));
          else config.instructions.push(listOf(entries, line));
        }
      }

      const pins = parsed.value[CONFIG_KEYS.pins];
      if (pins !== undefined && pins !== null) {
        const written = new WrittenItems(lines, CONFIG_KEYS.pins, 1);
        const line = written.field;
        if (!Array.isArray(pins)) this.problems.push(problemAt(at, line, "`pins:` is a list of files, each pinned for an agent: `pins: [{ file: persistent-workspace/plan.md, agent: keeper }]`."));
        else {
          for (const [i, pin] of pins.entries()) {
            // A pin is written where the first of its values is; the search goes on past them all.
            let pinLine: number | undefined;
            for (const text of scalars(pin)) {
              const found = written.find(text);
              pinLine ??= found;
            }
            pinLine ??= line;
            const file = isMapping(pin) && typeof pin.file === "string" ? pin.file.trim() : "";
            const agent = isMapping(pin) && typeof pin.agent === "string" ? pin.agent.trim() : "";
            if (file === "" || agent === "") this.problems.push(problemAt(at, pinLine, `Pin ${i + 1} of \`pins:\` needs a \`file\` and an \`agent\`, as in \`{ file: persistent-workspace/plan.md, agent: keeper }\`, so it is left out.`));
            else config.pins.push({ file, agent, at, ...(pinLine !== undefined ? { line: pinLine } : {}) });
          }
        }
      }

      const added = parsed.value[CONFIG_KEYS.added];
      if (added === undefined || added === null) continue;
      const line = fieldLine(lines, CONFIG_KEYS.added, 1);
      if (!isMapping(added)) {
        this.problems.push(problemAt(at, line, "`added:` names, for each kind of turn, the instruction files added to its briefing: `swipe: [SWIPE]`."));
        continue;
      }
      for (const [situation, value] of Object.entries(added)) {
        const names = nameList(value);
        if (names === undefined) this.problems.push(problemAt(at, line, `\`added:\` gives \`${situation}\` something other than the names of instruction files: \`${situation}: [SWIPE]\`.`));
        else config.added.set(situation, names.map((n) => n.replace(/\.md$/, "")));
      }
    }
    return config;
  }
}
