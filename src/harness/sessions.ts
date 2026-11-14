// What the harness keeps of a session between its turns (§5.2, §10.2): each lead's opening block,
// fixed when the session opened, with the tools it held and the snapshot of its stack that later
// briefings are compared with; and what the user's rules remember, as each turn left it, so that a
// swipe starts from its parent's and not from the attempt it replaces (§6.3, §10.10). Kept while the
// harness runs: a restart forgets it.
import type { JsonSchema, Scope } from "../contract";
import type { RuleMemory, StackSnapshot } from "../files/api";
import type { ReplyTags } from "../reply/tags";
import type { SessionLog } from "../sessions/file";
import type { ReplyFormSetting } from "./settings";

/** A lead's opening block (§10.2 block 1), as the session opened it. */
export interface Opening {
  /** Its text: the definition, the instruction stack, the reply contract and the tool guide. */
  text: string;
  /** What the stack held, for the briefing's "files changed since this session opened". */
  snapshot: StackSnapshot;
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
  /** What the user's rules remembered at the end of each turn of the session, by the turn. */
  memories: Map<string, RuleMemory>;
  /** The tools each agent definition lists that nobody registered, as the log was told them, by the definition. */
  unregistered: Map<string, Set<string>>;
  /** The turns whose reply went out with no intent record taken before it, for the briefing of the turn after. */
  withoutIntent: Set<string>;
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

/**
 * What the rules remembered where a turn hangs in the session file (`from`, the entry its first
 * entry hangs from): as the nearest turn on that path whose memory was kept left them. So the rules
 * read a request's parent as the file does: a turn goes on from the turn it follows, a swipe from
 * the turn before the attempt it replaces, and a turn that follows no turn from nothing.
 */
export function memoryAt(state: SessionState, log: SessionLog, from: string | null): RuleMemory | undefined {
  const path = log.path(from);
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const entry = path[i]!;
    if (entry.type === "opened" || entry.turn === undefined) continue;
    const memory = state.memories.get(entry.turn);
    if (memory !== undefined) return memory;
  }
  return undefined;
}

/** The turn a turn hanging at `from` follows: the turn of the nearest entry on that path that is one of a turn's. */
export function turnAt(log: SessionLog, from: string | null): string | undefined {
  for (let at = from === null ? undefined : log.get(from); at !== undefined; at = at.parent === null ? undefined : log.get(at.parent)) {
    if (at.type !== "opened" && at.turn !== undefined) return at.turn;
  }
  return undefined;
}

export class Sessions {
  readonly #sessions = new Map<string, SessionState>();

  /** The session a scope names, opened when first asked for. */
  of(scope: Scope): SessionState {
    const key = JSON.stringify([scope.user, scope.chat, scope.session]);
    let state = this.#sessions.get(key);
    if (state === undefined) {
      state = { openings: new Map(), memories: new Map(), unregistered: new Map(), withoutIntent: new Set() };
      this.#sessions.set(key, state);
    }
    return state;
  }
}
