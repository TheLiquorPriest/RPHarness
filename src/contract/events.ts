// What RPH tells the host as a turn goes (Appendix A `TurnEvents`). None of these returns a
// decision: the host records, shows and ties to the turn. The one call that returns something,
// `attachments`, returns text the host owns, never a ruling.

import type { AgentRef, Scope, SearchHit } from "./common";
import type { FactValue } from "./facts";
import type { LayerLevel } from "./files";
import type { JobView } from "./harness";
import type { Release, RunOutcome } from "./turn";

/**
 * Something an agent is given by name (§10.5 `delegate`, §5.4 `given:`): prompt slices
 * (`prompt:persona`), ranges of the chat (`chat:history[scene]`), lore entries, files, and the host's
 * own views (`world:scene(full, map)`, `story:brief`).
 */
export interface AttachmentRef {
  /** The name as the definition, the lead's call or the pin wrote it. */
  ref: string;
  /**
   * Where it was named: the agent's definition (`given:`); the lead's `delegate` call; a file the
   * user pinned for the agent (`pins:`, his setting, not the definition's, R-174); its definition's
   * `opening:`, an item resolved once when the session opens and kept in its opening block (§8.2,
   * R-163), asked again only when that block is made afresh; or `again`: a definition's item asked
   * again when `agent_message` continues the agent (C-T11), so the host gives its text as it now stands.
   */
  from: "definition" | "delegate" | "pin" | "opening" | "again";
  /**
   * RPH resolved it itself (prompt slices, chat ranges, lore entries, files). The host is told it
   * for the turn's record (§10.5: "the list is saved with the turn") and returns no block for it.
   */
  own: boolean;
}

/** The moment an agent's items are asked for (C-T13, R-144). */
export interface AttachMoment {
  /** The task the brief gave the agent (the delegate call's brief). */
  task: string;
  /** On a continuation, the message that continues it. */
  message?: string;
}

/**
 * A named piece of context: a part of the briefing compiled by the host from its own template
 * (§10.2 block 4), or the full text of an attachment the host resolved. RPH places each by `name`
 * where its own template puts it.
 */
export interface ContextBlock {
  /** For a briefing part, the name the briefing's template places it by (`world-state`, `lore-map`); for an attachment, the ref as written. */
  name: string;
  text: string;
}

/**
 * How a consent was given (§10.5). `write`: the lead's own write named its source as invented and
 * cited a gap check; `tool` and `callId` are that write's. `answer`: the lead answered a sub-agent
 * with `agent_message`, using its argument that says what may be invented and within what bounds;
 * `callId` is that call's.
 */
export type ConsentVia = { kind: "write"; tool: string; callId: string } | { kind: "answer"; callId: string };

/** The lead allowed something to be invented (§10.5 step 5), recorded by code in one of the two ways of `ConsentVia`. */
export interface ConsentGrant {
  id: string;
  /** Who allowed it. */
  by: AgentRef;
  /** For whom: the agent allowed to invent. Absent when it is `by` itself, in its own write. */
  to?: AgentRef;
  /** How it was given. */
  via: ConsentVia;
  /** What may be invented. */
  topic: string;
  /** Within what bounds, where they were said. */
  bounds?: string;
  /** The gap check it rests on, by id; absent when none was cited (shown so, §10.5 "What is shown"). */
  gapCheck?: string;
}

/** One search of a gap check: where it looked, and what came back (none: nothing). */
export interface GapSearch {
  /** `chat`, `lore`, or a host searcher's name. */
  where: string;
  hits: SearchHit[];
}

/** A gap check run (§10.5 `gap_check`), and what came back, saved as evidence. */
export interface GapCheck {
  id: string;
  by: AgentRef;
  topic: string;
  /** The names, other names and words it searched by. */
  terms: string[];
  searched: GapSearch[];
  /** Where the evidence was saved in the turn's `queries/`, as a path in the agents' view. */
  saved?: string;
}

/**
 * When a rule's condition was checked (§5.4): as the agent writes; on a tool's arguments or its
 * result; after a message (a `question:` rule); at a run's end; at a turn's start; before a
 * compaction; or on its interval.
 */
export type RuleMoment = "stream" | "tool-call" | "tool-result" | "after-message" | "run-end" | "turn-start" | "before-compaction" | "interval";

/**
 * What a firing did (§5.4 table, "What happens"). `cut`: the call was stopped, what was written and
 * not yet shown was dropped, the rule's text added, and the agent went on. `remind`: the text was
 * added after the message, or to the tool's result. `hold`: the text came back instead of running
 * the tool. `follow-up`: the text was added and the agent got another call. `briefing`: the text
 * went into the briefing. `call`: before a compaction, the agent got one call with the text first.
 */
