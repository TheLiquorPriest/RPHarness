// One job's run (§13.5): a run of its own, with its own trace and the user's limits on a job's run.
// Its first agent is made from a definition and a brief as `delegate` makes a sub-agent, and holds
// what its definition lists of RPH's own tools and the host's, with the gate, the rules and the
// sub-agents a turn's agents have. A job has no reply: the reply tools are not among its tools.
import { AGENT_TOOLS, agentDrop, agentMessage, askAuthor, delegate, Team } from "../agents";
import type { DelegateCall } from "../agents/tools";
import type { AgentRef, Environment, JobLimits, JobWrite, JsonValue, LimitHit, ModelsApi, Scope, ToolCtx, Usage } from "../contract";
import { createFacts, loadGuidance } from "../files";
import { AgentRuns } from "../harness/agent-run";
import { Judges } from "../harness/judge";
import type { LiveHub } from "../harness/live";
import { connectionOf, lines, runnerTexts, template, toolTextOf } from "../harness/means";
import { callTerms, readSettings, type Settings } from "../harness/settings";
import type { DaySpend, UsageBook } from "../harness/usage";
import { type AgentOutcome, type AgentRunner, Budget, leftFact, type LoopTool, type LoopToolResult, type ParentCall, RunTrace, type Work } from "../loop";
import type { ModelSource } from "../model/source";
import { fileFind, fileRead, fileWrite, type OwnTool, Registry, todo, TodoLists, type ToolText, type Words } from "../tools";
import { BASE_TOOLS, baseTools } from "../tools/base";
import { SEARCH_TOOLS, searchTools } from "../tools/search";
import { JOB_START, jobStart, type JobsWork } from "./tool";
import { JOB_SEARCHED, jobTools } from "./tools";

/** RPH's own tools a job's agents may hold, each described by its file in `.tools/`. */
const JOB_TOOLS = ["file_read", "file_find", "file_write", "todo", ...AGENT_TOOLS, ...BASE_TOOLS, ...SEARCH_TOOLS, JOB_START, ...JOB_SEARCHED] as const;

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
  /** For a job an agent of another job started: that job's budget, which this one's calls and tokens count against too, so a chain of jobs spends no more than the first one may. */
  over?: Budget;
  /** What the user's agents have spent in the last 24 hours, every agent's and his jobs' alone, as it stands each time it is asked: the daily caps this job's calls are held to. */
  spend: DaySpend;
  /** Limits of its own from the start. The owner's own start (none names an agent) gives his word for this job: each stands in place of the settings', looser or tighter. An agent's start only makes each tighter than the settings', never looser. */
  limits?: JobLimits;
}

/** How a job's run ended: its agent's outcome, what every agent of it spent, and a limit of the run's own it reached. */
export interface JobEnd {
  outcome: AgentOutcome;
  usage: Usage;
  limit?: LimitHit;
}

/** A job's run, made and ready: the settings and connection its limits are read from, its trace, what its agents spend, and the user's day, held to its settings. */
export interface PreparedJob {
  settings: Settings;
  connection: { id: string | null; name: string | null };
  agent: AgentRef;
  trace: RunTrace;
  budget: Budget;
  /** What all of the user's jobs have spent today, held to this job's `jobs.tokensPerDay`: a call of any of its agents past it is not made. */
  day: Budget;
  /** What the agents found nobody to give them: the names in the job's `attach` that nobody could find. */
  missing: string[];
  /** Runs it to its end. `hearing` is told what its agent writes, what all its agents have spent and each write any of them makes, as they happen; the signal stops every agent of it. */
  run(signal: AbortSignal, hearing: JobHearing): Promise<JobEnd>;
}

/** What a job's run tells its job as it goes, so the job's record is true if the process is cut off: its first agent's latest text, what the run has spent, and each write. */
export interface JobHearing {
  text(text: string): void;
  spent(usage: Usage): void;
  wrote(write: JobWrite): void;
}

