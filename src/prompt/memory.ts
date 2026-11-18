// What a turn does with its prompt at its start (§4.8 "What code does every turn"), and what a
// chat's turns' prompts held, so that the next turn, or a swipe of one, is compared with the turn it
// follows, and a page or a job started from a turn reads it back. Each turn's prompt is kept in a file
// of RPH's own at the top of the turn's folder (`KEPT_FILE`), where the host placed the folder
// (`FilesPort.places`): it lasts as long as the host keeps that part of the turn's folder, and goes
// with the snapshots a host prunes from older turn folders (RPE by its `retention.turnFolders`). RPH
// keeps no count of turns, reads no retention setting and never makes a turn folder's path itself. The
// host's store keeps only the chat's list of kept turns, each with the session it played in and its
// folder, the newest last; a turn whose file is gone is let go of the list.
import type { AgentRef, Environment, FileMissing, FilesPort, FileText, JsonObject, JsonValue, LocatedSlices, PromptMap, PromptMessage, Scope, StorePort } from "../contract";
import { TurnPrompt } from "./prompt";
import { locatedOf, type PromptRecord, recordOf } from "./shape";
import { messageText, textHash } from "./text";

/** RPH's file at the top of a turn's folder that keeps the turn's prompt: each message's role, name and text, where its slices were found, and what it held. */
const KEPT_FILE = "kept-prompt.json";

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

/** What a turn's file keeps of its prompt: its messages as text, where its slices were found, and what it held for the comparison of the turn after. */
interface Held {
  messages: PromptMessage[];
  located: LocatedSlices;
  record: PromptRecord;
}

/** A turn's file read as what it keeps; undefined where it does not read as that. */
function heldOf(text: string): Held | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const { messages, record } = value as Record<string, unknown>;
    return Array.isArray(messages) && typeof record === "object" && record !== null ? (value as Held) : undefined;
  } catch {
    return undefined;
  }
}

/** What a chat's turns' prompts held, each kept in its turn's folder for as long as the host keeps it there. */
export class PromptMemory {
  readonly #store: StorePort;
  readonly #files: Pick<FilesPort, "places" | "read" | "write">;

  constructor(store: StorePort, files: Pick<FilesPort, "places" | "read" | "write">) {
    this.#store = store;
    this.#files = files;
  }

  /** A kept turn's file, looked at in the folder the host placed the turn in, in the session the turn played in; undefined where the host could not say. */
  async #file(scope: Scope, kept: KeptTurn): Promise<FileText | FileMissing | undefined> {
    const at: Scope = { user: scope.user, chat: scope.chat, session: kept.session, turn: kept.turn };
    const file = await this.#files.read(at, `${kept.folder}${KEPT_FILE}`).catch(() => undefined);
    return file?.status === "refused" ? undefined : file;
  }

  /** The kept turn `turn` (`undefined`: the chat's newest kept) and what its file keeps, while the host keeps the file. */
  async #found(scope: Scope, turn: string | undefined): Promise<{ kept: KeptTurn; held: Held } | undefined> {
    const all = keptOf(await this.#store.get(scope, keyOf(scope)));
    const kept = turn === undefined ? all.at(-1) : all.find((k) => k.turn === turn);
    const file = kept === undefined ? undefined : await this.#file(scope, kept);
    const held = file?.status === "read" ? heldOf(file.text) : undefined;
    return kept === undefined || held === undefined ? undefined : { kept, held };
  }

  /** What the turn `parent` held: the one a turn follows (`undefined`: the chat's newest kept turn; `null`: it follows none), while the host keeps its file. */
  async before(scope: Scope, parent: string | null | undefined): Promise<PromptRecord | undefined> {
    if (parent === null) return undefined;
    return (await this.#found(scope, parent))?.held.record;
  }

  /**
   * Keeps the turn `scope.turn`'s prompt (each message's role, name and text), where its slices were
   * found and what it held, in its file in the turn's folder, so the turn after is compared with it and
   * a page or a job started from the turn reads it back (`held`). The turn becomes the chat's newest
   * kept, named with its session and its folder as the host places it; a turn the host gives no folder
   * is not kept. The kept turns whose files the host no longer keeps are let go of the list.
   */
  async keep(scope: Scope, record: PromptRecord, messages: readonly PromptMessage[], located: LocatedSlices): Promise<void> {
    const turn = scope.turn;
    if (turn === undefined) return;
    const [folder, earlier] = await Promise.all([this.#files.places(scope).then((places) => places.turn), this.#store.get(scope, keyOf(scope)).then(keptOf)]);
    if (folder === undefined) return;
    const looked = await Promise.all(earlier.map(async (k) => (k.turn !== turn && (await this.#file(scope, k))?.status === "missing" ? [k.turn] : [])));
    const gone = new Set(looked.flat());
    const texts = messages.map((m) => ({ role: m.role, content: messageText(m), ...(m.name !== undefined ? { name: m.name } : {}) }));
    const written = await this.#files.write(scope, `${folder}${KEPT_FILE}`, { op: "write", text: JSON.stringify({ messages: texts, located, record }) }, "harness");
    if (written.status !== "written") throw new Error(`The host did not let RPH write ${folder}${KEPT_FILE} (${written.status}).`);
    await this.#store.update(scope, keyOf(scope), (current) => ({ turns: [...keptOf(current).filter((k) => k.turn !== turn && !gone.has(k.turn)), { turn, session: scope.session, folder }] }) as unknown as JsonValue);
  }

  /** A turn's prompt as kept (`turn` absent: the chat's newest kept turn), while the host keeps its file; undefined where none is. */
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
