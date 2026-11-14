// The rule engine (§5.4): handed the events of a run and the facts of the moment, it answers which
// of the user's triggered rules fire, with their texts filled in, and keeps to each rule's
// `repeat:`. It decides nothing else: what happens after a rule fires is the runner's.

import type { AgentRef, FactDef, FactValue, RuleMoment, Scope, ToolResult } from "../contract/index";
import type { Fired, RunEndRules, StreamFired, StreamRules, Written } from "../loop/rules";
import type { Answered, BriefingFired, Facts, Fields, MessageSeen, Problem, Question, RuleMemory, RuleRun, ToolCallFired, ToolCallSeen } from "./api";
import type { FactTest } from "./facts";
import { factFields, factsNamed, holds } from "./facts";
import type { Rule, RuleScope } from "./rules";

export interface RuleRunInput {
  scope: Scope;
  /** The triggered rules in force, each loaded whole. */
  rules: readonly Rule[];
  facts: Facts;
  memory?: RuleMemory;
  /** How many characters a pattern looks at at a time; absent, the whole text. */
  window?: number;
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
 * A pattern's first match in a whole text (a tool's arguments or result), looked for in stretches
 * of `window` characters, each starting half a stretch after the one before: no run of the pattern
 * sees more than a stretch, and every match up to half a stretch long is found.
 */
function matchIn(pattern: RegExp, text: string, window: number | undefined): RegExpExecArray | null {
  if (window === undefined || text.length <= window) return pattern.exec(text);
  const step = Math.max(1, Math.floor(window / 2));
  for (let from = 0; ; from += step) {
    const match = pattern.exec(text.slice(from, from + window));
    if (match !== null || from + window >= text.length) return match;
  }
}

