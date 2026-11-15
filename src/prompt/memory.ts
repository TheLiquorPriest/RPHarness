// What a turn does with its prompt at its start (§4.8 "What code does every turn"), and what a
// chat's newest turns' prompts held, kept through the host's store under the chat's scope so that
// the next turn, or a swipe of one, is compared with the turn it follows.
import type { Environment, JsonValue, LocatedSlices, PromptMessage, Scope, StorePort } from "../contract";
import { TurnPrompt } from "./prompt";
import { locatedOf, type PromptRecord, recordOf } from "./shape";
import { textHash } from "./text";

/** The store key of a chat's kept prompts. */
function keyOf(scope: Scope): string {
  return `prompt/turns/${textHash(`${scope.user}\n${scope.chat}`)}`;
}

type Kept = { turn: string; record: PromptRecord }[];

function keptOf(value: JsonValue | undefined): Kept {
  const turns = typeof value === "object" && value !== null && !Array.isArray(value) ? value["turns"] : undefined;
  return Array.isArray(turns) ? (turns as unknown as Kept) : [];
}

/** What a chat's newest turns' prompts held, kept through the host's store: `keep` turns at most (the user's `prompt.kept`). */
export class PromptMemory {
  readonly #store: StorePort;
  readonly #keep: number;

  constructor(store: StorePort, keep: number) {
    this.#store = store;
    this.#keep = keep;
  }

  /** What the turn `parent` held: the one a turn follows. `undefined`: the chat's newest kept turn; `null`: the turn follows none. */
  async before(scope: Scope, parent: string | null | undefined): Promise<PromptRecord | undefined> {
    if (parent === null) return undefined;
    const kept = keptOf(await this.#store.get(scope, keyOf(scope)));
    return (parent === undefined ? kept.at(-1) : kept.find((k) => k.turn === parent))?.record;
  }

  /** Keeps what the turn `scope.turn` held, as the chat's newest; the oldest beyond `keep` are let go. */
  async keep(scope: Scope, record: PromptRecord): Promise<void> {
    const turn = scope.turn;
    if (turn === undefined) return;
    await this.#store.update(scope, keyOf(scope), (current) => {
      const kept = keptOf(current).filter((k) => k.turn !== turn);
      kept.push({ turn, record });
      return { turns: kept.slice(-this.#keep) } as unknown as JsonValue;
    });
  }
}

/** What a turn starts with for its prompt. */
export interface PromptTurnInput {
  env: Pick<Environment, "prompt" | "lore" | "log" | "store">;
  scope: Scope;
  /** The prompt as the request carries it. */
  messages: readonly PromptMessage[];
  /** The turn this one follows (`TurnRequest.parent`). */
  parent: string | null | undefined;
  /** How many turns' prompts a chat keeps to be compared with (the user's `prompt.kept`). */
  keep: number;
}

/**
 * The turn's prompt, its slices found and compared with the turn it follows: the host is given
 * where each slice is, the notices and the front (`saveLocated`), and what it held is kept for the
 * next turn. What the host cannot give or take is logged, and the turn goes on.
 */
export async function promptTurn(input: PromptTurnInput): Promise<{ prompt: TurnPrompt; located: LocatedSlices }> {
  const { env, scope } = input;
  const told = (what: string) => (error: unknown) => {
    env.log.warn(what, { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  };
  const memory = new PromptMemory(env.store, input.keep);
  const [prompt, before] = await Promise.all([TurnPrompt.read({ env, scope, messages: input.messages }), memory.before(scope, input.parent).catch(told("What the turn before held of its prompt could not be read."))]);
  prompt.compareWith(before);
  const located = locatedOf(prompt, before);
  await Promise.all([
    env.prompt.saveLocated(scope, located).catch(told("The host could not keep where the prompt's slices were found.")),
    memory.keep(scope, recordOf(prompt)).catch(told("What this turn's prompt held could not be kept.")),
  ]);
  return { prompt, located };
}
