// What a host gives RPH: its environment (Appendix A). RPE is one host; the folder host is another.
//
// The contract carries means and facts. It has no call by which a host makes an agent do a step of
// a turn, and none by which RPH asks a host whether an agent may take one, but `approvals`: the
// user's own word on a write to a lane set to Confirm.

import type { ApprovalsPort } from "./approvals";
import type { ChatPort } from "./chat";
import type { AgentRef, Clock, Log, Scope } from "./common";
import type { TurnEvents } from "./events";
import type { FactsPort } from "./facts";
import type { FilesPort } from "./files";
import type { JsonObject } from "./json";
import type { LorePort } from "./lore";
import type { ModelsPort } from "./models";
import type { PromptPort } from "./prompt";
import type { StorePort } from "./store";
import type { Searcher, StoresPort, WebSearchPort } from "./stores";
import type { SwitchesPort } from "./switches";
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
  /** The web searcher `web_search` goes through; `web_search` is held without it too, and answers that it is off until one is on. */
  web?: WebSearchPort;
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
  /** Whether each thing that runs a command or calls out is switched on from the host's own command line (§16). Without it, every such thing is off. */
  switches?: SwitchesPort;
  /** What a person calls an agent, in the lines a person reads. Without it, an agent is named by its definition's name. */
  names?: NamesPort;
  /**
   * The host's own setting keys, as its `SettingDef.key` writes them (`turn.passConnection`), read from
   * the same config files as RPH's. A host's keys share groups with RPH's, so RPH, which logs each key
   * in a section of its own that names none of its settings, passes these over. Without it, every key
   * in RPH's sections that is not RPH's is logged.
   */
  readonly settingKeys?: readonly string[];
  clock: Clock;
  log: Log;
}

/**
 * What a person calls an agent (§10.7): the fields that name it in the lines a person reads, the progress lines among them, as the
 * host names it in its own (its thinking block's headings, its pages). `nth` is which of the turn's agents of its definition, playing
 * the same, it is, counted from 1 in the order they were first named; a line has it as its own field `nth` where it is above 1.
 */
export interface NamesPort {
  agent(scope: Scope, agent: AgentRef, nth: number): JsonObject;
}
