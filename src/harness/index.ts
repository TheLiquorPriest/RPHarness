// The harness a host builds over its environment (Appendix A `createHarness`): it answers turns,
// cancels a turn's work and its jobs when the turn leaves the path, puts an earlier attempt back on
// it when the host shows that attempt again, keeps each session's file (§11), opens and closes
// sessions when the host says so, and compacts one at a turn's start when the lead's first call
// would not fit (or its provider refused it as too long) or the host asked; it runs the jobs agents
// and the user start (§13.5); and it gives the pages their ways in: the live view, usage,
// definitions, rules, models and jobs. It has no way to talk with an agent outside a turn. Each lead's
// opening block is kept in the session's file, and what the rules remembered at each turn's end in
// the host's store, so a restart, or a session open again after a close, goes on with both. A job a
// restart cut off is found in the host's store.
import type { Environment, Harness, HarnessOptions, Scope } from "../contract";
import { listFacts, loadGuidance } from "../files";
import { createModelLayer, modelTexts, runOf } from "../model";
import type { ModelSource } from "../model/source";
import { tokensOf } from "../model/tokens";
import { withClosing } from "../loop";
import { promptMapApi } from "../prompt";
import { Jobs } from "../jobs";
import { closingOf, type SessionChange, sessionsApi } from "../sessions/api";
import { SessionBook } from "../sessions/book";
import { LiveHub } from "./live";
import { connectionOf, template } from "./means";
import { openingOf } from "./opening";
import { listedTools, ownTexts } from "./own";
import { keptOpening, Sessions } from "./sessions";
import { rebuildRequest } from "./requests";
import { formFor, readModelSettings, readSettings } from "./settings";
import { Turn, type TurnCore } from "./turn";
import { Registry } from "../tools";
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
    texts: (scope) => modelTexts(env.files, scope),
    settings: (scope) => readModelSettings(env.files, scope, env.log),
    ...(env.switches !== undefined ? { switches: env.switches } : {}),
  });
  const hub = new LiveHub({ log: env.log });
  const usage = new UsageBook({ store: env.store, clock: env.clock, log: env.log, files: env.files });
  const book = new SessionBook({ files: env.files, log: env.log, ids, now: () => env.clock.now() });
  const jobs = new Jobs({ env, ids, models: options.models ?? layer, connections: layer.api, hub, usage, book });
  const core: TurnCore = { env, ids, models: options.models ?? layer, connections: layer.api, hub, usage, sessions: new Sessions(), book, jobs };
  const turns = new Map<string, Turn>();
  const answering = new Set<Promise<unknown>>();
  // A change of a session made on the host's word, outside any agent's work, is a run of its own,
  // numbered 1, with no agent (S-1), told to the host's trace and the chat's live view as it happens.
  const told = (scope: Scope, change: SessionChange): void => {
    hub.tee(env.trace, scope).event({ seq: 1, run: ids(), scope, at: env.clock.now(), event: { kind: "session", ...change } });
  };
  // A session that closed: what the harness keeps of it beside its file is let go, and what pi keeps for the lead's session (its prompt cache), once until it opens again.
  const sessionClosed = (scope: Scope): void => {
    core.sessions.drop(scope);
    core.models.ended?.(scope.user, scope.session);
  };
  // The registry as a run builds it for a scope, for the pages: RPH's own tools as a page lists them, and the host's.
  const registryOf = async (scope: Scope) => {
    const guidance = loadGuidance(env.files, scope);
    const [settings, texts] = await Promise.all([readSettings(guidance, env.files, scope, env.log), ownTexts(guidance)]);
    return { guidance, settings, registry: new Registry(listedTools(env, guidance, texts, settings, jobs), await env.tools.all(scope)) };
  };

  return {
    async answer(req, sink, signal) {
      const turn = new Turn(core, req, sink);
      const key = turnKey(req.scope);
      turns.set(key, turn);
      // The connections are read again first, so a hand edit made since holds from this turn's first
      // call. What the read has to say goes to the log, never to an agent: the layer writes each line
      // there once, through the `log` it was given. The turn is already registered, so it can be left.
      const answered = layer.turnStarting(req.scope.user).then(() => turn.answer(signal));
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
      await jobs.turnLeft(scope);
      // The session file keeps the turn's entries, and marks it off the path: a session it closed is open again (§11), and that is told.
      const turn = scope.turn;
      if (turn === undefined) return;
      await book.with(scope, async (file) => {
        const tip = file.log.tip(turn);
        if (tip === undefined) return;
        const was = closingOf(file);
        file.add({ type: "left", parent: tip, turn });
        await file.settled();
        if (was !== undefined && closingOf(file) === undefined) told(scope, { session: scope.session, change: "reopened", turn });
      });
    },

    async turnShown(scope) {
      // The session file marks the attempt shown again; what followed the attempts it replaces follows it (§6.3). A session one of them closed is open again, one the attempt shown closed is closed again, and that is told.
      const turn = scope.turn;
      if (turn === undefined) return;
      await book.with(scope, async (file) => {
        const tip = file.log.tip(turn);
        if (tip === undefined) return;
        const was = closingOf(file);
        file.add({ type: "shown", parent: tip, turn });
        await file.settled();
        const now = closingOf(file);
        if ((now === undefined) === (was === undefined)) return;
        if (now === undefined) return told(scope, { session: scope.session, change: "reopened", turn });
        sessionClosed(scope);
        told(scope, { session: scope.session, change: "closed", ...(now.turn !== undefined ? { turn: now.turn } : {}), ...(now.by !== undefined ? { by: now.by } : {}) });
      });
    },

    sessions: sessionsApi(book, {
      files: env.files,
      now: () => env.clock.now(),
      keepTurns: async (scope) => (await readSettings(loadGuidance(env.files, scope), env.files, scope, env.log)).compaction.keepTurns,
      closed: sessionClosed,
      told,
    }),

    rules: {
      list: (scope) => loadGuidance(env.files, scope).rules(),
      // One writer per fact: a host fact under one of RPH's names is listed marked, and said in the log.
      facts: async () => {
        const facts = listFacts(env.facts);
        for (const fact of facts) if (fact.clash === true) env.log.warn("A host fact takes the name of one of RPH's own facts; rules read RPH's.", { fact: fact.name });
        return facts;
      },
    },

    live: hub,
    usage,
    jobs,

    definitions: {
      list: async (scope) => {
        const views = await loadGuidance(env.files, scope).definitions();
        const connections = await layer.api.list(scope.user);
        return views.map((view) => ({ ...view, runsOn: runOf(connections, view) }));
      },
      // Every part of what the agent gets, as the one builder makes it for a run: its stack, for a lead
      // (the agent given the briefing) the reply contract in the form its connection's replies take,
      // each family guide and held tool's description, the skills' index, and the briefing's parts
      // with the situations that add them.
      stack: async (scope, agent) => {
        const { guidance, settings, registry } = await registryOf(scope);
        const [definition, contract] = await Promise.all([guidance.definition(agent), guidance.part("reply-contract")]);
        const lead = definition?.given.includes("briefing") === true ? template(contract) : undefined;
        const form = lead === undefined || definition === undefined ? undefined : formFor(settings, await connectionOf(layer.api, scope, definition, env.log)).form;
        const block = await openingOf({ guidance, agent, definition, tools: definition === undefined ? [] : registry.hold(definition.tools).tools, isTool: (name) => registry.has(name), ...(lead !== undefined && form !== undefined ? { contract: { part: lead, form } } : {}) });
        return block.parts;
      },
      // "Apply now": the session file's mark puts every lead's block before it out of force, so the
      // next run of each makes and writes its block afresh, over a restart too; memory lets go of them.
      // A sub-agent's and a job's agent's blocks are made at each start already.
      apply: async (scope) => {
        await book.with(scope, async (file) => {
          if (file.log.openings().length > 0) file.add({ type: "applied", parent: file.log.leaf });
          await file.settled();
        });
        core.sessions.of(scope).openings.clear();
      },
      // What an agent's requests carry as its fixed list, as a run declares it: a lead's as its session opened it, else its definition's as the registry holds it now; with its size.
      declared: async (scope, agent) => {
        const { guidance, settings, registry } = await registryOf(scope);
        const opening = core.sessions.of(scope).openings.get(agent) ?? (await book.with(scope, (file) => keptOpening(file.log, agent)));
        const held = opening !== undefined ? registry.opened(opening.tools, opening.declared, async () => ({ content: [], error: true })).tools : registry.hold((await guidance.definition(agent))?.tools ?? []).tools;
        const tools = held.map((tool) => ({ name: tool.name, description: tool.description, parameters: withClosing(tool) }));
        return { tools, tokens: tokensOf(JSON.stringify(tools), settings.tokens.charsPerToken), most: settings.fixedTokens };
      },
      tools: async (scope) => {
        const { registry } = await registryOf(scope);
        return registry
          .all()
          .map(({ name, family, from }) => ({ name, family, from }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    },

    models: layer.api,
    promptMap: promptMapApi(env),

    rebuildRequest(scope, file) {
      return rebuildRequest(env.files, scope, file);
    },

    async close() {
      for (const turn of turns.values()) turn.stop();
      await Promise.allSettled([...answering, jobs.close()]);
      await usage.settled();
      await book.settled();
      await env.trace.flush();
      await layer.close();
    },
  };
}
