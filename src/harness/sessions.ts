// What the harness keeps of a session between its turns (§5.2, §10.2): each lead's opening block,
// fixed when the session opened, with the tools it held and the snapshot of its stack that later
// briefings are compared with; and what the user's rules remember, as each turn left it, so that a
// swipe starts from its parent's and not from the attempt it replaces (§6.3, §10.10). Both outlive
// the process: the opening block is kept in the session file, where a turn that finds none in memory
// (after a restart, or its session open again after a close) takes it back; the rules' memory is
// kept through the host's store by user, chat and turn, so the rules go on from the turn a turn
// follows, in its session or the scene before's. Memory holds them while the harness runs and the
// session is open, and the rules' memory only for the turns a later turn can still follow.
import type { JsonObject, JsonSchema, JsonValue, Log, Scope, StorePort } from "../contract";
import type { RuleMemory, StackSnapshot } from "../files/api";
import { isMapping } from "../files/header";
import { textHash } from "../prompt/text";
import type { ReplyTags } from "../reply/tags";
import type { SessionLog } from "../sessions/file";
import type { ReplyFormSetting } from "./settings";

/** A lead's opening block (§10.2 block 1), as the session opened it. Plain JSON, kept whole in the session file. */
export interface Opening {
  /** Its text: the definition, the instruction stack, the reply contract, the tool guide and the list of skills. */
  text: string;
  /** What the stack held, for the briefing's "files changed since this session opened". */
  snapshot: StackSnapshot;
  /** The list of skills it holds, as the skills part laid it out (§5.4); absent when it holds none. The briefing says when the list as it stands is another. */
  skills?: string;
  /** The tools its definition listed, and what it was given: the front of the cached prompt, fixed for the session (§6.8). */
  tools: string[];
  given: string[];
  /** The families of tools its definition kept out of a search's reach, which hold for the session as its tools do (§6.8). */
  outOfReach: string[];
  /**
   * Each tool it held when the session opened, by name, as it was declared then: a change to a
   * tool's file waits for the next session, as the definition's own list does (§5.2, §6.8).
   */
  declared: Record<string, { description: string; parameters: JsonSchema }>;
  /** How `closing` was described in every tool's declaration. */
  closing?: string;
  /** The form its reply takes, whether a two-step reply streams anyway, and what the contract it was told names. */
  form: ReplyFormSetting;
  stream: boolean;
  tags?: ReplyTags;
  intentFile?: string;
  /** The reply contract as this block holds it, rendered for its form: the briefing's `reply_contract`. */
  contract?: string;
}

export interface SessionState {
  openings: Map<string, Opening>;
  /** What the user's rules remembered at the end of each turn, by the turn: those kept or read back while the session is open. */
  memories: Map<string, RuleMemory>;
  /** The tools each agent definition lists that nobody registered, as the log was told them, by the definition. */
  unregistered: Map<string, Set<string>>;
}

/** Of the tools a definition lists that nobody registered, those the log has not been told of in this session: each is said once, when it is first found. */
export function unsaid(state: SessionState, definition: string, missing: readonly string[]): string[] {
  let said = state.unregistered.get(definition);
  if (said === undefined) {
    said = new Set();
    state.unregistered.set(definition, said);
  }
  const fresh = missing.filter((name) => !said.has(name));
  for (const name of fresh) said.add(name);
  return fresh;
}

const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((item) => typeof item === "string");

/** Whether what the file keeps has what a turn reads of an opening block; whatever else it holds is carried as it is. */
function isOpening(v: JsonObject): boolean {
  return typeof v["text"] === "string" && isMapping(v["snapshot"]) && isStrings(v["tools"]) && isStrings(v["given"]) && isStrings(v["outOfReach"]) && isMapping(v["declared"]) && typeof v["form"] === "string" && typeof v["stream"] === "boolean";
}

/** A lead's opening block as the session file keeps it: the newest for the lead, in the order of the file; none when it keeps none, or none a turn can read. */
export function keptOpening(log: SessionLog, lead: string): Opening | undefined {
  const kept = log.opening(lead)?.opening;
  return kept !== undefined && isOpening(kept) ? (kept as unknown as Opening) : undefined;
}

