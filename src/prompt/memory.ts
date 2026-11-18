// What a turn does with its prompt at its start (§4.8 "What code does every turn"), and what a
// chat's turns' prompts held, kept through the host's store under the chat's scope so that the next
// turn, or a swipe of one, is compared with the turn it follows, and a page or a job started from a
// turn reads it back. RPH keeps no count of turns and reads no retention setting: what it kept of a
// turn's prompt is read only while the host still keeps the turn's folder, and is let go once that
// folder is gone, whatever the host prunes its folders by. RPH never makes a turn folder's path
// itself: when it keeps a turn it asks the host for the turn's place (`FilesPort.places`), in the
// session the turn played in, and it looks there.
import type { AgentRef, Environment, FilesPort, JsonObject, JsonValue, LocatedSlices, PromptMap, PromptMessage, Scope, StorePort } from "../contract";
import { TurnPrompt } from "./prompt";
import { locatedOf, type PromptRecord, recordOf } from "./shape";
import { messageText, textHash } from "./text";

/** The store key of a chat's kept turns. */
function keyOf(scope: Scope): string {
  return `prompt/turns/${textHash(`${scope.user}\n${scope.chat}`)}`;
}

/** A turn whose prompt is kept: its id, the session it played in, and its folder as the host placed it. */
interface KeptTurn {
  turn: string;
  session: string;
  folder: string;
}

/** The chat's kept turns, the newest last; an entry that does not name all three is passed over. */
function keptOf(value: JsonValue | undefined): KeptTurn[] {
  const turns = typeof value === "object" && value !== null && !Array.isArray(value) ? value["turns"] : undefined;
  if (!Array.isArray(turns)) return [];
  return turns.flatMap((k) => {
    if (typeof k !== "object" || k === null || Array.isArray(k)) return [];
    const { turn, session, folder } = k;
    return typeof turn === "string" && typeof session === "string" && typeof folder === "string" ? [{ turn, session, folder }] : [];
  });
}

/** What is kept of one turn's prompt: its messages as text, where its slices were found, and what it held for the comparison of the turn after. */
interface Held {
  messages: PromptMessage[];
  located: LocatedSlices;
  record: PromptRecord;
}

function heldOf(value: JsonValue | undefined): Held | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Array.isArray(value["messages"]) && typeof value["record"] === "object" && value["record"] !== null ? (value as unknown as Held) : undefined;
}

/** What a chat's turns' prompts held, kept through the host's store for as long as the host keeps each turn's folder. */
export class PromptMemory {
  readonly #store: StorePort;
  readonly #files: Pick<FilesPort, "places" | "read">;

  constructor(store: StorePort, files: Pick<FilesPort, "places" | "read">) {
    this.#store = store;
    this.#files = files;
  }

  /** Whether the host still keeps a kept turn's folder, looked at where the host placed it, in the session the turn played in; undefined where the host could not say, so nothing is let go on it. */
  async #folderKept(scope: Scope, kept: KeptTurn): Promise<boolean | undefined> {
    const at: Scope = { user: scope.user, chat: scope.chat, session: kept.session, turn: kept.turn };
    const looked = await this.#files.read(at, kept.folder).catch(() => undefined);
    if (looked === undefined || looked.status === "refused") return undefined;
    return looked.status === "missing" && looked.folder === true;
  }

  /** The kept turn `turn` (`undefined`: the chat's newest kept) and what is kept of its prompt, while the host keeps its folder. */
  async #found(scope: Scope, turn: string | undefined): Promise<{ kept: KeptTurn; held: Held } | undefined> {
    const all = keptOf(await this.#store.get(scope, keyOf(scope)));
    const kept = turn === undefined ? all.at(-1) : all.find((k) => k.turn === turn);
    if (kept === undefined || (await this.#folderKept(scope, kept)) !== true) return undefined;
    const held = heldOf(await this.#store.get(scope, heldKey(scope, kept.turn)));
    return held === undefined ? undefined : { kept, held };
  }

  /** What the turn `parent` held: the one a turn follows (`undefined`: the chat's newest kept turn; `null`: it follows none), while the host keeps its folder. */
  async before(scope: Scope, parent: string | null | undefined): Promise<PromptRecord | undefined> {
    if (parent === null) return undefined;
    return (await this.#found(scope, parent))?.held.record;
  }

  /**
   * Keeps the turn `scope.turn`'s prompt (each message's role, name and text), where its slices were
   * found and what it held, so the turn after is compared with it and a page or a job started from
   * the turn reads it back (`held`). The turn becomes the chat's newest kept, named with its session
   * and its folder as the host places it; a turn the host gives no folder is not kept, as it could
   * never be looked for. The kept turns whose folders the host no longer keeps are let go.
   */
  async keep(scope: Scope, record: PromptRecord, messages: readonly PromptMessage[], located: LocatedSlices): Promise<void> {
    const turn = scope.turn;
    if (turn === undefined) return;
    const [folder, earlier] = await Promise.all([this.#files.places(scope).then((places) => places.turn), this.#store.get(scope, keyOf(scope)).then(keptOf)]);
    if (folder === undefined) return;
    const looked = await Promise.all(earlier.map(async (k) => (k.turn !== turn && (await this.#folderKept(scope, k)) === false ? [k.turn] : [])));
    const gone = new Set(looked.flat());
    const texts = messages.map((m) => ({ role: m.role, content: messageText(m), ...(m.name !== undefined ? { name: m.name } : {}) }));
    await this.#store.set(scope, heldKey(scope, turn), { messages: texts, located, record } as unknown as JsonValue);
    await this.#store.update(scope, keyOf(scope), (current) => ({ turns: [...keptOf(current).filter((k) => k.turn !== turn && !gone.has(k.turn)), { turn, session: scope.session, folder }] }) as unknown as JsonValue);
    await Promise.all([...gone].map((old) => this.#store.delete(scope, heldKey(scope, old))));
  }

  /** A turn's prompt as kept (`turn` absent: the chat's newest kept turn), while the host keeps the turn's folder; undefined where none is. */
  async held(scope: Scope, turn?: string): Promise<HeldPrompt | undefined> {
    const found = await this.#found(scope, turn);
    if (found === undefined) return undefined;
    return { turn: found.kept.turn, session: found.kept.session, messages: found.held.messages, located: found.held.located };
  }
}

/** A turn's prompt as kept: the turn, the session it played in, its messages as text, and where its slices were found then. */
export interface HeldPrompt {
  turn: string;
  session: string;
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
