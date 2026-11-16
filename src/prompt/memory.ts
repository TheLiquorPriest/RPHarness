// What a turn does with its prompt at its start (§4.8 "What code does every turn"), and what a
// chat's turns' prompts held, kept through the host's store under the chat's scope so that the next
// turn, or a swipe of one, is compared with the turn it follows. RPH keeps no count of turns and
// reads no retention setting: a turn before is compared only while the host still keeps its turn
// folder, and what RPH kept of a turn's prompt is let go once its folder is gone, whatever the host
// prunes its folders by (RPE by its own `retention.turnFolders`).
import type { AgentRef, Environment, FilesPort, JsonValue, LocatedSlices, PromptMessage, Scope, StorePort } from "../contract";
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

  /** Keeps what the turn `scope.turn` held, as the chat's newest; those whose turn folders the host no longer keeps are let go. */
  async keep(scope: Scope, record: PromptRecord): Promise<void> {
    const turn = scope.turn;
    if (turn === undefined) return;
    const folders = await this.#turnsKept(scope);
    await this.#store.update(scope, keyOf(scope), (current) => {
      const kept = keptOf(current).filter((k) => k.turn !== turn && (folders === undefined || folders.has(k.turn)));
      kept.push({ turn, record });
      return { turns: kept } as unknown as JsonValue;
    });
  }
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
  prompt.compareWith(before);
  const located = locatedOf(prompt, before);
  const corrected = prompt.corrected();
  await Promise.all([
    env.prompt.saveLocated(scope, located).catch(told("The host could not keep where the prompt's slices were found.")),
    memory.keep(scope, recordOf(prompt)).catch(told("What this turn's prompt held could not be kept.")),
    corrected === undefined ? undefined : env.prompt.saveMap(scope, corrected, input.by).catch(told("The host could not keep the prompt map as the breakdown corrected it.")),
  ]);
  return { prompt, located };
}