/** Where what the rules remembered is kept: the host's store, and the log for what it cannot keep or give. */
export interface MemoryStore {
  store: StorePort;
  log: Log;
}

/** The store key of what the rules remembered at a turn's end: by its chat and the turn (the store keeps it by user). */
function memoryKey(chat: string, turn: string): string {
  return `rules/memory/${textHash(chat)}/${textHash(turn)}`;
}

/**
 * What the rules remembered where a run starts: as the nearest turn before it whose memory was kept
 * left them. The turns looked at are those on the session file's path to `from` (the entry the run's
 * first entry hangs from), newest first, each by the chat it was played in, then the turn the
 * request follows (`follows`) when it is not this session's: the scene before's. So the rules read a
 * request's parent as the file does: a turn goes on from the turn it follows, a swipe from the turn
 * before the attempt it replaces, a scene's first turn from the scene before's last, and a turn that
 * follows no turn from nothing. Each turn's memory is looked for in what the session holds, then in
 * the host's store; one the store cannot give is none, and the log says so.
 */
export async function memoryAt(state: SessionState, kept: MemoryStore, scope: Scope, log: SessionLog, from: string | null, follows: string | null | undefined): Promise<RuleMemory | undefined> {
  const turns = log
    .path(from)
    .flatMap((entry) => (entry.type === "turn" ? [entry.turn] : []))
    .reverse();
  if (typeof follows === "string" && log.turn(follows) === undefined) turns.push(follows);
  for (const turn of turns) {
    const held = state.memories.get(turn);
    if (held !== undefined) return held;
    let value: JsonValue | undefined;
    try {
      value = await kept.store.get(scope, memoryKey(log.turn(turn)?.played?.chat ?? scope.chat, turn));
    } catch (error) {
      kept.log.warn("What the rules remembered could not be read from the host's store; they start from nothing.", { turn, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
    if (isMapping(value) && typeof value["turns"] === "number" && isMapping(value["fired"]) && Array.isArray(value["held"])) {
      const memory = value as unknown as RuleMemory;
      state.memories.set(turn, memory);
      return memory;
    }
  }
  return undefined;
}

/**
 * Keeps what the rules remembered at the end of `scope.turn`: through the host's store, by user,
 * chat and turn, and in the session's memory, which holds only `turns`, the turns on the turn's
 * path. One the store could not keep is logged, and the turn goes on.
 */
export async function keepMemory(state: SessionState, kept: MemoryStore, scope: Scope & { turn: string }, memory: RuleMemory, turns: ReadonlySet<string>): Promise<void> {
  state.memories.set(scope.turn, memory);
  keepOnly(state, turns);
  try {
    await kept.store.set(scope, memoryKey(scope.chat, scope.turn), memory as unknown as JsonValue);
  } catch (error) {
    kept.log.warn("What the rules remembered could not be kept in the host's store; after a restart they start from an earlier turn's.", { turn: scope.turn, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Keeps in the session's memory what the rules remembered only for `turns`: the turns on a turn's
 * path, which a later turn can still follow. One that left the path is read again from the store
 * if a turn follows it after all.
 */
export function keepOnly(state: SessionState, turns: ReadonlySet<string>): void {
  for (const turn of state.memories.keys()) if (!turns.has(turn)) state.memories.delete(turn);
}

function keyOf(scope: Scope): string {
  return JSON.stringify([scope.user, scope.chat, scope.session]);
}

export class Sessions {
  readonly #sessions = new Map<string, SessionState>();

  /** The session a scope names, opened when first asked for. */
  of(scope: Scope): SessionState {
    const key = keyOf(scope);
    let state = this.#sessions.get(key);
    if (state === undefined) {
      state = { openings: new Map(), memories: new Map(), unregistered: new Map() };
      this.#sessions.set(key, state);
    }
    return state;
  }

  /**
   * The host closed the session: what memory holds of it is let go. Open again (its closing turn
   * left the path), its next turn goes on with the opening block its file keeps, and the rules from
   * what the store keeps.
   */
  drop(scope: Scope): void {
    this.#sessions.delete(keyOf(scope));
  }
}
