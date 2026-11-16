// The rule engine (§5.4): handed the events of a run and the facts of the moment, it answers which
// of the user's triggered rules fire, with their texts filled in, and keeps to each rule's
// `repeat:`. It decides nothing else: what happens after a rule fires is the runner's. The rules in
// force are read as the files stand at each moment a rule would fire (decision 16), not fixed when
// the run began: a rule switched off, or held by a `needs:` no longer in force, stops at once, an
// edited one fires as it now reads, and `repeat:` counts carry across, by the rule's name. On the
// stream, whose check cannot wait, the rules are those read at the start of the model call. Every
// pattern runs where it can be stopped (pattern.ts), under `rules.patternTime`: one that runs out of
// time counts as no match, is told (`ranOut`), and the rule stays in force (R-55). A stream rule that
// interrupts reminds instead where the agent's connection is set to (`stops`), and its firing says so.

import type { AgentRef, FactDef, FactValue, JsonValue, RuleMoment, Scope, ToolResult } from "../contract/index";
import type { Fired, RunEndRules, StreamFired, StreamRules, Written } from "../loop/rules";
import type { Answered, BriefingFired, Facts, Fields, MessageSeen, Problem, Question, RuleCommandAnswer, RuleMemory, RuleRun, RuleRunOptions, ToolCallFired, ToolCallSeen } from "./api";
import type { FactTest } from "./facts";
import { factFields, factsNamed, holds } from "./facts";
import type { Rule, RuleScope } from "./rules";
import { runPattern } from "./pattern";

export interface RuleRunInput extends Pick<RuleRunOptions, "command" | "commandFailed"> {
  scope: Scope;
  /** The triggered rules in force when the run begins, each loaded whole. */
  rules: readonly Rule[];
  /** The triggered rules in force as the files stand now. */
  read(): Promise<readonly Rule[]>;
  facts: Facts;
  memory?: RuleMemory;
  /** How many characters a pattern looks at at a time; absent, the whole text. */
  window?: number;
  /** Milliseconds one pattern may run on one text (`rules.patternTime`). */
  patternTime: number;
  /** Told of a rule whose pattern ran out of time on a text, with the text's length: the check counted as no match. */
  ranOut?(agent: AgentRef, rule: { rule: string; path: string }, length: number): void;
  /** Whether a stream rule that interrupts may stop `agent`'s call, as its connection's setting says (`rules.interrupt`, `rules.interrupts`); absent: it may. Asked at each model call's start. */
  stops?(agent: AgentRef): Promise<boolean>;
}

/** The fields a pattern's text has besides the facts: what it matched, and the tool, on a tool's arguments or result. */
const PATTERN_FIELDS: readonly string[] = ["matched", "tool"];

/** The fact a rule tests, if it tests one. */
function factTest(rule: Rule): FactTest | undefined {
  return rule.when.trigger === "moment" || rule.when.trigger === "interval" ? rule.when.fact : undefined;
}

function isStreamScope(scope: RuleScope): boolean {
  return scope.watch === "text" || scope.watch === "thinking" || scope.watch === "reply";
}

/**
 * A pattern's first match in a text, through the facility under `ms`; with a `window`, looked for in
 * stretches of that many characters, each starting half a stretch after the one before, so every
 * match up to half a stretch long is found. `timedOut` where a run ran out of time.
 */
export function matchIn(pattern: RegExp, text: string, window: number | undefined, ms: number): { matched: string | undefined; timedOut?: true } {
  if (window === undefined || text.length <= window) {
    const run = runPattern(pattern, text, ms);
    return "timedOut" in run ? { matched: undefined, timedOut: true } : { matched: run.match?.text };
  }
  const step = Math.max(1, Math.floor(window / 2));
  for (let from = 0; ; from += step) {
    const run = runPattern(pattern, text.slice(from, from + window), ms);
    if ("timedOut" in run) return { matched: undefined, timedOut: true };
    if (run.match !== null || from + window >= text.length) return { matched: run.match?.text };
  }
}

