// A stage for whole turns: the folder host over a made folder, RPH's own shipped files as its
// lowest level, the drafted guidance laid over them when a test asks (copies in `fixtures/drafted/`,
// the files a real turn loads), one scripted model for every agent, and recorders for what the host
// is told, the trace and the log. Everything else here is invented.
//
// The turns run on the rig's clock without moving it: a scripted answer that must wait holds at a
// gate the test opens, so nothing depends on how long the disk takes.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApprovalsPort, Environment, FilesPort, Harness, JsonValue, Log, PromptMessage, ReplyError, Scope, ToolResult, TraceRecord, TurnEvents, TurnOutcome, TurnRequest, Usage } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import { createFolderHost, type FolderHost, type ToolHandler } from "../../src/hosts/folder";
import { createHarness, SHIPPED_GUIDANCE } from "../../src/index";
import { type Answer, FakeClock, scriptedModel, type ScriptedModel } from "../../src/testing/rig";
import { SinkRecorder, textOf, TraceRecorder } from "../loop/support";

export { gate, type RecordedRequest } from "../../src/testing/rig";
export { textOf } from "../loop/support";

/** Something a test waits for: resolved the first time `holds` is true after a change. */
class Waits {
  readonly #waiting: { holds: () => boolean; done: () => void }[] = [];

  until(holds: () => boolean): Promise<void> {
    if (holds()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waiting.push({ holds, done: resolve });
    return promise;
  }

  changed(): void {
    for (const waiting of this.#waiting.splice(0)) {
      if (waiting.holds()) waiting.done();
      else this.#waiting.push(waiting);
    }
  }
}

/** A reply sink that records, and that a test can wait on: `until` resolves once what reached it holds. */
export class WatchedSink extends SinkRecorder {
  readonly #waits = new Waits();

  until(holds: () => boolean): Promise<void> {
    return this.#waits.until(holds);
  }

  override progress(line: string): void {
    super.progress(line);
    this.#waits.changed();
  }

  override content(delta: string): void {
    super.content(delta);
    this.#waits.changed();
  }

  override finish(usage: Usage): void {
    super.finish(usage);
    this.#waits.changed();
  }

  override error(e: ReplyError): void {
    super.error(e);
    this.#waits.changed();
  }
}

/** A trace that records, and that a test can wait on for a record. */
export class WatchedTrace extends TraceRecorder {
  readonly #waits = new Waits();

  /** Resolves once a record that `matches` has come. */
  seen(matches: (record: TraceRecord) => boolean): Promise<void> {
    return this.#waits.until(() => this.records.some(matches));
  }

