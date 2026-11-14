// The user's settings a turn is run under (§10.11, Appendix D.1), from the config files of the
// chat's levels, the nearer level's value over the farther one's. Each is a setting with a
// default; the defaults are here and nowhere else. A value that is not one the setting takes is
// logged with its file and passed over, and the default holds; it never stops a turn.
//
// The keys, in each level's config file (YAML):
//
//   limits:
//     turn:
//       calls: 40                      model calls across every agent of one turn; ~ for no limit
//       tokensIn: …, tokensOut: …      tokens across every agent of one turn
//       time: …                        seconds for the whole turn
//       depth: 2                       how deep a sub-agent may stand: 1, the lead's own; 2, the ones they start too; 0, none
//       agents: 24                     sub-agents one turn may start in all; ~ for no limit
//   reply:
//     form: tags                       how a connection marks its reply: tags, or two-step
//     forms: { <connection>: two-step } the same for one connection, by its name or its id
//     streamAnyway: [<connection>]     a two-step connection whose replies stream as they are written
//     heldSentences: 1                 sentences held back while a rule that interrupts covers the reply
//     tailSentences: 3                 sentences of what was shown that go with the line an agent goes on under
//     leadSampling: own                the lead's sampling: its own, or the preset's
//     intentWait: 2                    seconds a tool or the reply waits, at most, for the host to take
//                                      the intent record written before it; 0 waits for nothing
//   progress:
//     show: all                        all the progress lines, or least: only the line that keeps a silent turn alive
//     silence: 60                      seconds of nothing shown before that line
//   results:
//     clip: 12000                      characters of a tool's result the model reads; the rest is kept in a file
//   tools:
//     search: 8                        tools one tool_search gives when the agent names no limit
//     gapCheck: 20                     hits gap_check takes from each place when the agent names no limit
//     perCall: 100                     the most one tool call takes: messages chat_read gives, entries
//                                      lore_read reads, hits a search asks each place for and keeps,
//                                      and messages a stretch of the chat an agent is given holds
//   rules:
//     window: 500                      characters a rule's pattern looks at at a time: the newest of what is
//                                      written, and stretches of a tool's arguments or result
//   effort:
//     connections: { <connection>: high } the effort every agent on a connection thinks at, by the connection's
//                                      name or its id, whatever its definition says: off, minimal, low,
//                                      medium, high, xhigh or max; none by default
//   trace:
//     requests: first                  which calls' requests are kept in the turn's folder, each message
//                                      as role and text: first (each agent's first call), all, or none

import type { Effort, FilesPort, JsonValue, Log, Scope } from "../contract";
import type { Guidance } from "../files/api";
import { REPLY_DEFAULTS } from "../reply/defaults";
import { GAP_HITS } from "../tools/base";
import { SEARCH_HITS } from "../tools/search";

export type ReplyFormSetting = "tags" | "two-step";

/** Which model calls have what they were sent kept in the turn's folder: each agent's first, every one, or none. */
export type RequestsSetting = "first" | "all" | "none";

/** Every effort a definition's `effort:` takes, which `effort.connections` takes too. */
const EFFORTS: Record<Effort, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };

/** The user's limits on sub-agents (§10.11: "sub-agent depth and count ... every one is a setting"). */
export interface AgentSettings {
  /** How deep a sub-agent may stand: the lead's own stand at 1, the ones they start at 2. 0: none is started. */
  depth: number;
  /** Sub-agents one turn may start in all; absent is no limit. */
  agents?: number;
}

export interface Settings {
  /** Limits shared by every agent of one turn; each absent is no limit. `time` in milliseconds. */
  turn: { calls?: number; tokensIn?: number; tokensOut?: number; time?: number };
  subAgents: AgentSettings;
  /** The form every connection's reply takes, unless `forms` names the connection. */
  form: ReplyFormSetting;
  forms: Readonly<Record<string, ReplyFormSetting>>;
  /** Two-step connections whose replies stream anyway, by name or id. */
  streamAnyway: readonly string[];
  heldSentences: number;
  tailSentences: number;
  leadSampling: "own" | "preset";
  /** How long, in milliseconds, a tool or the reply waits at most for the host to take the intent record. */
  intentWaitMs: number;
  progress: "all" | "least";
  silenceMs: number;
  clipChars: number;
  /** Tools one `tool_search` gives when the agent names no limit. */
  searchHits: number;
  /** Hits `gap_check` takes from each place when the agent names no limit. */
  gapHits: number;
  /** The most one tool call takes: messages, entries, or hits from each place searched; a stretch of the chat an agent is given too. */
  perCall: number;
  /** Characters a rule's pattern looks at at a time. */
  ruleWindow: number;
  /** The effort agents on a connection think at, by the connection's name or id, over their definitions'. */
  efforts: Readonly<Record<string, Effort>>;
  /** Which calls' requests are kept in the turn's folder. */
  requests: RequestsSetting;
}

