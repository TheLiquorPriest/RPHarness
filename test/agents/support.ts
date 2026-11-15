// A stage for a lead and its sub-agents: the folder host over a made folder, RPH's own shipped
// files as its lowest level with the test's files over them, a scripted model for each model a
// definition names, and the parts of a turn made as the harness makes them: one trace for every
// agent of the turn (shown live, and counted), the gate around every tool call, the rules, the
// user's settings, the registry of RPH's own tools and the host's, and the team. Everything else
// here is invented.
//
// The turns run on the rig's clock without moving it: a scripted answer that must wait holds at a
// gate the test opens. The stage's folder goes whatever fails: a set-up that throws removes it, and
// the stage is closed when the test that made it ends, whether or not the test closed it.
import { onTestFinished } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRef, ApprovalsPort, AttachmentRef, ConsentGrant, Environment, JsonValue, Log, Scope, StorePort, ToolResult, TurnEvents } from "../../src/contract";
import { agentMessage, AGENT_TOOLS, askAuthor, delegate, Team, type TeamDeps } from "../../src/agents";
import { createFacts, loadGuidance } from "../../src/files";
import type { AgentDefinition, PromptPart } from "../../src/files/api";
import { TurnGate } from "../../src/harness/gate";
import { LiveHub } from "../../src/harness/live";
import { userMessage } from "../../src/harness/prompt";
import { readSettings } from "../../src/harness/settings";
import { UsageBook } from "../../src/harness/usage";
import { createFolderHost, type FolderHost, type ToolHandler } from "../../src/hosts/folder";
import { SHIPPED_GUIDANCE } from "../../src/index";
import { type AgentOutcome, AgentRunner, Budget, type ParentCall, type RunnerTexts, RunTrace, type Work } from "../../src/loop";
import { type FileToolsDeps, fileFind, fileRead, fileWrite, type HeldTool, Registry, type ToolText, type Words } from "../../src/tools";
import { type Answer, FakeClock, scriptedModel, type ScriptedModel, scriptedSource } from "../../src/testing/rig";
import { TraceRecorder } from "../loop/support";

export { gate, type Gate, type RecordedRequest } from "../../src/testing/rig";
export { textOf } from "../loop/support";

export const USER = "reader";
export const CHARACTER = "wren-hale";
export const CHAT = "lighthouse";

/** A tool the host registers, and what runs it. */
export interface HostToolFixture {
  tier: "read" | "write" | "external";
  lane?: string;
  description: string;
  parameters?: Record<string, JsonValue>;
  run: ToolHandler;
}

/** A message of the chat, as the folder host keeps one. */
export interface MessageFixture {
  role: "user" | "assistant" | "system";
  name: string;
  text: string;
  hidden?: boolean;
}

/** A lore entry, as the folder host keeps one. */
export interface LoreFixture {
  id: string;
  source: string;
  title: string;
  keys: string[];
  text: string;
  knowing?: { by: "characters"; names: string[] };
}

export interface StageOptions {
  /** Each model's script, by the name a definition's `model:` gives. */
  models: Record<string, Answer[]>;
  /** Files by their path under the agents' tree on disk (`files/`): `.agents/gm.md` is the global level's. */
  files?: Record<string, string>;
  tools?: Record<string, HostToolFixture>;
  approvals?: ApprovalsPort;
  messages?: MessageFixture[];
  /** The stretches of the chat the host names. */
  ranges?: Record<string, { from: number; to: number }>;
  lore?: LoreFixture[];
  /** The views of the story the host gives by name. */
  views?: Record<string, string>;
  /** The run's point before each request of every agent the team makes. */
  point?: TeamDeps["point"];
  /** How the host's store is reached: a test can hold a write back. */
  store?: (inner: StorePort) => StorePort;
}

/** A turn under way: the lead's outcome when its run ends, and a stop for every agent of the turn. */
export interface Played {
  run: string;
  lead: AgentRef;
  done: Promise<AgentOutcome>;
  /** The turn's team, which makes a job's first agent as it makes a sub-agent (`Team.first`). */
  team: Team;
  stop(): void;
}

