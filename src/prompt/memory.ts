// What a turn does with its prompt at its start (§4.8 "What code does every turn"), and what a
// chat's turns' prompts held, kept through the host's store under the chat's scope so that the next
// turn, or a swipe of one, is compared with the turn it follows. RPH keeps no count of turns and
// reads no retention setting: a turn before is compared only while the host still keeps its turn
// folder, and what RPH kept of a turn's prompt is let go once its folder is gone, whatever the host
// prunes its folders by (RPE by its own `retention.turnFolders`).
import type { AgentRef, Environment, FilesPort, JsonObject, JsonValue, LocatedSlices, PromptMap, PromptMessage, Scope, StorePort } from "../contract";
import { TurnPrompt } from "./prompt";
import { locatedOf, type PromptRecord, recordOf } from "./shape";
import { messageText, textHash } from "./text";

/** The store key of a chat's kept prompts. */
function keyOf(scope: Scope): string {
  return `prompt/turns/${textHash(`${scope.user}\n${scope.chat}`)}`;
}

type Kept = { turn: string; record: PromptRecord }[];

function keptOf(value: JsonValue | undefined): Kept {
  const turns = typeof value === "object" && value !== null && !Array.isArray(value) ? value["turns"] : undefined;
  return Array.isArray(turns) ? (turns as unknown as Kept) : [];
}

/** The folder every session's folder is in (§5 `sessions/`), in the agents' view. */
async function sessionsFolder(files: Pick<FilesPort, "places">, scope: Scope): Promise<string> {
  return (await files.places(scope)).session.replace(/[^/]+\/$/, "");
}

/** What a chat's turns' prompts held, kept through the host's store for as long as the host keeps each turn's folder. */
export class PromptMemory {
  readonly #store: StorePort;
  readonly #files: Pick<FilesPort, "places" | "find">;

  constructor(store: StorePort, files: Pick<FilesPort, "places" | "find">) {
    this.#store = store;
    this.#files = files;
  }