/** What a pattern on a tool's result looks at: its text, its reports, and a line `marked <mark>` for each mark. */
export function resultText(result: ToolResult): string {
  return [...result.content.flatMap((c) => (c.type === "text" ? [c.text] : []))]
    .concat(result.reports ?? [], (result.marks ?? []).map((mark) => `marked ${mark}`))
    .join("\n");
}

/** The problems a rule's `fact:` and text have against the facts there are. */
function checkFacts(rule: Rule, defs: ReadonlyMap<string, FactDef>): Problem[] {
  const problems: Problem[] = [];
  const at = (line: number | undefined, message: string): Problem => ({ path: rule.path, level: rule.level, ...(line !== undefined ? { line } : {}), message });
  const test = factTest(rule);
  if (test !== undefined) {
    const def = defs.get(test.name);
    if (def === undefined) problems.push(at(rule.lines.fact, `\`fact:\` names ${test.name}, which nothing counts, so the rule never fires. The facts are: ${[...defs.keys()].join(", ")}.`));
    else {
      for (const group of test.groups ?? []) {
        if (!(def.by ?? []).includes(group)) problems.push(at(rule.lines.fact, `${test.name} has no group \`${group}\`; ${def.by === undefined ? "it has none" : `its groups are ${def.by.join(", ")}`}. A group it does not have counts 0.`));
      }
    }
  }
  const onStreamOnly = rule.when.trigger === "pattern" && rule.when.scope.every(isStreamScope);
  const bodyLines = rule.text.text.split("\n");
  for (const path of rule.text.fields) {
    if (rule.when.trigger === "pattern" && PATTERN_FIELDS.includes(path)) continue;
    const line = rule.lines.body + Math.max(0, bodyLines.findIndex((l) => l.includes(path)));
    if (onStreamOnly) {
      problems.push(at(line, `On what an agent writes, a rule's text is filled from {{matched}} alone, so {{${path}}} stays empty.`));
      continue;
    }
    const [name] = factsNamed([path], new Set(defs.keys()));
    if (name === undefined) {
      problems.push(at(line, `The text shows {{${path}}}, and no fact gives it, so it stays empty.`));
      continue;
    }
    const def = defs.get(name);
    const rest = path.slice(name.length + 1).split(".");
    const field = rest[0] ?? "";
    const fine = field === "" || field === "names" || (field === "by" && (rest[1] === undefined || (def?.by ?? []).includes(rest[1]))) || (def?.fields ?? []).includes(field);
    if (!fine) problems.push(at(line, `The text shows {{${path}}}, and ${name} has no \`${rest.join(".")}\`: it gives its count, \`names\`, \`by\`${(def?.fields ?? []).length > 0 ? ` and ${(def?.fields ?? []).join(", ")}` : ""}. It stays empty.`));
  }
  return problems;
}

export function createRuleRun(input: RuleRunInput): RuleRun {
  return new Run(input);
}

class Run implements RuleRun {
  readonly problems: Problem[] = [];
  readonly runEnd: RunEndRules;
  readonly #scope: Scope;
  /** The rules in force as last read: at the run's start, then at each moment and each model call's start. */
  #rules: readonly Rule[];
  readonly #inForce: () => Promise<readonly Rule[]>;
  readonly #defs: ReadonlyMap<string, FactDef>;
  /** Each rule's file and text whose facts were checked, so a rule read again is said once. */
  readonly #checked = new Set<string>();
  readonly #facts: Facts;
  readonly #factNames: ReadonlySet<string>;
  readonly #memory: RuleMemory & { session: NonNullable<RuleMemory["session"]> };
  readonly #window: number | undefined;
  readonly #patternTime: number;
  readonly #ranOut: RuleRunInput["ranOut"];
  readonly #stopsFor: RuleRunInput["stops"];
  readonly #command: RuleRunInput["command"];
  readonly #commandFailed: RuleRunInput["commandFailed"];
  /** Each agent's connection's word, as last asked at a model call's start: may a stream rule stop its call. */
  readonly #stops = new Map<string, boolean>();
  /** `<rule> <agent id>`: what fired in this run, for `once per turn`. */
  readonly #thisRun = new Set<string>();
  /** `<rule> <agent id> <call>`: what fired on one model call's text. */
  readonly #inCall = new Set<string>();
  /** Each question put, by its id: the name of the rule that asked it, which the answer finds as it reads then. */
  readonly #asked = new Map<string, string>();
  #questions = 0;
  /** The read of the rules under way, which every moment that comes meanwhile waits on. */
  #reading: Promise<void> | undefined;