export type RuleAction = "cut" | "remind" | "hold" | "follow-up" | "briefing" | "call";

/** What the agent did after a rule fired (§5.4: "which fired, on what, and what the agent did next"). */
export type RuleThen = { did: "called"; tools: string[] } | { did: "wrote" } | { did: "released" } | { did: "ended" };

/** A rule that fired. */
export interface RuleFiring {
  /** The rule's name: its file's name without `.md`. */
  rule: string;
  /** Its file, as a path in the agents' view, and the level it came from. */
  path: string;
  level: LayerLevel;
  moment: RuleMoment;
  /** Where a pattern matched: the agent's text, its thinking, the reply, a tool's arguments or result. */
  watched?: "text" | "thinking" | "reply" | "arguments" | "result";
  agent: AgentRef;
  /** The tool call it fired on, and its tool. */
  callId?: string;
  tool?: string;
  /** What the pattern matched, or the judging model's answer. */
  matched?: string;
  /** The fact that held, with its value then. */
  fact?: { name: string; value: FactValue };
  /** A stream rule that would stop the call reminded instead, as its agent's connection is set to (`rules.interrupt`, `rules.interrupts`). */
  reminded?: "connection";
  action: RuleAction;
  /** For a `cut`: the text dropped before it was shown. */
  dropped?: string;
  /** What the agent did next. Absent in the trace's `rule_fired`, sent as the rule fires; present when the host is told (`TurnEvents.ruleFired`). */
  then?: RuleThen;
}

/** An agent's suggestion to the user (§5.1, §6.8 `suggest`): a proposed change to an instruction file or to lore, with its reason. The agent never writes the file. */
export interface Suggestion {
  /** What it would change: a file (a path in the agents' view), a lore entry by id, or a new lore entry. */
  target: { file: string } | { lore: string } | { newLore: true };
  /** The proposed text: a file's or a new entry's whole text, or an edited entry's passage as it would be. */
  text: string;
  reason: string;
  /** For a new lore entry (C-L1, §9.5): the book it goes in, its title and its keys, beside `text`, where the agent gave them. */
  draft?: { book?: string; title?: string; keys?: string[] };
  /** For an edit of a lore entry: the passage as it stands, which `text` would replace. */
  was?: string;
}

/** What the host did with a suggestion: kept as open, under its id; or not kept, its chat's open suggestions being at their most. */
export type SuggestionFiled = { kept: true; id: string } | { kept: false; openMost: number };

/** RPH tells the host. None of these returns a decision; a suggestion is answered with whether it was kept. */
export interface TurnEvents {
  /** The lead's intent record for the turn (§10.3): kept and shown, never read by code. */
  intent(scope: Scope, text: string): Promise<void>;
  /**
   * The attachments an agent is given. The host keeps the list with the turn and returns the full
   * text of each ref in its own spaces; a ref it does not know is left out, and RPH says so in a
   * notice (§4.8: "nothing is attached and a notice says so"). It is given with the moment the items
   * are for (C-T13, R-144): the host may lay out what comes to mind for it (who and what the task and
   * message name); RPH takes back only the items' text.
   */
  attachments(scope: Scope, agent: AgentRef, refs: AttachmentRef[], moment: AttachMoment): Promise<ContextBlock[]>;
  /** A consent the lead gave, for the record and the Turn page (§10.5 step 6). */
  consent(scope: Scope, grant: ConsentGrant): Promise<void>;
  /** A gap check run, with its evidence. */
  gapCheck(scope: Scope, check: GapCheck): Promise<void>;
  /** The lead drops a sub-agent's writes, which the host staged under the turn (§13.4). */
  dropStaged(scope: Scope, agent: AgentRef): Promise<void>;
  /** A rule fired: which, on what, and what the agent did next. Told once the agent's next step is known (or its run ended). */
  ruleFired(scope: Scope, firing: RuleFiring): Promise<void>;
  /** An agent's suggestion, for the user to accept, edit or dismiss; answered with whether it was kept, which the agent is told. */
  suggestion(scope: Scope, agent: AgentRef, suggestion: Suggestion): Promise<SuggestionFiled>;
  /** The reply was released (§10.7): once per generation. */
  released(scope: Scope, release: Release): Promise<void>;
  /** The lead's run is over. */
  ended(scope: Scope, outcome: RunOutcome): Promise<void>;
  /**
   * A job's state changed (§13.5): it waits for a place, it runs, it ended (with its report), or a
   * restart found it interrupted. `scope` is the job's: its chat, its own session, and the turn
   * that started it. A host that runs jobs keeps what a job changed with that turn and tells the
   * next turn of the job's end in a `job` since-item; a host without it has the trace's `job`
   * events and `Harness.jobs`.
   */
  job?(scope: Scope, job: JobView): Promise<void>;
}
