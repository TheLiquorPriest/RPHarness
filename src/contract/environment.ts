// What a host gives RPH: its environment (Appendix A). RPE is one host; the folder host is another.
//
// The contract carries means and facts. It has no call by which a host makes an agent do a step of
// a turn, and none by which RPH asks a host whether an agent may take one, but `approvals`: the
// user's own word on a write to a lane set to Confirm.

import type { ApprovalsPort } from "./approvals";
import type { ChatPort } from "./chat";
import type { Clock, Log } from "./common";
import type { TurnEvents } from "./events";
import type { FactsPort } from "./facts";
import type { FilesPort } from "./files";
import type { LorePort } from "./lore";
import type { ModelsPort } from "./models";
import type { PromptPort } from "./prompt";
import type { StorePort } from "./store";
import type { Searcher, StoresPort } from "./stores";
import type { ToolsPort } from "./tools";
import type { TracePort } from "./trace";

export interface Environment {
  /** The host's name (`rpe`, `folder`), in traces and logs. */
  readonly id: string;
  /** The host's version, in traces and logs. */
  readonly version: string;
  /** The jailed file tree, in its three kinds; where guidance is loaded from (§5). */
  files: FilesPort;
  /** History: read, search; hidden and summarized messages marked. */
  chat: ChatPort;
  /** Entries from every source the host has: read, search, what activated. */
  lore: LorePort;
  /** The raw layout of each assembled prompt; where prompt maps are kept. RPH finds the slices, inside `answer()`. */
  prompt: PromptPort;
  /** Databanks, the chat application's memory, summaries. */
  stores?: StoresPort;
  /** The host's own tools. */
  tools: ToolsPort;
  /** What `gap_check` searches besides chat and lore; none is a fine answer. */
  searchers: Searcher[];
  /** Named facts of the moment that rules may test and the briefing may show. */
  facts: FactsPort;
  /** Where the model layer's connections and secrets are kept. */
  models: ModelsPort;
  /** Small durable state: jobs, approvals, token counts. */
  store: StorePort;
  /** Everything RPH does, as events. */
  trace: TracePort;
  /** RPH tells the host what happened. */
  events: TurnEvents;
  /** The user's Auto / Confirm / Never per lane, and the user's answer when it is Confirm. Without it, every lane is Auto. */
  approvals?: ApprovalsPort;
  clock: Clock;
  log: Log;
}
