// The folder host (§13.6): a host for RPH over one directory and a tools manifest. It is what RPH's
// own tests run on, and it shows that a host other than RPE can give RPH an environment.
//
// The directory:
//
//   files/                                 the agents' tree (§5), its levels and kinds (view.ts)
//   files/chats/<character>/<chat>/PROMPT-MAP.md, LORE-INDEX.md  generated: the map the chat runs under, the lore it is bound to
//   files/jobs/<hash>/                     a user's jobs of no chat: their notes and sessions
//   host/chats/<chat>/chat.json            the chat: its character folder, preset, settings, named stretches, its user, the lore it is bound to
//   host/chats/<chat>/messages.jsonl       its active path, one message per line, oldest first; a reply the command line kept names its turn (`turn`)
//   host/chats/<chat>/system.md            what a turn played from the command line (`rph-folder`, cli.ts) opens its prompt with: the preset and the card
//   host/chats/<chat>/turns/<turn>/        the prompt given for a turn, where RPH found its slices, agents' writes
//   host/chats/<chat>/sessions/<session>/  the session's list of tools
//   host/chats/<chat>/events.jsonl         what RPH told the host
//   host/chats/<chat>/trace.jsonl          everything RPH did; deltas/<run>.jsonl, each run's streamed text
//   host/chats/<chat>/asks/, answers/      a Confirm's question and its answer (approvals.ts)
//   host/lore/*.json                       lore entries, one per file
//   host/facts.json                        the facts the host declares, and their values by chat
//   host/tools.json                        the tools manifest, unless the host is given another; a tool naming `command` runs once switched on
//   host/maps/<preset>.json                prompt maps, one per preset
//   host/config.json                       the host's own limits (config.ts) and its web search's address (web.ts)
//   host/permissions.json                  each lane's Auto, Confirm or Never, by chat or `*` (approvals.ts)
//   host/switches.json                     what is switched on or off, the operator's alone (switches.ts)
//   host/stores/<store>/                   the other stores `archive_search` searches (stores.ts)
//   host/records/<name>/                   the searchers `gap_check` looks in, by folder (stores.ts)
//   host/user/<hash>/user.json             a user's folder is named by the SHA-256 of his name in hex, never by the name: two names never share a folder, whatever the disk's rule on case, and a name of any length or letters fits; the file keeps the name, checked when the folder is first used
//   host/user/<hash>/models/, secrets/     the model layer's documents, each user's in his own folder
//   host/user/<hash>/store/                small durable state, each user's in his own folder
//   host/user/<hash>/jobs/<started>~<id>.json  the store's typed part for job records, the file's name starting with the job's start so a page is read as a page
//   host/user/<hash>/events.jsonl, trace.jsonl, sessions/  a job of no chat's records
//   host/user/<name>/                      never read: folders made under the name itself are not this layout's, and only tests made them
//   host/log.jsonl                         the log
//
// It serves one user or several; a chat whose `chat.json` names its user is refused to anyone else.
// Two users' chats are told apart by their ids: one chat id is one chat.

import { join } from "node:path";
import type { Clock, Environment, Log, Scope } from "../../contract/index";
import { folderApprovals } from "./approvals";
import packageJson from "../../../package.json";
import { fileLog, machineClock } from "./basics";
import { folderChat } from "./chat";
import { Appender, Serial, writeJson } from "./disk";
import { folderEvents, putBack } from "./events";
import { NOTES_FOLDER } from "./view";
import { folderFacts } from "./facts";
import { folderFiles } from "./files";
import { folderLore } from "./lore";
import { folderModels } from "./models";
import { folderPrompt, promptPath } from "./prompt";
import type { GivenPrompt } from "./shape";
import { givenPrompt } from "./shape";
import { Site } from "./site";
import { folderStore } from "./store";
import { folderSearchers, folderStores } from "./stores";
import { folderSwitches } from "./switches";
import type { ToolHandler } from "./tools";
import { folderTools } from "./tools";
import { folderTrace } from "./trace";
import { folderWeb } from "./web";

export type { GivenMessage, GivenPrompt } from "./shape";
export type { ToolHandler } from "./tools";

export interface FolderHostOptions {
  /** The directory. */
  dir: string;
  /** The users the host serves (one, or several); a scope of anyone else's is refused. The first is whom its command line acts for. */
  user: string | readonly string[];
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
  /** A turn left the path (a swipe, a delete): the notes agents wrote in it read as they stood before it, save one changed since. The host tells RPH too (`Harness.turnLeft`). */
  turnLeft(scope: Scope): Promise<{ restored: string[]; kept: string[] }>;
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
  const switches = folderSwitches(site);

  return {
    id: "folder",
    version: packageJson.version,
    dir: options.dir,
    files,
    chat: folderChat(site),
    lore: folderLore(site),
    prompt: folderPrompt(site, clock),
    stores: folderStores(site),
    tools: folderTools(site, files, options.manifest ?? join(site.host, "tools.json"), options.tools ?? {}, log, switches),
    searchers: await folderSearchers(site),
    web: folderWeb(site),
    approvals: folderApprovals(site),
    switches,
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

    async turnLeft(scope) {
      await site.chat(scope);
      if (scope.turn === undefined) throw new Error("A turn leaves the path, and this scope names none.");
      return putBack(site, fileSerial, scope, scope.turn, (line) => line.path.startsWith(`${NOTES_FOLDER}/`));
    },

    close: () => appender.flush(),
  };
}