/** What a pattern on a tool's result looks at: its text, its reports, and a line `marked <mark>` for each mark. */
function resultText(result: ToolResult): string {
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
  readonly #rules: readonly Rule[];
  readonly #facts: Facts;
  readonly #factNames: ReadonlySet<string>;
  readonly #memory: RuleMemory;
  readonly #window: number | undefined;
  /** `<rule> <agent id>`: what fired in this run, for `once per turn`. */
  readonly #thisRun = new Set<string>();
  /** `<rule> <agent id> <call>`: what fired on one model call's text. */
  readonly #inCall = new Set<string>();
  readonly #asked = new Map<string, Rule>();
  #questions = 0;

  constructor(input: RuleRunInput) {
    this.#scope = input.scope;
    this.#rules = input.rules;
    this.#facts = input.facts;
    this.#window = input.window;
    const defs = new Map(input.facts.defs().map((d) => [d.name, d] as const));
    this.#factNames = new Set(defs.keys());
    this.#memory = input.memory === undefined ? { turns: 0, fired: {}, held: [] } : structuredClone(input.memory);
    for (const rule of input.rules) this.problems.push(...checkFacts(rule, defs));
    this.runEnd = { due: (moment) => this.#due(moment.agent, (rule) => (rule.when.trigger === "moment" && rule.when.at === "run-end" ? "run-end" : undefined)) };
  }

  #for(agent: AgentRef): Rule[] {
    return this.#rules.filter((rule) => rule.agents === "all" || rule.agents.includes(agent.definition));
  }

  /** Whether `repeat:` lets the rule fire for this agent now. */
  #may(rule: Rule, agent: AgentRef): boolean {
    const last = this.#memory.fired[`${rule.name} ${agent.definition}`];
    switch (rule.repeat.per) {
      case "always":
        return true;
      case "turn":
        return !this.#thisRun.has(`${rule.name} ${agent.id}`);
      case "session":
        return last === undefined;
      case "turns":
        return last === undefined || this.#memory.turns - last >= rule.repeat.turns;
    }
  }

  #mark(rule: Rule, agent: AgentRef): void {
    this.#thisRun.add(`${rule.name} ${agent.id}`);
    this.#memory.fired[`${rule.name} ${agent.definition}`] = this.#memory.turns;
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
    for (const { rule } of candidates) {
      const test = factTest(rule);
      if (test !== undefined) names.add(test.name);
      for (const name of factsNamed(rule.text.fields, this.#factNames)) names.add(name);
    }
    const values = await this.#read(agent, [...names], candidates.map((c) => c.rule));
    const out: Fired[] = [];
    for (const { rule, moment } of candidates) {
      const test = factTest(rule);
      const value = test === undefined ? undefined : values[test.name];
      if (test !== undefined && (value === undefined || !holds(test, value))) continue;
      // Asked again: another moment of the same agent may have fired it while the facts were read.
      if (!this.#may(rule, agent)) continue;
      this.#mark(rule, agent);
      out.push({
        firing: { rule: rule.name, path: rule.path, level: rule.level, moment, ...(test !== undefined && value !== undefined ? { fact: { name: test.name, value } } : {}) },
        text: rule.text.render(factFields(values, test)).text,
      });
    }
    return out;
  }

  async turnStart(agent: AgentRef): Promise<BriefingFired[]> {
    this.#memory.turns += 1;
    const turns = this.#memory.turns;
    const held = this.#memory.held.filter((h) => h.agent === agent.definition);
    this.#memory.held = this.#memory.held.filter((h) => h.agent !== agent.definition);
    const due = await this.#due(agent, (rule) => {
      if (rule.when.trigger === "moment" && rule.when.at === "turn-start") return "turn-start";
      if (rule.when.trigger === "interval" && turns % rule.when.every === 0) return "interval";
      return undefined;
    });
    return [...held.map((h): BriefingFired => ({ firing: h.firing, text: h.text, carried: true })), ...due];
  }

  stream(agent: AgentRef): StreamRules {
    const rules = this.#for(agent).filter((rule) => rule.when.trigger === "pattern" && rule.when.scope.some(isStreamScope));
    return {
      // Every form reads the reply out of what the agent writes, so a rule on its text covers the reply as surely as one on the reply.
      coverReply: rules.some((rule) => rule.when.trigger === "pattern" && rule.when.interrupt && rule.when.scope.some((s) => s.watch === "reply" || s.watch === "text")),
      check: (written) => this.#check(agent, rules, written),
    };
  }

  #check(agent: AgentRef, rules: readonly Rule[], written: Written): StreamFired | undefined {
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
        const match = rule.when.pattern.exec(this.#window === undefined ? seen : seen.slice(-this.#window));
        if (match === null) continue;
        this.#inCall.add(callKey);
        this.#mark(rule, agent);
        return {
          firing: { rule: rule.name, path: rule.path, level: rule.level, moment: "stream", watched: scope.watch, matched: match[0] },
          text: rule.text.render({ matched: match[0] }).text,
          interrupt: rule.when.interrupt,
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
      const match = matchIn(rule.when.pattern, seen, this.#window);
      if (match !== null) out.push({ rule, matched: match[0], hold: rule.when.hold });
    }
    return out;
  }

  async toolCall(agent: AgentRef, call: ToolCallSeen): Promise<ToolCallFired> {
    const matches = this.#toolMatches(agent, "arguments", call.tool, JSON.stringify(call.args) ?? "");
    // Marked before any wait, so a call running beside this one cannot fire the same rule again.
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
    const matches = this.#toolMatches(agent, "result", call.tool, resultText(result));
    for (const { rule } of matches) this.#mark(rule, agent);
    const out: Fired[] = [];
    for (const { rule, matched } of matches) {
      const text = await this.#fill(rule, agent, { matched, tool: call.tool });
      out.push({ firing: { rule: rule.name, path: rule.path, level: rule.level, moment: "tool-result", watched: "result", callId: call.id, tool: call.tool, matched }, text });
    }
    return out;
  }

  beforeCompaction(agent: AgentRef): Promise<Fired[]> {
    return this.#due(agent, (rule) => (rule.when.trigger === "moment" && rule.when.at === "before-compaction" ? "before-compaction" : undefined));
  }

  questions(agent: AgentRef, message: MessageSeen): Question[] {
    const out: Question[] = [];
    for (const rule of this.#for(agent)) {
      if (rule.when.trigger !== "question" || !this.#may(rule, agent)) continue;
      for (const scope of rule.when.scope) {
        if (scope.watch !== "text" && scope.watch !== "thinking" && scope.watch !== "reply") continue;
        const text = message[scope.watch];
        if (text === undefined || text.trim() === "") continue;
        this.#questions += 1;
        const id = `${rule.name}#${this.#questions}`;
        this.#asked.set(id, rule);
        out.push({ id, rule: rule.name, agent, question: rule.when.question, watched: scope.watch, text });
      }
    }
    return out;
  }

  async answered(question: Question, yes: boolean): Promise<Answered | undefined> {
    const rule = this.#asked.get(question.id);
    this.#asked.delete(question.id);
    if (rule === undefined || !yes || !this.#may(rule, question.agent)) return undefined;
    this.#mark(rule, question.agent);
    const text = await this.#fill(rule, question.agent, {});
    // The judging model's answer is what a question rule "matched" (`RuleFiring.matched`).
    const fired: Fired = { firing: { rule: rule.name, path: rule.path, level: rule.level, moment: "after-message", watched: question.watched, matched: "yes" }, text };
    if (question.watched !== "reply") return { fired, deliver: "now" };
    this.#memory.held.push({ agent: question.agent.definition, firing: fired.firing, text });
    return { fired, deliver: "briefing" };
  }

  memory(): RuleMemory {
    return structuredClone(this.#memory);
  }
}
