// The owner's hand on the runs going on (§14 Live, §13.5 Jobs; C-19): a run held makes no further
// request, in any of its agents, until it is let go, and what the owner says to a run is heard by its
// main agent at its next request as his words. A run is held for one of three reasons that stand
// apart: the owner paused it, every job is held (the Jobs page's switch), or a job reached the point
// it asks the owner about. Held for one, let go of that one, it stays held for the others. Nothing
// here decides anything by itself: each change is the owner's press, or a job's own start naming an
// ask point; the runner only waits where it is told to.
import type { AgentRef } from "../contract";
import type { RunHold } from "../loop";

/** Why a run is held: the owner paused it; every job is held; a job reached the point it asks him about. */
export type HoldReason = "paused" | "all" | "asking";

/** One run's state: what holds it, who hears the owner, what he said and has not been heard, and who is told when it is held or let go. */
interface RunState {
  readonly reasons: Set<HoldReason>;
  /** The run's main agent: the first agent that appeared in it, which hears the owner. */
  main: string | undefined;
  readonly said: string[];
  /** Settles when the run is held or let go, and is replaced then. */
  changed: PromiseWithResolvers<void>;
  readonly watchers: Set<(held: boolean) => void>;
}

/** Settles when `signal` aborts; `off` takes the listener away once the wait is over, so waiting leaves none behind. */
function aborted(signal: AbortSignal): { promise: Promise<void>; off(): void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  const onAbort = (): void => resolve();
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", onAbort, { once: true });
  return { promise, off: () => signal.removeEventListener("abort", onAbort) };
}

export class Holds {
  readonly #runs = new Map<string, RunState>();

  /** The hold of one run, for the runner that works in it: a run that is not held or has gone is simply not held. */
  of(run: string): RunHold {
    const holds = this;
    return {
      get held(): boolean {
        return holds.held(run);
      },
      until: (signal: AbortSignal) => holds.#until(run, signal),
      said: (agent: AgentRef) => holds.#taken(run, agent),
    };
  }

  /** Whether the run is held, for any reason. */
  held(run: string): boolean {
    return (this.#runs.get(run)?.reasons.size ?? 0) > 0;
  }

  /** Whether the run is held for this reason. */
  heldFor(run: string, reason: HoldReason): boolean {
    return this.#runs.get(run)?.reasons.has(reason) ?? false;
  }

  /** Holds the run for `reason`: false where it already was. */
  add(run: string, reason: HoldReason): boolean {
    const state = this.#state(run);
    if (state.reasons.has(reason)) return false;
    const was = state.reasons.size > 0;
    state.reasons.add(reason);
    this.#changed(state, was);
    return true;
  }

  /** Lets the run go of `reason`: false where it was not held for it. The run goes on once nothing holds it. */
  drop(run: string, reason: HoldReason): boolean {
    const state = this.#runs.get(run);
    if (state === undefined || !state.reasons.delete(reason)) return false;
    this.#changed(state, true);
    return true;
  }

  /** The owner's words to the run's main agent, heard at its next request; false for none. */
  say(run: string, words: string): boolean {
    if (words.trim() === "") return false;
    this.#state(run).said.push(words);
    return true;
  }

  /** An agent appeared in the run: the first is its main agent. */
  joined(run: string, agent: AgentRef): void {
    const state = this.#state(run);
    state.main ??= agent.id;
  }

  /** The run ended: nothing of it is kept, and a runner still waiting on it is let go. */
  close(run: string): void {
    const state = this.#runs.get(run);
    if (state === undefined) return;
    this.#runs.delete(run);
    state.reasons.clear();
    state.changed.resolve();
  }

  /** Tells `told` each time the run becomes held or is let go of its last reason, until the returned function is called. */
  watch(run: string, told: (held: boolean) => void): () => void {
    const state = this.#state(run);
    state.watchers.add(told);
    return () => state.watchers.delete(told);
  }

  #state(run: string): RunState {
    let state = this.#runs.get(run);
    if (state === undefined) {
      state = { reasons: new Set(), main: undefined, said: [], changed: Promise.withResolvers<void>(), watchers: new Set() };
      this.#runs.set(run, state);
    }
    return state;
  }

  /** The run was held or let go: whoever waits is woken, and whoever watches is told when it went from one state to the other. */
  #changed(state: RunState, was: boolean): void {
    const woken = state.changed;
    state.changed = Promise.withResolvers<void>();
    woken.resolve();
    const now = state.reasons.size > 0;
    if (now !== was) for (const told of [...state.watchers]) told(now);
  }

  async #until(run: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      const state = this.#runs.get(run);
      if (state === undefined || state.reasons.size === 0 || signal.aborted) return;
      const stop = aborted(signal);
      try {
        await Promise.race([state.changed.promise, stop.promise]);
      } finally {
        stop.off();
      }
    }
  }

  #taken(run: string, agent: AgentRef): string[] {
    const state = this.#runs.get(run);
    if (state === undefined || state.said.length === 0) return [];
    state.main ??= agent.id;
    return state.main === agent.id ? state.said.splice(0) : [];
  }
}