  /** Whether the host still keeps the folder of `turn` (§5.3: `sessions/<session>/turns/<turn>/`). */
  async #folderKept(scope: Scope, turn: string): Promise<boolean> {
    const found = await this.#files.find(scope, { by: "glob", pattern: `*/turns/${turn}/**`, path: await sessionsFolder(this.#files, scope), limit: 1 });
    return found.status === "found" && found.hits.length > 0;
  }

  /** The turns whose folders the host keeps, by id; undefined where the listing stopped short, so nothing is let go on it. */
  async #turnsKept(scope: Scope): Promise<Set<string> | undefined> {
    const folder = await sessionsFolder(this.#files, scope);
    const found = await this.#files.find(scope, { by: "list", path: folder, depth: 3, limit: Number.POSITIVE_INFINITY });
    if (found.status !== "found" || found.stopped !== undefined) return undefined;
    const turns = new Set<string>();
    for (const hit of found.hits) {
      const turn = hit.type === "folder" && hit.path.startsWith(folder) ? /^[^/]+\/turns\/([^/]+)\/?$/.exec(hit.path.slice(folder.length))?.[1] : undefined;
      if (turn !== undefined) turns.add(turn);
    }
    return turns;
  }

  /** What the turn `parent` held: the one a turn follows (`undefined`: the chat's newest kept turn; `null`: it follows none), while the host keeps its folder. */
  async before(scope: Scope, parent: string | null | undefined): Promise<PromptRecord | undefined> {
    if (parent === null) return undefined;
    const kept = keptOf(await this.#store.get(scope, keyOf(scope)));
    const found = parent === undefined ? kept.at(-1) : kept.find((k) => k.turn === parent);
    if (found === undefined || !(await this.#folderKept(scope, found.turn))) return undefined;
    return found.record;
  }

  /**
   * Keeps what the turn `scope.turn` held, as the chat's newest, and the turn's prompt itself (each
   * message's role, name and text) with where its slices were found, so a page or a job started from
   * the turn reads it back (`held`); those whose turn folders the host no longer keeps are let go.
   */
  async keep(scope: Scope, record: PromptRecord, messages: readonly PromptMessage[], located: LocatedSlices): Promise<void> {
    const turn = scope.turn;
    if (turn === undefined) return;
    const folders = await this.#turnsKept(scope);
    const gone: string[] = [];
    await this.#store.update(scope, keyOf(scope), (current) => {
      const kept = keptOf(current).filter((k) => {
        const stays = k.turn !== turn && (folders === undefined || folders.has(k.turn));
        if (!stays && k.turn !== turn) gone.push(k.turn);
        return stays;
      });
      kept.push({ turn, record });
      return { turns: kept } as unknown as JsonValue;
    });
    const texts = messages.map((m) => ({ role: m.role, content: messageText(m), ...(m.name !== undefined ? { name: m.name } : {}) }));
    await this.#store.set(scope, heldKey(scope, turn), { messages: texts, located } as unknown as JsonValue);
    await Promise.all(gone.map((old) => this.#store.delete(scope, heldKey(scope, old))));
  }

  /** A turn's prompt as kept (`turn` absent: the chat's newest kept turn), while the host keeps the turn's folder; undefined where none is. */
  async held(scope: Scope, turn?: string): Promise<HeldPrompt | undefined> {
    const kept = keptOf(await this.#store.get(scope, keyOf(scope)));
    const at = turn ?? kept.at(-1)?.turn;
    if (at === undefined || !(await this.#folderKept(scope, at))) return undefined;
    const value = await this.#store.get(scope, heldKey(scope, at));
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Array.isArray(value["messages"])) return undefined;
    return { turn: at, messages: value["messages"] as unknown as PromptMessage[], located: value["located"] as unknown as LocatedSlices };
  }
}

/** A turn's prompt as kept: the turn, its messages as text, and where its slices were found then. */
export interface HeldPrompt {
  turn: string;
  messages: PromptMessage[];
  located: LocatedSlices;
}

/** The store key of one turn's prompt. */
function heldKey(scope: Scope, turn: string): string {
  return `${keyOf(scope)}/${textHash(turn)}`;
}

/** What a turn starts with for its prompt. */
export interface PromptTurnInput {
  env: Pick<Environment, "prompt" | "lore" | "log" | "store" | "files">;
  scope: Scope;
  /** The prompt as the request carries it. */
  messages: readonly PromptMessage[];
  /** The turn this one follows (`TurnRequest.parent`). */
  parent: string | null | undefined;
  /** The agent the turn is run for: a map the breakdown corrected is saved under its name. */
  by: AgentRef;
  /** The scene's copy of the map in the session's cache (§11, HT-23); absent: the host's map alone is used. */
  sceneMap?: SceneMap;
}

/** The scene's copy of the prompt map, as the session's cache keeps it on the turn's path (§11, R-111). */
export interface SceneMap {
  /** The scene's copy of the map, as the session's cache holds it on this turn's path. */
  standing(): Promise<{ text: string; meta?: JsonObject } | undefined>;
  /** Keeps a map as the scene's copy from this turn on (the same text and meta again writes nothing). */
  keep(text: string, meta?: JsonObject): Promise<void>;
}

/** A map as the scene's copy holds it, where it reads as one. */
function mapOf(text: string | undefined): PromptMap | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && "slices" in value && "preset" in value ? (value as PromptMap) : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a map as the scene's copy, with its preset and revision beside it. */
export function keepSceneMap(scene: SceneMap, map: PromptMap): Promise<void> {
  return scene.keep(JSON.stringify(map), { preset: map.preset.id, ...(map.preset.revision !== undefined ? { revision: map.preset.revision } : {}) });
}

/**
 * The map a scene finds its slices by: the host's as the turn starts, kept as the scene's copy
 * where the copy is none, another, or of another preset or revision; where the host has none, the
 * scene's copy for the preset the prompt is from.
 */
async function sceneMapped(prompt: TurnPrompt, scene: SceneMap): Promise<void> {
  const standing = mapOf((await scene.standing())?.text);
  const host = prompt.facts.map;
  if (host !== undefined) {
    if (standing === undefined || JSON.stringify(standing) !== JSON.stringify(host)) await keepSceneMap(scene, host);
    return;
  }
  const now = prompt.preset;
  if (standing !== undefined && now !== null && standing.preset.id === now.id && standing.preset.revision === now.revision) prompt.remap(standing);
}

/**
 * The turn's prompt, its slices found and compared with the turn it follows: the host is given
 * where each slice is, the notices and the front (`saveLocated`), a map whose finders the breakdown
 * corrected is saved again (`saveMap`), and what it held is kept for the next turn. What the host
 * cannot give or take is logged, and the turn goes on.
 */
export async function promptTurn(input: PromptTurnInput): Promise<{ prompt: TurnPrompt; located: LocatedSlices }> {
  const { env, scope } = input;
  const told = (what: string) => (error: unknown) => {
    env.log.warn(what, { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  };
  const memory = new PromptMemory(env.store, env.files);
  const [prompt, before] = await Promise.all([TurnPrompt.read({ env, scope, messages: input.messages }), memory.before(scope, input.parent).catch(told("What the turn before held of its prompt could not be read."))]);
  if (input.sceneMap !== undefined) await sceneMapped(prompt, input.sceneMap).catch(told("The scene's copy of the prompt map could not be read or kept."));
  prompt.compareWith(before);
  const located = locatedOf(prompt, before);
  const corrected = prompt.corrected();
  await Promise.all([
    env.prompt.saveLocated(scope, located).catch(told("The host could not keep where the prompt's slices were found.")),
    memory.keep(scope, recordOf(prompt), input.messages, located).catch(told("What this turn's prompt held could not be kept.")),
    corrected === undefined ? undefined : env.prompt.saveMap(scope, corrected, input.by).catch(told("The host could not keep the prompt map as the breakdown corrected it.")),
  ]);
  return { prompt, located };
}