  constructor(input: RuleRunInput) {
    this.#scope = input.scope;
    this.#rules = [];
    this.#inForce = input.read;
    this.#facts = input.facts;
    this.#window = input.window;
    this.#patternTime = input.patternTime;
    this.#ranOut = input.ranOut;
    this.#stopsFor = input.stops;
    this.#command = input.command;
    this.#commandFailed = input.commandFailed;
    this.#defs = new Map(input.facts.defs().map((d) => [d.name, d] as const));
    this.#factNames = new Set(this.#defs.keys());
    const memory: RuleMemory = input.memory === undefined ? { turns: 0, fired: {}, held: [] } : structuredClone(input.memory);
    // A run in another session than the one the memory notes begins that session's list: a rule `repeat: once per session` fires again in it.
    this.#memory = { ...memory, session: memory.session !== undefined && memory.session.id === input.scope.session ? memory.session : { id: input.scope.session, fired: [] } };
    this.#take(input.rules);
    this.runEnd = {
      due: async (moment) => {
        await this.#now();
        return this.#due(moment.agent, (rule) => (rule.when.trigger === "moment" && rule.when.at === "run-end" ? "run-end" : undefined));
      },
    };
  }

  /** The rules as read, each new rule's facts checked once. */
  #take(rules: readonly Rule[]): void {
    this.#rules = rules;
    for (const rule of rules) {
      const key = `${rule.path}\n${rule.text.text}`;
      if (this.#checked.has(key)) continue;
      this.#checked.add(key);
      this.problems.push(...checkFacts(rule, this.#defs));
    }
  }

  /**
   * The rules in force as the files stand now. Moments that come while a read is under way share it,
   * so they go on in the order they came, and two calls side by side fire a rule once, the first.
   */
  #now(): Promise<void> {
    this.#reading ??= this.#inForce()
      .then((rules) => this.#take(rules))
      .finally(() => {
        this.#reading = undefined;
      });
    return this.#reading;
  }

  #for(agent: AgentRef): Rule[] {
    return this.#rules.filter((rule) => rule.agents === "all" || rule.agents.includes(agent.definition));
  }

  /** Whether `repeat:` lets the rule fire for this agent now. */
  #may(rule: Rule, agent: AgentRef): boolean {
    const key = `${rule.name} ${agent.definition}`;
    const last = this.#memory.fired[key];
    switch (rule.repeat.per) {
      case "always":
        return true;
      case "turn":
        return !this.#thisRun.has(`${rule.name} ${agent.id}`);
      case "session":
        return !this.#memory.session.fired.includes(key);
      case "turns":
        return last === undefined || this.#memory.turns - last >= rule.repeat.turns;
    }
  }

  #mark(rule: Rule, agent: AgentRef): void {
    const key = `${rule.name} ${agent.definition}`;
    this.#thisRun.add(`${rule.name} ${agent.id}`);
    this.#memory.fired[key] = this.#memory.turns;
    if (!this.#memory.session.fired.includes(key)) this.#memory.session.fired.push(key);
  }

