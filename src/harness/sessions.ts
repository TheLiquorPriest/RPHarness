// What the harness keeps of a session between its turns (§5.2, §10.2): each lead's opening block,
// fixed when the session opened, with the tools it held and the snapshot of its stack that later
// briefings are compared with; and what the user's rules remember across turns. Kept while the
// harness runs; the session file, which outlives a restart, comes with the sessions lane.
import type { Scope } from "../contract";
import type { RuleMemory, StackSnapshot } from "../files/api";
import type { ReplyTags } from "../reply/tags";
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
  /** How `closing` was described in every tool's declaration. */
  closing?: string;
  /** The form its reply takes, whether a two-step reply streams anyway, and what the contract it was told names. */
  form: ReplyFormSetting;
  stream: boolean;
  tags?: ReplyTags;
  intentFile?: string;
}

export interface SessionState {
  openings: Map<string, Opening>;
  memory?: RuleMemory;
}

export class Sessions {
  readonly #sessions = new Map<string, SessionState>();

  /** The session a scope names, opened when first asked for. */
  of(scope: Scope): SessionState {
    const key = JSON.stringify([scope.user, scope.chat, scope.session]);
    let state = this.#sessions.get(key);
    if (state === undefined) {
      state = { openings: new Map() };
      this.#sessions.set(key, state);
    }
    return state;
  }
}
