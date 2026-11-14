// One job's run (§13.5): a run of its own, with its own trace and the user's limits on a job's run.
// Its first agent is made from a definition and a brief as `delegate` makes a sub-agent, and holds
// what its definition lists of RPH's own tools and the host's, with the gate, the rules and the
// sub-agents a turn's agents have. A job has no reply: the reply tools are not among its tools.
import { AGENT_TOOLS, agentDrop, agentMessage, askAuthor, delegate, Team } from "../agents";
import type { DelegateCall } from "../agents/tools";
import type { AgentRef, Environment, JsonValue, LimitHit, ModelsApi, Scope, ToolCtx, Usage } from "../contract";
import { createFacts, loadGuidance } from "../files";
import { TurnGate } from "../harness/gate";
import { Judges } from "../harness/judge";
import type { LiveHub } from "../harness/live";
import { connectionOf, lines, runnerTexts, template, toolTextOf } from "../harness/means";
import { userMessage } from "../harness/prompt";
import { requestPath, sentMessages } from "../harness/requests";
import { readSettings, type Settings } from "../harness/settings";
import type { UsageBook } from "../harness/usage";
import { type AgentOutcome, type AgentRunner, Budget, type KeepRequest, type LoopTool, type LoopToolResult, type ParentCall, RunTrace, type Work } from "../loop";
import type { ModelSource } from "../model/source";
import { fileFind, fileRead, fileWrite, type OwnTool, Registry, todo, TodoLists, type ToolText, type Words } from "../tools";
import { BASE_TOOLS, baseTools } from "../tools/base";
import { SEARCH_TOOLS, searchTools, TOOL_USE } from "../tools/search";
import { JOB_START, jobStart, type JobsWork } from "./tool";

/** RPH's own tools a job's agents may hold, each described by its file in `.tools/`. */
const JOB_TOOLS = ["file_read", "file_find", "file_write", "todo", ...AGENT_TOOLS, ...BASE_TOOLS, ...SEARCH_TOOLS, JOB_START] as const;

/** What every job's run shares: the harness's. */
export interface JobCore {
  env: Environment;
  ids(): string;
  models: ModelSource;
  connections: ModelsApi;
  hub: LiveHub;
  usage: UsageBook;
  /** The harness's jobs, for a job's agent that holds `job_start`. */
  jobs: JobsWork;
}

/** What a job is asked: its run's id, where it runs, its definition and brief as `delegate` takes them, and who started it with which call. */
export interface JobAsk {
  id: string;
  /** Its chat, its own session, and the turn that started it, where one did. */
  scope: Scope;
  call: DelegateCall;
  by?: AgentRef;
  parent?: ParentCall;
}

/** How a job's run ended: its agent's outcome, what every agent of it spent, and a limit of the run's own it reached. */
export interface JobEnd {
  outcome: AgentOutcome;
  usage: Usage;
  limit?: LimitHit;
}

/** A job's run, made and ready: the settings and connection its limits are read from, and its trace. */
export interface PreparedJob {
  settings: Settings;
  connection: { id: string | null; name: string | null };
  agent: AgentRef;
  trace: RunTrace;
  /** Runs it to its end. `onText` hears what its agent writes, call by call; the signal stops every agent of it. */
  run(signal: AbortSignal, onText: (text: string) => void): Promise<JobEnd>;
}

