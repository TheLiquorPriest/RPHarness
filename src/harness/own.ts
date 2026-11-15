// RPH's own tools (§6), each described by its file in `.tools/`: made for a turn's agents, and made
// for a page that lists what an agent holds (its stack on the Files page), where none of them runs.
import { AGENT_TOOLS, agentDrop, agentMessage, askAuthor, delegate, type TeamWork } from "../agents";
import type { Environment } from "../contract";
import type { Guidance } from "../files/api";
import { JOB_START, jobStart, type JobsWork } from "../jobs/tool";
import { JOB_SEARCHED, jobTools } from "../jobs/tools";
import { PROMPT_TOOLS, promptMapWrite, promptTool, type TurnPrompt } from "../prompt";
import { fileFind, fileRead, type FileToolsDeps, fileWrite, type OwnTool, replyRelease, type ReplyWork, todo, type TodoDeps, TodoLists, type ToolText, type Words, writeReply } from "../tools";
import { BASE_TOOLS, baseTools } from "../tools/base";
import { SEARCH_TOOLS, searchTools, type ToolReach } from "../tools/search";
import { toolTextOf } from "./means";
import type { Settings } from "./settings";

/** RPH's own tools a turn's agents may hold: the sub-agents', the base tools, tool search, `job_start`, the job tools behind the search and the prompt map's among them. */
export const OWN_TOOLS = ["file_read", "file_find", "file_write", "todo", "write_reply", "reply_release", ...AGENT_TOOLS, ...BASE_TOOLS, ...SEARCH_TOOLS, JOB_START, ...JOB_SEARCHED, ...PROMPT_TOOLS] as const;

/** Each own tool's file as it is in force, by the tool's name: a tool whose file is not there has none. */
export async function ownTexts(guidance: Pick<Guidance, "tool">): Promise<Map<string, ToolText>> {
  const texts = new Map<string, ToolText>();
  for (const [name, part] of await Promise.all(OWN_TOOLS.map(async (name) => [name, await guidance.tool(name)] as const))) {
    const text = toolTextOf(part);
    if (text !== undefined) texts.set(name, text);
  }
  return texts;
}

/** What RPH's own tools work through, for one turn. */
export interface OwnToolsDeps {
  env: Environment;
  guidance: Guidance;
  texts: ReadonlyMap<string, ToolText>;
  settings: Settings;
  /** The tool answers' lines. */
  words: Words;
  todos: TodoLists;
  todoChanged: TodoDeps["changed"];
  /** A file tool's write went through. */
  written: NonNullable<FileToolsDeps["written"]>;
  reply: ReplyWork;
  team: TeamWork;
  jobs: JobsWork;
  ids(): string;
  /** The turn's prompt, when it carries one. */
  prompt(): Promise<TurnPrompt | undefined>;
  /** What an agent may reach by searching, and the runner that runs a found tool as the agent. */
  reach: ToolReach;
}

export function ownTools(d: OwnToolsDeps): OwnTool[] {
  const { env, guidance, texts, settings } = d;
  const fileDeps: FileToolsDeps = { files: env.files, words: d.words, texts, most: settings.perCall, written: d.written };
  return [
    fileRead(fileDeps),
    fileFind(fileDeps),
    fileWrite(fileDeps),
    todo({ lists: d.todos, words: d.words, text: texts.get("todo"), changed: d.todoChanged }),
    writeReply(d.reply, texts.get("write_reply")),
    replyRelease(d.reply, texts.get("reply_release")),
    delegate(d.team, texts.get("delegate")),
    askAuthor(d.team, texts.get("ask_author")),
    agentMessage(d.team, texts.get("agent_message")),
    agentDrop(d.team, texts.get("agent_drop")),
    jobStart(d.jobs, texts.get(JOB_START), settings.jobs.perRun),
    ...jobTools(d.jobs, texts, settings.perCall),
    ...baseTools({ env, guidance, texts, ids: () => d.ids(), gapHits: settings.gapHits, perCall: settings.perCall, ...(env.web !== undefined ? { web: env.web } : {}) }),
    promptTool({ prompt: () => d.prompt(), guidance, texts, env }),
    promptMapWrite({ prompt: () => d.prompt(), guidance, texts, env, signatureHead: settings.signatureHead }),
    ...searchTools({
      reach: d.reach,
      ...(env.switches !== undefined ? { switches: env.switches } : {}),
      guidance,
      schemaShown: settings.schemaShown,
      notices: d.words,
      texts,
      hits: settings.searchHits,
    }),
  ];
}

/**
 * RPH's own tools as a page lists them (§5.2: an agent's stack holds each held tool's description and
 * its family's guide): their names, families and descriptions as a turn would make them. Nothing a
 * page does runs one, so what a run would work through is not there.
 */
export function listedTools(env: Environment, guidance: Guidance, texts: ReadonlyMap<string, ToolText>, settings: Settings, jobs: JobsWork): OwnTool[] {
  const never = (): never => {
    throw new Error("A tool made for a page's list was run.");
  };
  return ownTools({
    env,
    guidance,
    texts,
    settings,
    words: () => undefined,
    todos: new TodoLists(),
    todoChanged: () => undefined,
    written: async () => undefined,
    reply: { write: never, release: never },
    team: { delegate: never, ask: never, message: never, drop: never },
    jobs,
    ids: never,
    prompt: async () => undefined,
    reach: { of: never, run: never },
  });
}