/** The defaults, where no level sets a value. */
export const DEFAULT_SETTINGS: Settings = {
  // Appendix D.1: calls in a turn across all agents, at most 40.
  turn: { calls: 40 },
  // Today's build's own (LumiAH's `delegation.depth` and `delegation.perRun`), kept as §10.11 says.
  subAgents: { depth: 2, agents: 24 },
  // Appendix D.1: by tags, in two steps where a connection was measured not to keep them.
  form: "tags",
  forms: {},
  streamAnyway: [],
  heldSentences: REPLY_DEFAULTS.heldSentences,
  tailSentences: REPLY_DEFAULTS.tailSentences,
  // The host takes an intent record in the same process, in milliseconds: this is room for a slow
  // disk, and short enough that a host that stalls costs a reply no more than a moment.
  intentWaitMs: 2_000,
  // Appendix D.1: the lead's sampling is its own.
  leadSampling: "own",
  // Appendix D.1: progress lines in the thinking block.
  progress: "all",
  silenceMs: REPLY_DEFAULTS.silenceMs,
  // A long message of a story, or a lore entry, runs from 6,000 to 12,000 characters, and an agent should read one in one go.
  clipChars: 12_000,
  // Tool search's own (`SEARCH_HITS`): a handful an agent reads at a glance.
  searchHits: SEARCH_HITS,
  // The gap check's own (`GAP_HITS`): about the characters of a result the model reads whole, over three places.
  gapHits: GAP_HITS,
  // The longest stretch the history window holds under Appendix D.1's settings (40 messages, a step
  // of 20, and 40 more held for the story's record), and five times the hits a gap check takes from
  // a place by default.
  perCall: 100,
  // Wide enough for any phrase a rule looks for, with room to spare; narrow enough that a pattern of
  // the kinds the rules let in takes at most some tens of milliseconds on it.
  ruleWindow: 500,
  // None: each agent thinks at the effort its definition gives, or its model's own.
  efforts: {},
  // What the floor test and the Turn page read (§17.1: the Author's first request), at one file per agent a turn.
  requests: "first",
};

type Mapping = { [key: string]: JsonValue };

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Two configs as one: the nearer one's values over the farther one's, mapping by mapping. */
function merged(far: Mapping, near: Mapping): Mapping {
  const out: Mapping = { ...far };
  for (const [key, value] of Object.entries(near)) {
    const before = out[key];
    out[key] = isMapping(before) && isMapping(value) ? merged(before, value) : value;
  }
  return out;
}