export interface Stage {
  dir: string;
  host: FolderHost;
  env: Environment;
  clock: FakeClock;
  models: Record<string, ScriptedModel>;
  trace: TraceRecorder;
  hub: LiveHub;
  usage: UsageBook;
  /** What the host was told of attachments and consents, in order. */
  told: ({ kind: "attachments"; agent: AgentRef; refs: AttachmentRef[] } | { kind: "consent"; grant: ConsentGrant })[];
  /** The progress lines shown, in order. */
  progress: string[];
  logged: { level: string; message: string; fields?: Record<string, JsonValue> }[];
  /** Starts a turn with the player's message: the lead, the team, and the rest of the turn's parts. */
  play(message: string, turn?: string): Promise<Played>;
  /** Every file of the agents' tree, as text. */
  files(): Promise<string[]>;
  /** The lines the folder host keeps for a chat: what it was told, or the journal of a turn's writes. */
  kept(file: "events" | { writes: string }): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** Progress lines as RPE's drafted file has them, with the rows for agents at work, which RPH's own file does not show. */
export const PROGRESS = "---\ndescription: Fixture progress lines.\nformat: lines\n---\nstarted: Reading the turn.\ntool: {{tool}}\ndelegate: Asking {{agent}}.\nagents: {{count}} agents at work.\nquestion: {{agent}} has a question.\nstill: Still working ({{elapsed}}).\n";

/** A tool's answer in plain text. */
export function said(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** A definition file, header and body. */
export function definition(name: string, header: { model: string; effort?: string; tools: string[]; reads?: string[]; given?: string[]; limits?: string }, body: string): string {
  const lines = [
    "---",
    `name: ${name}`,
    `description: Fixture ${name}.`,
    `model: ${header.model}`,
    ...(header.effort !== undefined ? [`effort: ${header.effort}`] : []),
    `tools: [${header.tools.join(", ")}]`,
    `reads: [${(header.reads ?? []).join(", ")}]`,
    `given: [${(header.given ?? []).join(", ")}]`,
    ...(header.limits !== undefined ? [`limits: ${header.limits}`] : []),
    "---",
    body,
    "",
  ];
  return lines.join("\n");
}

function recordingLog(logged: Stage["logged"]): Log {
  const line = (level: string) => (message: string, fields?: Record<string, JsonValue>) => {
    logged.push({ level, message, ...(fields !== undefined ? { fields } : {}) });
  };
  return { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") };
}

function templateText(part: PromptPart | undefined, fields?: Record<string, JsonValue>): string | undefined {
  return part?.format === "template" ? part.render(fields).text : undefined;
}

/** A tool's file as its tool takes it: its body, and its header's `arguments`. */
function toolText(part: PromptPart | undefined): ToolText | undefined {
  if (part?.format !== "template") return undefined;
  const given = part.header["arguments"];
  const args: Record<string, string> = {};
  if (typeof given === "object" && given !== null && !Array.isArray(given)) {
    for (const [name, text] of Object.entries(given)) if (typeof text === "string") args[name] = text;
  }
  return { description: part.render().text.trimEnd(), arguments: args };
}

/** The connection a definition names, in the rig: its `model:` is the scripted model's name. */
async function connectionOf(definition: AgentDefinition) {
  const name = definition.model ?? "default";
  return { choice: { user: USER, connectionId: name, model: null, ...(definition.effort !== undefined ? { effort: definition.effort } : {}) }, label: name };
}

export async function stage(options: StageOptions): Promise<Stage> {
  const dir = await mkdtemp(join(tmpdir(), "rph-agents-"));
  let host: FolderHost | undefined;
  try {
    const made = await staged(dir, options, (made) => (host = made));
    onTestFinished(() => made.close());
    return made;
  } catch (error) {
    await host?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The stage over its made folder; `hosted` hears of the folder host as soon as it is made. */
async function staged(dir: string, options: StageOptions, hosted: (host: FolderHost) => void): Promise<Stage> {
  const files = join(dir, "files");
  await cp(SHIPPED_GUIDANCE, join(files, "defaults"), { recursive: true });
  await mkdir(join(files, "chats", CHARACTER, CHAT), { recursive: true });
  for (const [path, text] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(files, path)), { recursive: true });
    await writeFile(join(files, path), text, "utf8");
  }
  const records = join(dir, "host", "chats", CHAT);
  await mkdir(records, { recursive: true });
  await writeFile(join(records, "chat.json"), JSON.stringify({ character: CHARACTER, preset: { id: "fixture-preset", name: "Fixture preset" }, ...(options.ranges !== undefined ? { ranges: options.ranges } : {}) }));
  await writeFile(join(records, "messages.jsonl"), (options.messages ?? []).map((message, at) => `${JSON.stringify({ id: `m${at}`, ...message })}\n`).join(""));
  await mkdir(join(dir, "host", "lore"), { recursive: true });
  for (const entry of options.lore ?? []) await writeFile(join(dir, "host", "lore", `${entry.id}.json`), JSON.stringify(entry));
  await writeFile(join(dir, "host", "facts.json"), JSON.stringify({ defs: [], values: {} }));
  const handlers: Record<string, ToolHandler> = {};
  const manifest = Object.entries(options.tools ?? {}).map(([name, tool]) => {
    handlers[name] = tool.run;
    return { name, family: "fixture", tier: tool.tier, ...(tool.lane !== undefined ? { lane: tool.lane } : {}), description: tool.description, parameters: { type: "object", properties: {}, ...(tool.parameters ?? {}) } };
  });
  await writeFile(join(dir, "host", "tools.json"), JSON.stringify({ tools: manifest }));

  const clock = new FakeClock();
  const logged: Stage["logged"] = [];
  const host = await createFolderHost({ dir, user: USER, clock, log: recordingLog(logged), tools: handlers });
  hosted(host);
  const told: Stage["told"] = [];
  const views = options.views ?? {};
  // The folder host keeps the list and has no views of its own; the stage's host gives these.
  const events: TurnEvents = {
    ...host.events,
    async attachments(scope, agent, refs) {
      told.push({ kind: "attachments", agent, refs });
      await host.events.attachments(scope, agent, refs);
      return refs.flatMap((ref) => (!ref.own && Object.hasOwn(views, ref.ref) ? [{ name: ref.ref, text: views[ref.ref] ?? "" }] : []));
    },
    async consent(scope, grant) {
      told.push({ kind: "consent", grant });
      await host.events.consent(scope, grant);
    },
  };
  const trace = new TraceRecorder();
  const env: Environment = { ...host, store: options.store?.(host.store) ?? host.store, events, trace, ...(options.approvals !== undefined ? { approvals: options.approvals } : {}) };
  const models = Object.fromEntries(Object.entries(options.models).map(([name, answers]) => [name, scriptedModel(answers, { clock, id: name, contextWindow: 64_000, maxTokens: 4_000 })]));
  const source = scriptedSource(models);
  const hub = new LiveHub();
  const usage = new UsageBook(env.store, clock, env.log);
  const progress: string[] = [];
  /** Every play's agents at work, so a close stops each. */
  const plays: Set<{ runner: AgentRunner; work: Work }>[] = [];
  let next = 0;
  const ids = (): string => `id-${(next += 1)}`;

  async function play(message: string, turn = "t1"): Promise<Played> {
    const scope: Scope & { turn: string } = { user: USER, chat: CHAT, session: "s1", turn };
    await host.givePrompt(scope, { messages: [{ role: "user", content: message }] });
    const guidance = loadGuidance(env.files, scope);
    const settings = await readSettings(guidance, env.files, scope, env.log);
    const rules = await guidance.ruleRun({ facts: createFacts(env.facts, () => ({})), window: settings.ruleWindow });
    const run = new RunTrace(hub.tee(env.trace, scope), scope, turn, clock);
    run.watch((record) => usage.record(record));
    usage.begin(turn);
    hub.started({ run: turn, scope, what: "turn", agents: [], started: clock.now() });
    const budget = new Budget("turn", {});
    const [notices, goOn, closing, progressPart, places] = await Promise.all([guidance.part("tool-notices"), guidance.part("continue-after-rule"), guidance.tool("closing"), guidance.part("progress"), env.files.places(scope)]);
    const words: Words = (name, fields) => (notices?.format === "lines" ? notices.line(name, fields) : undefined);
    const closingText = templateText(closing)?.trimEnd();
    const texts: RunnerTexts = {
      continueAfterRule: (fields) => templateText(goOn, fields) ?? "",
      ...(closingText !== undefined ? { closing: closingText } : {}),
      notFound: (fields) => words("not_held", fields),
      invalid: (fields) => words("invalid", fields),
      cutShort: (fields) => words("cut_short", fields),
      failed: (fields) => words("failed", fields),
    };
    const working = new Set<{ runner: AgentRunner; work: Work }>();
    plays.push(working);
    const gateFor = (agent: AgentRef, parent: ParentCall | undefined, tools: readonly HeldTool[]): TurnGate =>
      new TurnGate({ scope, agent, ...(parent !== undefined ? { parent } : {}), trace: run, clock, files: env.files, ...(env.approvals !== undefined ? { approvals: env.approvals } : {}), places, rules, words, tools: new Map(tools.map((tool) => [tool.name, tool])), clipChars: 12_000 });
    let registry: Registry | undefined;
    const team = new Team({
      env,
      trace: run,
      guidance,
      ids,
      models: source,
      connection: connectionOf,
      hold: (names) => registry?.hold(names) ?? { tools: [], missing: [...names] },
      unregistered: (name, tools) => env.log.warn("Tools a sub-agent's definition lists are registered by nobody; it holds the rest.", { agent: name, tools: [...tools] }),
      gate: gateFor,
      texts: () => texts,
      rules: () => rules,
      budget: () => budget,
      settings: () => settings.subAgents,
      perCall: () => settings.perCall,
      track: (entry) => {
        working.add(entry);
        return () => working.delete(entry);
      },
      gauge: (agent, limits) => usage.gauge(scope, turn, agent.id, limits.contextWindow?.tokens ?? 0, limits.maxTokens?.tokens ?? 0),
      progress: (name, fields) => {
        const line = progressPart?.format === "lines" ? progressPart.line(name, fields) : undefined;
        if (line !== undefined) progress.push(line);
      },
      ...(options.point !== undefined ? { point: options.point } : {}),
    });
    const own = new Map<string, ToolText>();
    for (const name of ["file_read", "file_find", "file_write", ...AGENT_TOOLS]) {
      const text = toolText(await guidance.tool(name));
      if (text !== undefined) own.set(name, text);
    }
    const fileDeps: FileToolsDeps = { files: env.files, words, texts: own, most: settings.perCall };
    registry = new Registry([fileRead(fileDeps), fileFind(fileDeps), fileWrite(fileDeps), delegate(team, own.get("delegate")), askAuthor(team, own.get("ask_author")), agentMessage(team, own.get("agent_message"))], await env.tools.all(scope));

    const leadDefinition = await guidance.definition("lead");
    if (leadDefinition === undefined) throw new Error("The stage has no lead definition.");
    const lead: AgentRef = { id: ids(), definition: "lead" };
    const connection = await connectionOf(leadDefinition);
    const model = await source.agentModel(connection.choice);
    const held = registry.hold(leadDefinition.tools);
    const runner = new AgentRunner({
      agent: lead,
      trace: run,
      model: model.model,
      streamFn: model.streamFn,
      connection: connection.label,
      session: scope.session,
      thinkingLevel: model.thinkingLevel,
      instructions: leadDefinition.instructions.render().text.trimEnd(),
      tools: held.tools,
      texts,
      turn: budget,
      stream: rules.stream(lead),
      runEnd: rules.runEnd,
      gate: gateFor(lead, undefined, held.tools),
    });
    const work = runner.start({ messages: [userMessage(message, clock.now())] });
    const entry = { runner, work };
    working.add(entry);
    const done = work.done.finally(() => working.delete(entry));
    return {
      run: turn,
      lead,
      done,
      team,
      stop() {
        for (const { work: each } of working) each.stop();
      },
    };
  }

  let closing: Promise<void> | undefined;
  return {
    dir,
    host,
    env,
    clock,
    models,
    trace,
    hub,
    usage,
    told,
    progress,
    logged,
    play,
    async files() {
      const texts: string[] = [];
      for await (const path of new Bun.Glob("**/*").scan({ cwd: files, dot: true, onlyFiles: true })) texts.push(await readFile(join(files, path), "utf8"));
      return texts;
    },
    async kept(file) {
      const path = file === "events" ? join(records, "events.jsonl") : join(records, "turns", file.writes, "writes.jsonl");
      const text = await readFile(path, "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    close() {
      closing ??= (async () => {
        try {
          // Every agent still at work is stopped and its end waited for, and then the usage book's
          // writes to the day's totals are kept, as the harness's own close keeps them: a write
          // still under way, or one an agent's end starts, would land in the folder after it went.
          for (let left = plays.flatMap((working) => [...working]); left.length > 0; left = plays.flatMap((working) => [...working])) {
            for (const { work } of left) work.stop();
            await Promise.allSettled(left.map(({ work }) => work.done));
          }
          await usage.settled();
          await host.close();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      })();
      return closing;
    },
  };
}