  /**
   * The facts the rules name, as the host and RPH give them now. Facts that cannot be read are none:
   * a rule that tests one does not fire, a text that shows one shows it empty, each rule says so in
   * `problems`, and the run goes on.
   */
  async #read(agent: AgentRef, names: readonly string[], rules: readonly Rule[]): Promise<Record<string, FactValue>> {
    if (names.length === 0) return {};
    try {
      return await this.#facts.read(this.#scope, agent, names);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      for (const rule of rules) this.problems.push({ path: rule.path, level: rule.level, message: `The facts it names could not be read (${why}), so it did not fire, or its text was left without them.` });
      return {};
    }
  }

  /** The rule's text, filled from the facts it names and `extra`. */
  async #fill(rule: Rule, agent: AgentRef, extra: Fields): Promise<string> {
    const values = await this.#read(agent, factsNamed(rule.text.fields, this.#factNames), [rule]);
    return rule.text.render({ ...factFields(values), ...extra }).text;
  }

  /** The rules for `agent` due at a moment (`momentOf` says which moment each is due at, if any), with the facts of the moment read once for all of them. */
  async #due(agent: AgentRef, momentOf: (rule: Rule) => RuleMoment | undefined): Promise<Fired[]> {
    const candidates = this.#for(agent).flatMap((rule) => {
      const moment = momentOf(rule);
      return moment !== undefined && this.#may(rule, agent) ? [{ rule, moment }] : [];
    });
    if (candidates.length === 0) return [];
    const names = new Set<string>();
    // A rule's command is told every fact of the moment.
    const asking = candidates.some(({ rule }) => rule.when.trigger === "moment" && rule.when.command !== undefined);
    for (const { rule } of candidates) {
      const test = factTest(rule);
      if (test !== undefined) names.add(test.name);
      for (const name of factsNamed(rule.text.fields, this.#factNames)) names.add(name);
    }
    if (asking) for (const name of this.#factNames) names.add(name);
    const values = await this.#read(agent, [...names], candidates.map((c) => c.rule));
    const out: Fired[] = [];
    for (const { rule, moment } of candidates) {
      const test = factTest(rule);
      const value = test === undefined ? undefined : values[test.name];
      if (test !== undefined && (value === undefined || !holds(test, value))) continue;
      const command = rule.when.trigger === "moment" ? rule.when.command : undefined;
      if (command !== undefined && !(await this.#asks(agent, rule, command, moment, values))) continue;
      // Asked again: another moment of the same agent may have fired it while the facts were read.
      if (!this.#may(rule, agent)) continue;
      this.#mark(rule, agent);
      out.push({
        firing: { rule: rule.name, path: rule.path, level: rule.level, moment, ...(test !== undefined && value !== undefined ? { fact: { name: test.name, value } } : {}), ...(command !== undefined ? { matched: "yes" } : {}) },
        text: rule.text.render(factFields(values, test)).text,
      });
    }
    return out;
  }

  /**
   * Asks a rule's command about the moment (C5), with the moment's facts and the agent's place: true
   * when it says yes. One that waits for its switch or is off ran nothing and does not fire; one that
   * failed or ran out of time is told, as unable to work, and is never taken for a no.
   */
  async #asks(agent: AgentRef, rule: Rule, command: string, moment: RuleMoment, facts: Record<string, FactValue>): Promise<boolean> {
    if (this.#command === undefined) return false;
    const scope = this.#scope;
    const input = { moment, agent: { id: agent.id, definition: agent.definition, ...(agent.plays !== undefined ? { plays: agent.plays } : {}) }, place: { chat: scope.chat, session: scope.session, ...(scope.turn !== undefined ? { turn: scope.turn } : {}) }, facts } as unknown as JsonValue;
    let said: RuleCommandAnswer;
    try {
      said = await this.#command(agent, { rule: rule.name, command }, input);
    } catch (error) {
      said = { failed: error instanceof Error ? error.message : String(error) };
    }
    if (typeof said !== "object") return said === "yes";
    this.problems.push({ path: rule.path, level: rule.level, message: `Its command could not answer (${said.failed}), so it did not fire: the rule is unable to work until its command answers yes or no.` });
    this.#commandFailed?.(agent, { rule: rule.name, path: rule.path }, said.failed);
    return false;
  }

  async turnStart(agent: AgentRef): Promise<BriefingFired[]> {
    this.#memory.turns += 1;
    const turns = this.#memory.turns;
    const held = this.#memory.held.filter((h) => h.agent === agent.definition);
    this.#memory.held = this.#memory.held.filter((h) => h.agent !== agent.definition);
    await this.#now();
    const due = await this.#due(agent, (rule) => {
      if (rule.when.trigger === "moment" && rule.when.at === "turn-start") return "turn-start";
      if (rule.when.trigger === "interval" && turns % rule.when.every === 0) return "interval";
      return undefined;
    });
    return [...held.map((h): BriefingFired => ({ firing: h.firing, text: h.text, carried: true })), ...due];
  }

  stream(agent: AgentRef): StreamRules {
    const rules = (): Rule[] => this.#for(agent).filter((rule) => rule.when.trigger === "pattern" && rule.when.scope.some(isStreamScope));
    const stops = (): boolean => this.#stops.get(agent.id) ?? true;
    return {
      // Every form reads the reply out of what the agent writes, so a rule on its text covers the reply as surely as one on the reply; on a connection set to remind, none holds the reply back.
      get coverReply() {
        return stops() && rules().some((rule) => rule.when.trigger === "pattern" && rule.when.interrupt && rule.when.scope.some((s) => s.watch === "reply" || s.watch === "text"));
      },
      fresh: async () => {
        const [, mode] = await Promise.all([this.#now(), this.#stopsFor?.(agent)]);
        if (mode !== undefined) this.#stops.set(agent.id, mode);
      },
      check: (written) => this.#check(agent, rules(), written, stops()),
    };
  }

  /** A pattern run on a text for `agent`, through the facility: what it matched, or nothing; one that ran out of time is told. */
  #match(agent: AgentRef, rule: Rule, pattern: RegExp, text: string, window: number | undefined): string | undefined {
    const run = matchIn(pattern, text, window, this.#patternTime);
    if (run.timedOut === true) this.#ranOut?.(agent, { rule: rule.name, path: rule.path }, text.length);
    return run.matched;
  }

  #check(agent: AgentRef, rules: readonly Rule[], written: Written, stops: boolean): StreamFired | undefined {
    for (const rule of rules) {
      if (rule.when.trigger !== "pattern") continue;
      const callKey = `${rule.name} ${agent.id} ${written.call}`;
      if (this.#inCall.has(callKey) || !this.#may(rule, agent)) continue;
      for (const scope of rule.when.scope) {
        // Only what the newest piece changed is looked at again: thinking, or the text and the reply it carries.
        if (scope.watch === "thinking" ? written.piece !== "thinking" : !isStreamScope(scope) || written.piece !== "text") continue;
        const seen = scope.watch === "text" ? written.text : scope.watch === "thinking" ? written.thinking : written.reply;
        if (seen === undefined || seen === "") continue;
        // What was written before the newest stretch was looked at as it came.
        const matched = this.#match(agent, rule, rule.when.pattern, this.#window === undefined ? seen : seen.slice(-this.#window), undefined);
        if (matched === undefined) continue;
        this.#inCall.add(callKey);
        this.#mark(rule, agent);
        // On a connection set to remind, a rule that would stop the call fires as `interrupt: never` does, and says why.
        const reminded = rule.when.interrupt && !stops;
        return {
          firing: { rule: rule.name, path: rule.path, level: rule.level, moment: "stream", watched: scope.watch, matched, ...(reminded ? { reminded: "connection" as const } : {}) },
          text: rule.text.render({ matched }).text,
          interrupt: rule.when.interrupt && stops,
        };
      }
    }
    return undefined;
  }

  /** The pattern rules for `agent` that look at a tool's arguments or result, for this tool, and match what it gave. */
  #toolMatches(agent: AgentRef, watch: "arguments" | "result", tool: string, seen: string): { rule: Rule; matched: string; hold: boolean }[] {
    const out: { rule: Rule; matched: string; hold: boolean }[] = [];
    for (const rule of this.#for(agent)) {
      if (rule.when.trigger !== "pattern" || !this.#may(rule, agent)) continue;
      if (!rule.when.scope.some((s) => s.watch === watch && "tool" in s && s.tool.match(tool))) continue;
      const matched = this.#match(agent, rule, rule.when.pattern, seen, this.#window);
      if (matched !== undefined) out.push({ rule, matched, hold: rule.when.hold });
    }
    return out;
  }

  async toolCall(agent: AgentRef, call: ToolCallSeen): Promise<ToolCallFired> {
    await this.#now();
    const matches = this.#toolMatches(agent, "arguments", call.tool, JSON.stringify(call.args) ?? "");
    // Marked before any later wait, so a call running beside this one cannot fire the same rule again.
    for (const { rule } of matches) this.#mark(rule, agent);
    const fired: { fired: Fired; hold: boolean }[] = [];
    for (const { rule, matched, hold } of matches) {
      const text = await this.#fill(rule, agent, { matched, tool: call.tool });
      fired.push({ fired: { firing: { rule: rule.name, path: rule.path, level: rule.level, moment: "tool-call", watched: "arguments", callId: call.id, tool: call.tool, matched }, text }, hold });
    }
    const holding = fired.find((f) => f.hold);
    return { ...(holding !== undefined ? { hold: holding.fired } : {}), remind: fired.filter((f) => f !== holding).map((f) => f.fired) };
  }

  async toolResult(agent: AgentRef, call: { id: string; tool: string }, result: ToolResult): Promise<Fired[]> {
    await this.#now();
    const matches = this.#toolMatches(agent, "result", call.tool, resultText(result));
    for (const { rule } of matches) this.#mark(rule, agent);
    const out: Fired[] = [];
    for (const { rule, matched } of matches) {
      const text = await this.#fill(rule, agent, { matched, tool: call.tool });
      out.push({ firing: { rule: rule.name, path: rule.path, level: rule.level, moment: "tool-result", watched: "result", callId: call.id, tool: call.tool, matched }, text });
    }
    return out;
  }

  async beforeCompaction(agent: AgentRef): Promise<Fired[]> {
    await this.#now();
    return this.#due(agent, (rule) => (rule.when.trigger === "moment" && rule.when.at === "before-compaction" ? "before-compaction" : undefined));
  }

  questions(agent: AgentRef, message: MessageSeen): Question[] {
    const out: Question[] = [];
    for (const rule of this.#for(agent)) {
      const when = rule.when;
      if (when.trigger !== "question" || !this.#may(rule, agent)) continue;
      for (const scope of when.scope) {
        if (scope.watch !== "text" && scope.watch !== "thinking" && scope.watch !== "reply") continue;
        const text = message[scope.watch];
        if (text === undefined || text.trim() === "") continue;
        this.#questions += 1;
        const id = `${rule.name}#${this.#questions}`;
        this.#asked.set(id, rule.name);
        out.push({ id, rule: rule.name, path: rule.path, agent, question: when.question, watched: scope.watch, text, interrupt: when.interrupt, ...(when.judge !== undefined ? { judge: when.judge } : {}) });
      }
    }
    return out;
  }

  async answered(question: Question, yes: boolean): Promise<Answered | undefined> {
    const name = this.#asked.get(question.id);
    this.#asked.delete(question.id);
    if (name === undefined || !yes) return undefined;
    // The rule as it reads now: one switched off since the question was put does not fire, and an edited one fires as it now reads.
    await this.#now();
    const rule = this.#for(question.agent).find((r) => r.name === name && r.when.trigger === "question");
    if (rule === undefined || !this.#may(rule, question.agent)) return undefined;
    this.#mark(rule, question.agent);
    const text = await this.#fill(rule, question.agent, {});
    // The judging model's answer is what a question rule "matched" (`RuleFiring.matched`).
    const fired: Fired = { firing: { rule: rule.name, path: rule.path, level: rule.level, moment: "after-message", watched: question.watched, matched: "yes" }, text };
    if (question.watched !== "reply") return { fired, deliver: "now" };
    this.#memory.held.push({ agent: question.agent.definition, firing: fired.firing, text });
    return { fired, deliver: "briefing" };
  }

  hold(agent: AgentRef, fired: Fired): void {
    this.#memory.held.push({ agent: agent.definition, firing: fired.firing, text: fired.text });
  }

  memory(): RuleMemory {
    return structuredClone(this.#memory);
  }
}