/** The config of a scope, every level's file read and merged, farthest first. */
async function configOf(guidance: Guidance, files: FilesPort, scope: Scope, log: Log): Promise<{ config: Mapping; from: string }> {
  let config: Mapping = {};
  const paths: string[] = [];
  for (const layer of await guidance.layers()) {
    if (layer.config === undefined) continue;
    const path = `${layer.mount}${layer.config}`;
    const read = await files.read(scope, path);
    if (read.status !== "read" || read.text.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(read.text);
    } catch (error) {
      log.warn("A config file does not parse; the harness's settings in it are passed over.", { path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (parsed === null || parsed === undefined) continue;
    if (!isMapping(parsed)) {
      log.warn("A config file is not a mapping of keys; the harness's settings in it are passed over.", { path });
      continue;
    }
    config = merged(config, parsed);
    paths.push(path);
  }
  return { config, from: paths.join(", ") };
}

/** The settings of a scope, as its config files set them over the defaults. */
export async function readSettings(guidance: Guidance, files: FilesPort, scope: Scope, log: Log): Promise<Settings> {
  const { config, from } = await configOf(guidance, files, scope, log);
  const passed = (key: string, value: JsonValue | undefined): void => {
    log.warn("A setting has a value it does not take; its default holds.", { setting: key, value: value ?? null, files: from });
  };
  const section = (key: string): Mapping => {
    const value = config[key];
    if (value === undefined) return {};
    if (isMapping(value)) return value;
    passed(key, value);
    return {};
  };
  /** A whole number above 0, or undefined (with a log line) for any other value. */
  const count = (key: string, value: JsonValue | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    passed(key, value);
    return undefined;
  };
  /** A whole number, 0 or more, or undefined (with a log line) for any other value. */
  const whole = (key: string, value: JsonValue | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    passed(key, value);
    return undefined;
  };
  const oneOf = <T extends string>(key: string, value: JsonValue | undefined, allowed: readonly T[]): T | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    passed(key, value);
    return undefined;
  };

  const limits = section("limits");
  const turnValue = limits["turn"];
  const turn = isMapping(turnValue) ? turnValue : {};
  if (turnValue !== undefined && !isMapping(turnValue)) passed("limits.turn", turnValue);
  // `calls: ~` (null) lifts the limit; a value it does not take leaves the default.
  const callsValue = turn["calls"];
  const calls = callsValue === undefined ? DEFAULT_SETTINGS.turn.calls : callsValue === null ? undefined : (count("limits.turn.calls", callsValue) ?? DEFAULT_SETTINGS.turn.calls);
  const tokensIn = count("limits.turn.tokensIn", turn["tokensIn"]);
  const tokensOut = count("limits.turn.tokensOut", turn["tokensOut"]);
  const seconds = count("limits.turn.time", turn["time"]);
  // `depth: 0` and `agents: 0` start no sub-agent at all; `agents: ~` (null) lifts that limit.
  const depth = whole("limits.turn.depth", turn["depth"]) ?? DEFAULT_SETTINGS.subAgents.depth;
  const agentsValue = turn["agents"];
  const agents = agentsValue === null ? undefined : (whole("limits.turn.agents", agentsValue) ?? DEFAULT_SETTINGS.subAgents.agents);

  const reply = section("reply");
  const forms: Record<string, ReplyFormSetting> = {};
  const formsValue = reply["forms"];
  if (isMapping(formsValue)) {
    for (const [connection, value] of Object.entries(formsValue)) {
      const form = oneOf<ReplyFormSetting>(`reply.forms.${connection}`, value, ["tags", "two-step"]);
      if (form !== undefined) forms[connection] = form;
    }
  } else if (formsValue !== undefined) passed("reply.forms", formsValue);
  const streamValue = reply["streamAnyway"];
  const streamAnyway = Array.isArray(streamValue) ? streamValue.filter((name): name is string => typeof name === "string") : [];
  if (streamValue !== undefined && !Array.isArray(streamValue)) passed("reply.streamAnyway", streamValue);
  const heldSentences = whole("reply.heldSentences", reply["heldSentences"]) ?? DEFAULT_SETTINGS.heldSentences;
  const intentWait = whole("reply.intentWait", reply["intentWait"]);

  const progress = section("progress");
  const silence = count("progress.silence", progress["silence"]);
  const results = section("results");
  const tools = section("tools");
  const rules = section("rules");
  const trace = section("trace");
  // Not under `models`: a host keeps the model layer's connections there, and saving one rewrites that key whole.
  const effort = section("effort");
  const efforts: Record<string, Effort> = {};
  const connectionsValue = effort["connections"];
  if (isMapping(connectionsValue)) {
    for (const [connection, value] of Object.entries(connectionsValue)) {
      const named = oneOf<Effort>(`effort.connections.${connection}`, value, Object.keys(EFFORTS) as Effort[]);
      if (named !== undefined) efforts[connection] = named;
    }
  } else if (connectionsValue !== undefined) passed("effort.connections", connectionsValue);

  return {
    turn: {
      ...(calls !== undefined ? { calls } : {}),
      ...(tokensIn !== undefined ? { tokensIn } : {}),
      ...(tokensOut !== undefined ? { tokensOut } : {}),
      ...(seconds !== undefined ? { time: seconds * 1000 } : {}),
    },
    subAgents: { depth, ...(agents !== undefined ? { agents } : {}) },
    form: oneOf<ReplyFormSetting>("reply.form", reply["form"], ["tags", "two-step"]) ?? DEFAULT_SETTINGS.form,
    forms,
    streamAnyway,
    heldSentences,
    tailSentences: count("reply.tailSentences", reply["tailSentences"]) ?? DEFAULT_SETTINGS.tailSentences,
    leadSampling: oneOf<"own" | "preset">("reply.leadSampling", reply["leadSampling"], ["own", "preset"]) ?? DEFAULT_SETTINGS.leadSampling,
    intentWaitMs: intentWait !== undefined ? intentWait * 1000 : DEFAULT_SETTINGS.intentWaitMs,
    progress: oneOf<"all" | "least">("progress.show", progress["show"], ["all", "least"]) ?? DEFAULT_SETTINGS.progress,
    silenceMs: silence !== undefined ? silence * 1000 : DEFAULT_SETTINGS.silenceMs,
    clipChars: count("results.clip", results["clip"]) ?? DEFAULT_SETTINGS.clipChars,
    searchHits: count("tools.search", tools["search"]) ?? DEFAULT_SETTINGS.searchHits,
    gapHits: count("tools.gapCheck", tools["gapCheck"]) ?? DEFAULT_SETTINGS.gapHits,
    perCall: count("tools.perCall", tools["perCall"]) ?? DEFAULT_SETTINGS.perCall,
    ruleWindow: count("rules.window", rules["window"]) ?? DEFAULT_SETTINGS.ruleWindow,
    efforts,
    requests: oneOf<RequestsSetting>("trace.requests", trace["requests"], ["first", "all", "none"]) ?? DEFAULT_SETTINGS.requests,
  };
}

/** The form a connection's reply takes, and whether a two-step connection streams anyway, by the connection's name or id. */
export function formFor(settings: Settings, connection: { id: string | null; name: string | null }): { form: ReplyFormSetting; stream: boolean } {
  const keys = [connection.id, connection.name].filter((key): key is string => key !== null);
  const named = keys.map((key) => settings.forms[key]).find((form) => form !== undefined);
  return { form: named ?? settings.form, stream: keys.some((key) => settings.streamAnyway.includes(key)) };
}

/** The effort the setting gives agents on a connection, by the connection's id or name; undefined where it names neither. */
export function effortFor(settings: Settings, connection: { id: string | null; name: string | null }): Effort | undefined {
  const key = [connection.id, connection.name].find((key) => key !== null && Object.hasOwn(settings.efforts, key));
  return key === undefined || key === null ? undefined : settings.efforts[key];
}
