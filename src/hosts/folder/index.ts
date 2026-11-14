// The folder host (§13.6): a host for RPH over one directory and a tools manifest. It is what RPH's
// own tests run on, and it shows that a host other than RPE can give RPH an environment.
//
// The directory:
//
//   files/                                 the agents' tree (§5), its levels and kinds (view.ts)
//   host/chats/<chat>/chat.json            the chat: its character folder, preset, settings, named stretches
//   host/chats/<chat>/messages.jsonl       its active path, one message per line, oldest first
//   host/chats/<chat>/turns/<turn>/        the prompt given for a turn, where RPH found its slices, agents' writes
//   host/chats/<chat>/sessions/<session>/  the session's list of tools
//   host/chats/<chat>/events.jsonl         what RPH told the host
//   host/chats/<chat>/trace.jsonl          everything RPH did
//   host/lore/*.json                       lore entries, one per file
//   host/facts.json                        the facts the host declares, and their values by chat
//   host/tools.json                        the tools manifest, unless the host is given another
//   host/maps/<preset>.json                prompt maps, one per preset
//   host/models/, host/secrets/            the model layer's documents
//   host/store/                            small durable state
//   host/log.jsonl                         the log
//
// Not here: the host's other stores (`stores`), searchers for `gap_check` (none), the user's
// permissions per lane (`approvals`, so every lane is Auto), and running command tools.

import { join } from "node:path";
import type { Clock, Environment, Log, Scope } from "../../contract/index";
import packageJson from "../../../package.json";
import { fileLog, machineClock } from "./basics";
import { folderChat } from "./chat";
import { Appender, Serial, writeJson } from "./disk";
import { folderEvents } from "./events";
import { folderFacts } from "./facts";
import { folderFiles } from "./files";
import { folderLore } from "./lore";
import { folderModels } from "./models";
import { folderPrompt, promptPath } from "./prompt";
import type { GivenPrompt } from "./shape";
import { givenPrompt } from "./shape";
import { Site } from "./site";
import { folderStore } from "./store";
import type { ToolHandler } from "./tools";
import { folderTools } from "./tools";
import { folderTrace } from "./trace";

export type { GivenMessage, GivenPrompt } from "./shape";
export type { ToolHandler } from "./tools";

export interface FolderHostOptions {
  /** The directory. */
  dir: string;
  /** The one user the host serves; a scope of anyone else's is refused. */
  user: string;
  /** The tools manifest; `host/tools.json` in the directory when absent. */
  manifest?: string;
  /** What runs each of the manifest's tools, by name. */
  tools?: Readonly<Record<string, ToolHandler>>;
  /** The machine's clock when absent. */
  clock?: Clock;
  /** Lines of `host/log.jsonl` when absent. */
  log?: Log;
}

export interface FolderHost extends Environment {
  /** The directory. */
  readonly dir: string;
  /** Gives the host the prompt it received for a turn (`scope.turn`): what its prompt port lays out and its lore port says activated. */
  givePrompt(scope: Scope, prompt: GivenPrompt): Promise<void>;
  /** Waits for every trace event and log line given so far to be written. */
  close(): Promise<void>;
}

export async function createFolderHost(options: FolderHostOptions): Promise<FolderHost> {
  const site = new Site(options.dir, options.user);
  const clock = options.clock ?? machineClock;
  // A line the log cannot write has nowhere else to go but the process's own error stream.
  const appender = new Appender((path, error) => console.error(`The folder host could not write to ${path}:`, error));
  const log = options.log ?? fileLog(join(site.host, "log.jsonl"), appender, clock);
  const fileSerial = new Serial();
  const files = folderFiles(site, fileSerial);

  return {
    id: "folder",
    version: packageJson.version,
    dir: options.dir,
    files,
    chat: folderChat(site),
    lore: folderLore(site),
    prompt: folderPrompt(site, clock),
    tools: folderTools(site, files, options.manifest ?? join(site.host, "tools.json"), options.tools ?? {}, log),
    searchers: [],
    facts: await folderFacts(site),
    models: folderModels(site),
    store: folderStore(site),
    trace: folderTrace(site, appender, log),
    events: folderEvents(site, clock, fileSerial),
    clock,
    log,

    async givePrompt(scope, prompt) {
      await site.chat(scope);
      if (scope.turn === undefined) throw new Error("A prompt is given for a turn, and this scope names none.");
      const path = promptPath(site, scope.chat, scope.turn);
      await writeJson(path, givenPrompt(path, prompt));
    },

    close: () => appender.flush(),
  };
}
