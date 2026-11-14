// The harness a host builds over its environment (Appendix A `createHarness`): it answers turns,
// cancels a turn's work when the turn leaves the path, keeps each session's file (§11), opens and
// closes sessions when the host says so, and compacts one at a turn's start when the lead's first
// call would not fit or the host asked; and it gives the pages their ways in: the live view, usage,
// definitions, rules and models. It has no way to talk with an agent outside a turn, and no jobs.
// What a session holds in memory besides its file (each lead's opening block, what the rules
// remembered) is gone after a restart; the file is read again.
import type { Environment, Harness, HarnessOptions, Scope } from "../contract";
import { loadGuidance } from "../files";
import type { Template } from "../files/api";
import { createModelLayer } from "../model";
import type { ModelSource } from "../model/source";
import { sessionsApi } from "../sessions/api";
import { SessionBook } from "../sessions/book";
import { LiveHub } from "./live";
import { Sessions } from "./sessions";
import { readSettings } from "./settings";
import { shippedTemplate } from "./shipped";
import { Turn, type TurnCore } from "./turn";
import { UsageBook } from "./usage";

export { SHIPPED_GUIDANCE } from "./shipped";
export { DEFAULT_SETTINGS, type Settings } from "./settings";

/** What `createHarness` takes beyond the contract's `HarnessOptions`. */
export interface CreateHarnessOptions extends HarnessOptions {
  /** The models agents run on, in place of the model layer's: the rig's scripted models, in tests. */
  models?: ModelSource;
  /** How the model layer's HTTP goes out (a provider's calls, a server's list of its models): `globalThis.fetch` when absent. */
  fetch?: typeof globalThis.fetch;
  /** The name the app goes by where a provider's sign-in page shows one; the host's id when absent. */
  appName?: string;
}

function turnKey(scope: Scope): string {
  return JSON.stringify([scope.user, scope.chat, scope.turn ?? null]);
}

export function createHarness(env: Environment, options: CreateHarnessOptions = {}): Harness {
  const ids = options.ids ?? (() => crypto.randomUUID());
  // The mark of a system message sent in place is asked for with no chat in view, as each call goes out: RPH's own file.
  let mark: Template | undefined;
  const ready = shippedTemplate("system-note").then(
    (loaded) => {
      mark = loaded;
    },
    (error: unknown) => env.log.error("RPH's own mark for a system message sent in place could not be read; such messages go unmarked.", { error: error instanceof Error ? error.message : String(error) }),
  );
  const layer = createModelLayer({
    store: env.models,
    now: () => env.clock.now(),
    id: ids,
    uuid: () => crypto.randomUUID(),
    log: (text) => env.log.info(text),
    fetch: options.fetch ?? globalThis.fetch,
    setTimeout: (run, ms) => env.clock.setTimeout(run, ms),
    clearTimeout: (handle) => env.clock.clearTimeout(handle),
    appName: options.appName ?? env.id,
    testPrompt: async () => (await shippedTemplate("connection-test")).render().text,
    markNote: (text) => (mark === undefined ? text : mark.render({ text }).text),
  });
  const hub = new LiveHub();
  const usage = new UsageBook(env.store, env.clock, env.log);
  const book = new SessionBook({ files: env.files, log: env.log, ids, now: () => env.clock.now() });
  const core: TurnCore = { env, ids, models: options.models ?? layer, connections: layer.api, hub, usage, sessions: new Sessions(), book };
  const turns = new Map<string, Turn>();
  const answering = new Set<Promise<unknown>>();

  return {
    async answer(req, sink, signal) {
      await ready;
      const turn = new Turn(core, req, sink);
      const key = turnKey(req.scope);
      turns.set(key, turn);
      // The connections are read again first, so a hand edit made since holds from this turn's first
      // call. What the read has to say goes to the log, never to an agent: the layer writes each line
      // there once, through the `log` it was given. The turn is already registered, so it can be left.
      const answered = layer.turnStarting().then(() => turn.answer(signal));
      answering.add(answered);
      try {
        return await answered;
      } finally {
        answering.delete(answered);
        if (turns.get(key) === turn) turns.delete(key);
      }
    },

    async turnLeft(scope) {
      turns.get(turnKey(scope))?.stop();
      // The session file keeps the turn's entries, and marks it off the path: a session it closed is open again (§11).
      const turn = scope.turn;
      if (turn === undefined) return;
      await book.with(scope, async (file) => {
        const tip = file.log.tip(turn);
        if (tip !== undefined) file.add({ type: "left", parent: tip, turn });
        await file.settled();
      });
    },

    sessions: sessionsApi(book, {
      files: env.files,
      now: () => env.clock.now(),
      keepTurns: async (scope) => (await readSettings(loadGuidance(env.files, scope), env.files, scope, env.log)).compaction.keepTurns,
    }),

    rules: {
      list: (scope) => loadGuidance(env.files, scope).rules(),
    },

    live: hub,
    usage,

    definitions: {
      list: (scope) => loadGuidance(env.files, scope).definitions(),
      stack: (scope, agent) => loadGuidance(env.files, scope).stackParts(agent),
    },

    models: layer.api,

    async close() {
      for (const turn of turns.values()) turn.stop();
      await Promise.allSettled([...answering]);
      await usage.settled();
      await book.settled();
      await env.trace.flush();
      await layer.close();
    },
  };
}