/** Makes a job's run and its first agent, or gives the answer (in `.prompts/delegation.md`'s words) that says why none can be made. */
export async function prepareJob(core: JobCore, ask: JobAsk): Promise<PreparedJob | LoopToolResult> {
  const { env } = core;
  const { scope } = ask;
  const guidance = loadGuidance(env.files, scope);
  const [settings, places, toolNotices, goOn, closing] = await Promise.all([readSettings(guidance, env.files, scope, env.log), env.files.places(scope), guidance.part("tool-notices"), guidance.part("continue-after-rule"), guidance.tool("closing")]);
  const answers = lines(toolNotices);
  const words: Words = (name, fields) => answers?.line(name, fields);
  const texts = runnerTexts(words, template(goOn), template(closing)?.render().text.trimEnd(), settings.schemaShown);
  const trace = new RunTrace(core.hub.tee(env.trace, scope), scope, ask.id, env.clock);
  const todos = new TodoLists();
  const rules = await guidance.ruleRun({
    facts: createFacts(env.facts, (_scope, agent) => {
      const open = todos.get(agent.id).filter((item) => !item.done);
      return { "todo.open": { count: open.length, names: open.map((item) => item.text) } };
    }),
    window: settings.ruleWindow,
  });
  for (const problem of rules.problems) env.log.warn("A rule cannot be used.", { path: problem.path, problem: problem.message });
  const { time, ...counted } = settings.jobs.run;
  const budget = new Budget("job", counted);
  const working = new Set<{ runner: AgentRunner; work: Work }>();
  let registry: Registry | undefined;
  const keep = (agent: AgentRef): KeepRequest | undefined => {
    const turn = places.turn;
    if (settings.requests === "none" || turn === undefined) return undefined;
    return (call, messages) => {
      if (settings.requests === "first" && call !== 1) return undefined;
      const path = requestPath(turn, agent, call);
      void env.files.write(scope, path, { op: "write", text: JSON.stringify({ messages: sentMessages(messages) }) }, "harness").then(
        (done) => {
          if (done.status !== "written") env.log.warn("What a model call was sent could not be kept.", { agent: agent.id, call, path, status: done.status });
        },
        (error: unknown) => env.log.warn("What a model call was sent could not be kept.", { agent: agent.id, call, path, error: error instanceof Error ? error.message : String(error) }),
      );
      return path;
    };
  };
  const judges = new Judges({
    env,
    trace,
    guidance,
    rules,
    ids: () => core.ids(),
    models: core.models,
    connections: core.connections,
    settings,
    budget,
    own: async (agent) => connectionOf(core.connections, settings, (await guidance.definition(agent.definition)) ?? {}, env.log),
    track: (entry) => {
      working.add(entry);
      return () => working.delete(entry);
    },
    // A job has no briefing to hold a rule's text for.
    late: (agent, judged) => env.log.info("A rule's question was answered yes after its agent's work had ended; its text went to no agent.", { job: ask.id, agent: agent.id, rule: judged.fired.firing.rule }),
  });
  const team = new Team({
    env,
    trace,
    guidance,
    ids: () => core.ids(),
    models: core.models,
    connection: (definition) => connectionOf(core.connections, settings, definition, env.log),
    hold: (names) => registry?.hold(names) ?? { tools: [], missing: [...names] },
    unregistered: (name, tools) => env.log.warn("Tools an agent's definition lists are registered by nobody; it holds the rest.", { agent: name, tools: [...tools] }),
    gate: (agent, parent) =>
      new TurnGate({
        scope,
        agent,
        ...(parent !== undefined ? { parent } : {}),
        trace,
        clock: env.clock,
        files: env.files,
        ...(env.approvals !== undefined ? { approvals: env.approvals } : {}),
        ...(env.switches !== undefined ? { switches: env.switches } : {}),
        places,
        rules,
        words,
        tools: new Map((registry?.all() ?? []).map((tool) => [tool.name, tool])),
        clipChars: settings.clipChars,
        // A job writes no intent record, so nothing waits for one.
        ready: async () => {},
      }),
    texts: () => texts,
    rules: () => rules,
    questions: () => judges,
    budget: () => budget,
    settings: () => settings.subAgents,
    perCall: () => settings.perCall,
    track: (entry) => {
      working.add(entry);
      return () => working.delete(entry);
    },
    gauge: (agent, limits) => core.usage.gauge(scope, ask.id, agent.id, limits.contextWindow?.tokens ?? 0, limits.maxTokens?.tokens ?? 0),
    keep: (agent) => keep(agent),
    job: ask.id,
  });
  const own = new Map<string, ToolText>();
  for (const [name, part] of await Promise.all(JOB_TOOLS.map(async (name) => [name, await guidance.tool(name)] as const))) {
    const text = toolTextOf(part);
    if (text !== undefined) own.set(name, text);
  }
  const runAs = (tool: LoopTool, args: JsonValue, ctx: ToolCtx): Promise<LoopToolResult> => {
    for (const { runner } of working) if (runner.agent.id === ctx.agent.id) return runner.runAs(tool, args, ctx);
    return Promise.resolve({ content: [], error: true });
  };
  const tools: OwnTool[] = [
    fileRead({ files: env.files, words, texts: own }),
    fileFind({ files: env.files, words, texts: own }),
    fileWrite({ files: env.files, words, texts: own }),
    todo({ lists: todos, words, text: own.get("todo"), changed: (agent, items) => trace.event(agent, undefined, { kind: "todo", items: [...items] }) }),
    delegate(team, own.get("delegate")),
    askAuthor(team, own.get("ask_author")),
    agentMessage(team, own.get("agent_message")),
    agentDrop(team, own.get("agent_drop")),
    jobStart(core.jobs, own.get(JOB_START)),
    ...baseTools({ env, guidance, texts: own, ids: () => core.ids(), gapHits: settings.gapHits, perCall: settings.perCall, ...(env.web !== undefined ? { web: env.web } : {}) }),
    ...searchTools({
      reach: {
        of: async (agent) => {
          const definition = await guidance.definition(agent.definition);
          return { tools: registry?.all() ?? [], fixed: definition?.tools ?? [], outOfReach: definition?.outOfReach ?? [] };
        },
        run: runAs,
      },
      ...(env.switches !== undefined ? { switches: env.switches } : {}),
      guidance,
      notices: words,
      texts: own,
      hits: settings.searchHits,
      schemaShown: settings.schemaShown,
    }).map((tool) => (tool.name === TOOL_USE ? { ...tool, carrier: true } : tool)),
  ];
  registry = new Registry(tools, await env.tools.all(scope));
  if (registry.shadowed.length > 0) env.log.warn("Host tools that take the name of one of RPH's own are left out.", { tools: registry.shadowed });

  const made = await team.first(ask.call, ask.by, ask.parent);
  if (!("runner" in made)) return made;
  if (made.missing.length > 0) env.log.warn("A job's agent was not given what nobody could find.", { job: ask.id, agent: made.ref.id, missing: made.missing });
  const definition = await guidance.definition(ask.call.agent);
  const connection = definition === undefined ? { id: null, name: null } : await connectionOf(core.connections, settings, definition, env.log);
  const { runner, ref } = made;

  return {
    settings,
    connection: { id: connection.id, name: connection.name },
    agent: ref,
    trace,
    async run(signal, onText) {
      const startedAt = env.clock.now();
      core.hub.started({ run: ask.id, scope, what: "job", agents: [], started: startedAt });
      core.usage.begin(ask.id);
      trace.watch((record) => {
        core.usage.record(record);
        const { event } = record;
        if (record.agent.id === ref.id && event.kind === "call_ended" && event.text.trim() !== "") onText(event.text);
      });
      trace.event(ref, ask.parent, { kind: "run_started", run: "job", lead: ref.definition });
      let limit: LimitHit | undefined;
      const timer =
        time === undefined
          ? undefined
          : env.clock.setTimeout(() => {
              limit = { limit: "time", per: "job", max: time, value: env.clock.now() - startedAt };
              for (const entry of working) entry.runner.limit(limit);
            }, time);
      const stop = (): void => {
        for (const entry of working) entry.work.stop();
      };
      const work = runner.start({ messages: [userMessage(made.first, startedAt)] }, { ...(ask.parent !== undefined ? { parent: ask.parent } : {}), given: made.given });
      const entry = { runner, work };
      working.add(entry);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      let outcome: AgentOutcome;
      try {
        outcome = await work.done;
        // What the judging model still has under way is part of the run.
        await judges.settled();
      } finally {
        working.delete(entry);
        signal.removeEventListener("abort", stop);
        if (timer !== undefined) env.clock.clearTimeout(timer);
        core.usage.end(ask.id);
        core.hub.ended(ask.id);
      }
      const hit = outcome.limit ?? limit;
      return { outcome, usage: { ...budget.used }, ...(hit !== undefined ? { limit: hit } : {}) };
    },
  };
}