/** Makes a job's run and its first agent, or gives the answer (in `.prompts/delegation.md`'s words) that says why none can be made. */
export async function prepareJob(core: JobCore, ask: JobAsk): Promise<PreparedJob | LoopToolResult> {
  const { env } = core;
  const { scope } = ask;
  const guidance = loadGuidance(env.files, scope);
  const [settings, places, toolNotices, goOn] = await Promise.all([readSettings(guidance, env.files, scope, env.log), env.files.places(scope), guidance.part("tool-notices"), guidance.part("continue-after-rule")]);
  const answers = lines(toolNotices);
  const words: Words = (name, fields) => answers?.line(name, fields);
  const texts = runnerTexts(words, template(goOn), settings.schemaShown);
  const trace = new RunTrace(core.hub.tee(env.trace, scope, () => settings.liveBacklog), scope, ask.id, env.clock, core.hub.hold(ask.id));
  const todos = new TodoLists();
  const rules = await guidance.ruleRun({
    facts: createFacts(env.facts, (_scope, agent) => {
      const open = todos.get(agent.id).filter((item) => !item.done);
      const left = leftFact([...working].find((entry) => entry.runner.agent.id === agent.id)?.runner.left() ?? {}, budget.left());
      return { "todo.open": { count: open.length, names: open.map((item) => item.text) }, ...(left !== undefined ? { "limits.left": left } : {}) };
    }),
    window: settings.ruleWindow,
  });
  for (const problem of rules.problems) env.log.warn("A rule cannot be used.", { path: problem.path, problem: problem.message });
  // The settings' limits on a job's run, each given by the start standing in place of the setting where the owner started the job (his word for it, looser or tighter, §12), and made tighter, never looser, where an agent did. The day's limits hold either way.
  const given = ask.limits ?? {};
  const owner = ask.by === undefined;
  const limit = (setting: number | undefined, asked: number | undefined): number | undefined => (asked === undefined ? setting : owner || setting === undefined ? asked : Math.min(setting, asked));
  const time = limit(settings.jobs.run.time, given.time === undefined ? undefined : given.time * 1000);
  const calls = limit(settings.jobs.run.calls, given.calls);
  const tokensIn = limit(settings.jobs.run.tokensIn, given.tokensIn);
  const tokensOut = limit(settings.jobs.run.tokensOut, given.tokensOut);
  // A job started by another job's agent spends from that job's run, which spends from the user's jobs' day, which spends from every agent's day; any other, from the jobs' day. The usage book counts every call into the day as it ends, so these budgets only read the counts.
  const everyAgent = new Budget("day", settings.day.tokens !== undefined ? { tokens: settings.day.tokens } : {}, undefined, { spent: ask.spend.all, cachedWeight: settings.cachedWeight });
  const day = new Budget("day", settings.jobs.tokensPerDay !== undefined ? { tokens: settings.jobs.tokensPerDay } : {}, everyAgent, { spent: ask.spend.jobs, cachedWeight: settings.cachedWeight });
  // Its own `tokens` count a cached re-read at the weight the day's job tokens do, so the two limits on a job's tokens mean the same; tokens in and out count in full, as the run limits they tighten.
  const budget = new Budget(
    "job",
    { ...(calls !== undefined ? { calls } : {}), ...(tokensIn !== undefined ? { tokensIn } : {}), ...(tokensOut !== undefined ? { tokensOut } : {}), ...(given.tokens !== undefined ? { tokens: given.tokens } : {}) },
    ask.over ?? day,
    { cachedWeight: settings.cachedWeight },
  );
  const working = new Set<{ runner: AgentRunner; work: Work }>();
  let registry: Registry | undefined;
  /** Who a run's writes are told to, from the moment it runs. */
  let heard: JobHearing | undefined;
  /** Every write of the run still under way (a kept request, a transcript line): the run's end waits for them. */
  const pending = new Set<Promise<unknown>>();
  const runs = new AgentRuns({
    env,
    scope,
    trace,
    places,
    guidance,
    settings: () => settings,
    rules: () => rules,
    words,
    tools: () => registry?.all() ?? [],
    tell: (written) => {
      const settled = written.catch(() => undefined);
      pending.add(settled);
      void settled.finally(() => pending.delete(settled));
    },
    ran: (_call, result, tool) => {
      if (tool?.tier !== "write" || result.error === true) return;
      const first = result.content.find((part) => part.type === "text");
      heard?.wrote({ tool: tool.name, ...(tool.lane !== undefined ? { lane: tool.lane } : {}), line: first?.type === "text" ? (first.text.split("\n")[0] ?? "").trim() : "" });
    },
  });
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
    own: async (agent) => connectionOf(core.connections, scope, (await guidance.definition(agent.definition)) ?? {}, env.log),
    track: (entry) => {
      working.add(entry);
      return () => working.delete(entry);
    },
    keep: (agent) => runs.keep(agent),
    // A job has no briefing to hold a rule's text for.
    late: (agent, judged) => env.log.info("A rule's question was answered yes after its agent's work had ended; its text went to no agent.", { job: ask.id, agent: agent.id, rule: judged.fired.firing.rule }),
  });
  const team = new Team({
    env,
    trace,
    guidance,
    ids: () => core.ids(),
    models: core.models,
    connection: (definition) => connectionOf(core.connections, scope, definition, env.log),
    hold: (names) => registry?.hold(names) ?? { tools: [], missing: [...names] },
    unregistered: (name, tools) => env.log.warn("Tools an agent's definition lists are registered by nobody; it holds the rest.", { agent: name, tools: [...tools] }),
    gate: (agent, parent) => runs.gate(agent, parent),
    texts: () => texts,
    rules: () => rules,
    questions: () => judges,
    budget: () => budget,
    settings: () => {
      const { agents: _turnAgents, ...subAgents } = settings.subAgents;
      return settings.jobs.run.agents !== undefined ? { ...subAgents, agents: settings.jobs.run.agents } : subAgents;
    },
    perCall: () => settings.perCall,
    terms: (definition) => callTerms(settings, definition),
    track: (entry) => {
      working.add(entry);
      return () => working.delete(entry);
    },
    gauge: (agent, limits) => core.usage.gauge(scope, ask.id, agent.id, limits.contextWindow?.tokens ?? 0, limits.maxTokens?.tokens ?? 0),
    keep: (agent, kind) => runs.keep(agent, kind),
    // A job's agents are compacted at any call that would not fit, as a turn's are (§11).
    compaction: () => settings.compaction,
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
    fileRead({ files: env.files, words, texts: own, most: settings.perCall }),
    fileFind({ files: env.files, words, texts: own, most: settings.perCall }),
    fileWrite({ files: env.files, words, texts: own, most: settings.perCall }),
    todo({ lists: todos, words, text: own.get("todo"), changed: (agent, items) => trace.event(agent, undefined, { kind: "todo", items: [...items] }) }),
    delegate(team, own.get("delegate")),
    askAuthor(team, own.get("ask_author")),
    agentMessage(team, own.get("agent_message")),
    agentDrop(team, own.get("agent_drop")),
    jobStart(core.jobs, own.get(JOB_START), settings.jobs.perRun),
    ...jobTools(core.jobs, own, settings.perCall),
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
      perCall: settings.perCall,
      schemaShown: settings.schemaShown,
    }),
  ];
  registry = new Registry(tools, await env.tools.all(scope));
  if (registry.shadowed.length > 0) env.log.warn("Host tools that take the name of one of RPH's own are left out.", { tools: registry.shadowed });

  const made = await team.first(ask.call, ask.by, ask.parent);
  if (!("runner" in made)) return made;
  if (made.missing.length > 0) env.log.warn("A job's agent was not given what nobody could find.", { job: ask.id, agent: made.ref.id, missing: made.missing });
  const definition = await guidance.definition(ask.call.agent);
  const connection = definition === undefined ? { id: null, name: null } : await connectionOf(core.connections, scope, definition, env.log);
  const { runner, ref } = made;

  return {
    settings,
    connection: { id: connection.id, name: connection.name },
    agent: ref,
    trace,
    budget,
    day,
    missing: [...made.missing],
    async run(signal, hearing) {
      const startedAt = env.clock.now();
      core.hub.started({ run: ask.id, scope, what: "job", agents: [], started: startedAt });
      core.usage.begin(ask.id);
      heard = hearing;
      trace.watch((record) => {
        core.usage.record(record);
        const { event } = record;
        if (event.kind !== "call_ended") return;
        // What every agent of the run has spent, as of the call that ended.
        hearing.spent({ ...budget.used });
        if (record.agent?.id === ref.id && event.text.trim() !== "") hearing.text(event.text);
      });
      trace.event(ref, ask.parent, { kind: "run_started", run: "job", lead: ref.definition });
      let hit: LimitHit | undefined;
      // The run's time is the time it runs: while the owner holds it (his pause, all jobs held, or the point it asks him at) the clock waits.
      let left = time;
      let armedAt = startedAt;
      let heldAt: number | undefined;
      let heldFor = 0;
      let timer: unknown;
      const arm = (): void => {
        if (left === undefined || time === undefined) return;
        armedAt = env.clock.now();
        timer = env.clock.setTimeout(() => {
          timer = undefined;
          hit = { limit: "time", per: "job", max: time, value: env.clock.now() - startedAt - heldFor };
          for (const entry of working) entry.runner.limit(hit);
        }, Math.max(0, left));
      };
      const held = (isHeld: boolean): void => {
        const now = env.clock.now();
        if (isHeld) {
          heldAt = now;
          if (timer === undefined || left === undefined) return;
          env.clock.clearTimeout(timer);
          timer = undefined;
          left -= now - armedAt;
        } else {
          if (heldAt !== undefined) heldFor += now - heldAt;
          heldAt = undefined;
          if (timer === undefined) arm();
        }
      };
      const unwatch = core.hub.holds.watch(ask.id, held);
      if (core.hub.holds.held(ask.id)) held(true);
      else arm();
      const stop = (): void => {
        for (const entry of working) entry.work.stop();
      };
      // Its brief is its runner's fixed context (`Team.first`), which every request carries after its opening block.
      const work = runner.start({ messages: [] }, { ...(ask.parent !== undefined ? { parent: ask.parent } : {}), given: made.given });
      const entry = { runner, work };
      working.add(entry);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      let outcome: AgentOutcome;
      try {
        outcome = await work.done;
        // What the judging model still has under way is part of the run.
        await judges.settled();
        // Its request files and transcripts settle before its end is told, as a turn's do.
        while (pending.size > 0) await Promise.allSettled([...pending]);
      } finally {
        working.delete(entry);
        signal.removeEventListener("abort", stop);
        unwatch();
        if (timer !== undefined) env.clock.clearTimeout(timer);
        core.usage.end(ask.id);
        core.hub.ended(ask.id);
      }
      const reached = outcome.limit ?? hit;
      return { outcome, usage: { ...budget.used }, ...(reached !== undefined ? { limit: reached } : {}) };
    },
  };
}