  override event(record: TraceRecord): void {
    super.event(record);
    this.#waits.changed();
  }
}

export const USER = "reader";
export const CHARACTER = "wren-hale";
export const CHAT = "lighthouse";

/** An invented assembled prompt: the preset and the card first, history, a note at depth in the middle, and the player's newest message. */
export const PROMPT: PromptMessage[] = [
  { role: "system", content: "Fixture preset: write in the second person, present tense, two paragraphs at most." },
  { role: "system", content: "Fixture card: Wren Hale keeps the lighthouse on Gannet Rock." },
  { role: "assistant", content: "The lamp turns above you; the sea is loud tonight." },
  { role: "user", content: "I climb the stairs to the lamp room." },
  { role: "assistant", content: "Wren is already up there, polishing the brass." },
  { role: "system", content: "Fixture note at depth: the storm breaks within the hour." },
  { role: "user", content: "I ask Wren whether the supply boat came." },
];

/** A tool the host registers, and what runs it. */
export interface HostToolFixture {
  tier: "read" | "write" | "external";
  lane?: string;
  family?: string;
  description: string;
  parameters?: Record<string, JsonValue>;
  run: ToolHandler;
}

export interface StageOptions {
  /** Lay the drafted guidance over RPH's own files, as RPE's shipped files would be. */
  drafted?: boolean;
  /** The global level's config file. */
  config?: string;
  /** Every model call's answer, in order, whichever agent makes it. */
  answers: Answer[];
  /** Model calls go through the model layer, on the connections the host keeps, over this fetch, in place of the scripted model. */
  fetch?: typeof globalThis.fetch;
  tools?: Record<string, HostToolFixture>;
  approvals?: ApprovalsPort;
  /** More files, by their path under the agents' tree on disk (`files/`). */
  files?: Record<string, string>;
  /** How the host is told each thing: tests can hold one back. */
  events?: (inner: TurnEvents) => TurnEvents;
  /** How the agents' files are read and written: tests can hold a read back. */
  filesPort?: (inner: FilesPort) => FilesPort;
  /** Each time an agent's model is asked for, by its count from 1: a test can hold the answer back. */
  modelAsked?: (count: number) => void | Promise<void>;
}

export interface Stage {
  dir: string;
  host: FolderHost;
  env: Environment;
  clock: FakeClock;
  model: ScriptedModel;
  harness: Harness;
  trace: WatchedTrace;
  /** What the host was told, in order. */
  told: { kind: keyof TurnEvents; scope: Scope; payload: unknown }[];
  /** The log's lines. */
  logged: { level: string; message: string; fields?: Record<string, JsonValue> }[];
  /** A shared record of what happened, in order: what the host was told and which tools ran. */
  order: string[];
  /** Answers one turn and waits for the lead's run to end. */
  turn(req: TurnRequest, sink?: WatchedSink, signal?: AbortSignal): Promise<{ outcome: TurnOutcome; sink: WatchedSink }>;
  /** Every file of the agents' tree, as text: what a turn could have loaded. */
  files(): Promise<string[]>;
  close(): Promise<void>;
}

/** One turn's request, with the stage's chat and the fixture prompt. */
export function request(turn: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return { scope: { user: USER, chat: CHAT, session: "s1", turn }, kind: "new", lead: "author", prompt: PROMPT, briefing: [], carry: "nothing", since: [], ...extra };
}

const DRAFTED = join(import.meta.dir, "fixtures", "drafted");

/** A tool's answer in plain text. */
export function said(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function recordingLog(logged: Stage["logged"]): Log {
  const line = (level: string) => (message: string, fields?: Record<string, JsonValue>) => {
    logged.push({ level, message, ...(fields !== undefined ? { fields } : {}) });
  };
  return { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") };
}

export async function stage(options: StageOptions): Promise<Stage> {
  const dir = await mkdtemp(join(tmpdir(), "rph-harness-"));
  const files = join(dir, "files");
  const shipped = join(files, "defaults");
  await cp(SHIPPED_GUIDANCE, shipped, { recursive: true });
  if (options.drafted === true) await cp(DRAFTED, shipped, { recursive: true });
  await mkdir(join(files, "chats", CHARACTER, CHAT), { recursive: true });
  if (options.config !== undefined) await writeFile(join(files, "config.yml"), options.config, "utf8");
  for (const [path, text] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(files, path)), { recursive: true });
    await writeFile(join(files, path), text, "utf8");
  }
  const records = join(dir, "host", "chats", CHAT);
  await mkdir(records, { recursive: true });
  await writeFile(join(records, "chat.json"), JSON.stringify({ character: CHARACTER, preset: { id: "fixture-preset", name: "Fixture preset" } }));
  await writeFile(join(dir, "host", "facts.json"), JSON.stringify({ defs: [], values: {} }));
  const handlers: Record<string, ToolHandler> = {};
  const manifest = Object.entries(options.tools ?? {}).map(([name, tool]) => {
    handlers[name] = tool.run;
    return { name, family: tool.family ?? "fixture", tier: tool.tier, ...(tool.lane !== undefined ? { lane: tool.lane } : {}), description: tool.description, parameters: { type: "object", properties: {}, ...(tool.parameters ?? {}) } };
  });
  await writeFile(join(dir, "host", "tools.json"), JSON.stringify({ tools: manifest }));

  const clock = new FakeClock();
  const logged: Stage["logged"] = [];
  const order: string[] = [];
  const host = await createFolderHost({ dir, user: USER, clock, log: recordingLog(logged), tools: handlers });
  const told: Stage["told"] = [];
  const recorded = (inner: TurnEvents): TurnEvents => {
    const tell = <K extends keyof TurnEvents>(kind: K, scope: Scope, payload: unknown, then: () => ReturnType<TurnEvents[K]>): ReturnType<TurnEvents[K]> => {
      told.push({ kind, scope, payload });
      order.push(`told:${kind}`);
      return then();
    };
    return {
      intent: (scope, text) => tell("intent", scope, text, () => inner.intent(scope, text)),
      attachments: (scope, agent, refs) => tell("attachments", scope, refs, () => inner.attachments(scope, agent, refs)),
      consent: (scope, grant) => tell("consent", scope, grant, () => inner.consent(scope, grant)),
      gapCheck: (scope, check) => tell("gapCheck", scope, check, () => inner.gapCheck(scope, check)),
      dropStaged: (scope, agent) => tell("dropStaged", scope, agent, () => inner.dropStaged(scope, agent)),
      ruleFired: (scope, firing) => tell("ruleFired", scope, firing, () => inner.ruleFired(scope, firing)),
      suggestion: (scope, agent, suggestion) => tell("suggestion", scope, suggestion, () => inner.suggestion(scope, agent, suggestion)),
      released: (scope, release) => tell("released", scope, release, () => inner.released(scope, release)),
      ended: (scope, outcome) => tell("ended", scope, outcome, () => inner.ended(scope, outcome)),
    };
  };
  const events = recorded(options.events !== undefined ? options.events(host.events) : host.events);
  const trace = new WatchedTrace();
  const env: Environment = { ...host, files: options.filesPort?.(host.files) ?? host.files, events, trace, ...(options.approvals !== undefined ? { approvals: options.approvals } : {}) };
  const model = scriptedModel(options.answers, { clock, contextWindow: 64_000, maxTokens: 4_000 });
  let next = 0;
  let asked = 0;
  const scripted = {
    agentModel: async () => {
      asked += 1;
      await options.modelAsked?.(asked);
      return model.agentModel();
    },
  };
  const harness = createHarness(env, { ...(options.fetch !== undefined ? { fetch: options.fetch } : { models: scripted }), ids: () => `id-${(next += 1)}` });

  return {
    dir,
    host,
    env,
    clock,
    model,
    harness,
    trace,
    told,
    logged,
    order,
    async turn(req, sink = new WatchedSink(clock), signal = new AbortController().signal) {
      await host.givePrompt(req.scope, { messages: req.prompt });
      const outcome = await harness.answer(req, sink, signal);
      return { outcome, sink };
    },
    async files() {
      const texts: string[] = [];
      for await (const path of new Bun.Glob("**/*").scan({ cwd: files, dot: true, onlyFiles: true })) texts.push(await readFile(join(files, path), "utf8"));
      return texts;
    },
    async close() {
      await harness.close();
      await host.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The reply contract in force on a stage, rendered by its own file for a form: what the lead's opening block holds. */
export async function contractFor(s: Stage, form: "tags" | "two_step"): Promise<string> {
  const part = await loadGuidance(s.env.files, request("t1").scope).part("reply-contract");
  if (part?.format !== "template") throw new Error("The stage has no reply contract.");
  return part.render({ form: { [form]: true } }).text.trimEnd();
}

/** Put in place of the reply contract's field in RPH's own briefing template. */
export const CONTRACT_MARK = "FIXTURE-CONTRACT-MARK";

/**
 * The briefing the lead's first call ends on, under RPH's own briefing template with the mark in
 * place of its reply contract's field: the briefing as its template lays it out around the
 * contract, whatever its words.
 */
export async function briefingAround(config?: string): Promise<string> {
  const shipped = await Bun.file(join(SHIPPED_GUIDANCE, ".prompts", "briefing.md")).text();
  if (!shipped.includes("{{reply_contract}}")) throw new Error("RPH's own briefing template shows no reply contract.");
  const s = await stage({ ...(config !== undefined ? { config } : {}), files: { ".prompts/briefing.md": shipped.replace("{{reply_contract}}", CONTRACT_MARK) }, answers: [{ pieces: [{ text: "<reply>No boat tonight.</reply>" }] }] });
  try {
    await s.turn(request("t1", { lead: "lead" }));
    return textOf(s.model.requests[0]!.messages.at(-1)!);
  } finally {
    await s.close();
  }
}
