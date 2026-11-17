// The Rules page's switch and its tester (§5.4 l.555, §14 Rules; Appendix A; C-10). `switchRule`
// writes a rule into or out of the `stack.off` list of the chat's or the global config, on the owner's
// word, through the file port as his own press: the next moment a rule would fire reads the files
// again (decision 16), so it stops, or goes on, from there. `testRule` runs one rule, as its file
// reads now, against a past turn's record and writes nothing: the agents' transcripts in the turn's
// folder (each message, its thinking, each tool call and result), its released reply, the facts as
// of that turn, the turn's count in its session, and, for a question, the judging model asked about
// each recorded message in a run of its own that the live view shows.

import type { AgentRef, Environment, FactValue, JsonObject, JsonValue, Layer, ModelsApi, RuleAction, RuleFiring, RuleMoment, RuleTest, RuleView, Scope, ToolResult } from "../contract";
import { checkRule, createFacts, loadGuidance, type Looked } from "../files";
import { createRuleRun } from "../files/engine";
import { CONFIG_KEYS, CONFIG_SECTION } from "../files/api";
import { isMapping, nameList, normalized, parseYaml } from "../files/header";
import type { Rule } from "../files/rules";
import { itemKey, writtenKey } from "../files/tree";
import { Budget, RunTrace } from "../loop";
import type { ModelSource } from "../model/source";
import type { SessionBook } from "../sessions/book";
import { Judges } from "./judge";
import type { Judged } from "../loop/rules";
import { askRuleCommand } from "../external/command";
import type { LiveHub } from "./live";
import { connectionOf } from "./means";
import { agentFileName, TRANSCRIPTS } from "./requests";
import { readSettings } from "./settings";
import { RELEASED_FILE } from "./turn";

/** An entry of a `stack.off` list as the YAML flow list writes it: bare where it can be, else quoted. */
function listed(entry: string): string {
  return /^[A-Za-z0-9_@./-]+$/.test(entry) ? entry : JSON.stringify(entry);
}

/**
 * A config file's text with `key` taken out of its `stack.off` list (`on`) or put in it: every entry
 * that names it, however written, goes; switched off, the first is kept as it was written, else the
 * key is added. The list is written back as one flow list in its place under `stack:`; a `stack`
 * written on its own line (`stack: { … }`) is written back as a block. The rest of the file is as it
 * was, and a switch that changes nothing leaves the text as it is.
 */
function withOff(text: string, key: string, on: boolean, layers: readonly Layer[], at: { path: string }): string {
  const lines = normalized(text).split("\n");
  const parsed = parseYaml(lines, 1, at, "the config");
  if ("problem" in parsed) throw new Error(`${at.path} cannot be read (${parsed.problem.message}), so the rule was not switched: mend the file first.`);
  const value = parsed.value;
  if (value !== null && value !== undefined && !isMapping(value)) throw new Error(`${at.path} is not \`name: value\` lines, so the rule was not switched: mend the file first.`);
  const stack = isMapping(value) ? value[CONFIG_SECTION] : undefined;
  if (stack !== null && stack !== undefined && !isMapping(stack)) throw new Error(`\`stack\` in ${at.path} is not a mapping of keys, so the rule was not switched: mend the file first.`);
  const entries = nameList(isMapping(stack) ? stack[CONFIG_KEYS.off] : undefined);
  if (entries === undefined) throw new Error(`\`stack.off\` in ${at.path} is not a list, so the rule was not switched: mend the file first.`);
  const named = entries.filter((entry) => writtenKey(entry, layers) === key);
  if (on && named.length === 0) return text;
  const kept = entries.filter((entry) => writtenKey(entry, layers) !== key);
  if (!on) kept.push(named[0] ?? key);
  const list = `[${kept.map(listed).join(", ")}]`;
  const start = lines.findIndex((line) => new RegExp(`^${CONFIG_SECTION}[ \\t]*:`).test(line));
  if (start === -1) {
    const body = lines.join("\n");
    return `${body}${body === "" || body.endsWith("\n") ? "" : "\n"}${CONFIG_SECTION}:\n  ${CONFIG_KEYS.off}: ${list}\n`;
  }
  // The section's own lines: its first, and the indented, listed, blank or comment lines under it, but those it ends on.
  let end = start + 1;
  while (end < lines.length && !/^(?:[^\s#-]|-\S)/.test(lines[end] ?? "")) end += 1;
  while (end > start + 1 && /^\s*(?:#.*)?$/.test(lines[end - 1] ?? "")) end -= 1;
  const first = lines.slice(start + 1, end).find((line) => line.trim() !== "" && !/^\s*#/.test(line));
  if (first === undefined) {
    // Written on its own line, or empty: its keys as blocks, each other value as one flow value.
    const others = Object.entries(isMapping(stack) ? stack : {}).filter(([name]) => name !== CONFIG_KEYS.off);
    const block = [`${CONFIG_SECTION}:`, `  ${CONFIG_KEYS.off}: ${list}`, ...others.map(([name, held]) => `  ${name}: ${JSON.stringify(held)}`)];
    return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  }
  const indent = /^[ \t]*/.exec(first)![0];
  const field = `${indent}${CONFIG_KEYS.off}: ${list}`;
  const row = lines.findIndex((line, i) => i > start && i < end && new RegExp(`^${indent}${CONFIG_KEYS.off}[ \\t]*:`).test(line));
  if (row === -1) return [...lines.slice(0, start + 1), field, ...lines.slice(start + 1)].join("\n");
  // The field's own lines: its first, and the more indented or listed lines under it.
  let last = row + 1;
  while (last < end && (lines[last] ?? "").trim() !== "" && [" ", "\t", "-"].some((after) => (lines[last] ?? "").startsWith(`${indent}${after}`))) last += 1;
  return [...lines.slice(0, row), field, ...lines.slice(last)].join("\n");
}

/** Switches a rule on or off in the `stack.off` list of the chat's or the global config, written as the owner's own press. */
export async function switchRule(env: Environment, scope: Scope, name: string, on: boolean, level: "chat" | "global"): Promise<RuleView | undefined> {
  const guidance = loadGuidance(env.files, scope);
  const layers = await guidance.layers();
  const layer = layers.find((l) => l.level === level);
  if (layer?.config === undefined) throw new Error(`The ${level} level has no config file to switch a rule in.`);
  const path = `${layer.mount}${layer.config}`;
  const read = await env.files.read(scope, path);
  if (read.status === "refused") throw new Error(`${path} cannot be read (${read.reason}), so the rule was not switched.`);
  const text = read.status === "read" ? read.text : "";
  const next = withOff(text, itemKey("rules", name), on, layers, { path });
  if (next !== text) {
    const written = await env.files.write(scope, path, { op: "write", text: next }, "owner");
    if (written.status !== "written") throw new Error(`${path} could not be written (${written.status === "refused" ? written.reason : written.status}), so the rule was not switched.`);
  }
  return (await loadGuidance(env.files, scope).rules(env.switches)).find((view) => view.name === name);
}

export interface RuleTestDeps {
  env: Environment;
  book: SessionBook;
  hub: LiveHub;
  models: ModelSource;
  connections: ModelsApi;
  ids(): string;
}

/** One agent's record in a past turn: who it was, and its transcript's lines. */
interface Recorded {
  agent: AgentRef;
  lines: JsonObject[];
}

/** The definition and handle a transcript's file name gives, the definition being the longest of those there are that it starts with. */
function agentOf(base: string, definitions: readonly string[]): AgentRef {
  const named = definitions.filter((d) => base.startsWith(agentFileName({ id: "", definition: d }))).sort((a, b) => b.length - a.length)[0];
  return named === undefined ? { id: base, definition: base } : { id: base.slice(agentFileName({ id: "", definition: named }).length), definition: named };
}

/** What each agent of the turn did, from the transcripts RPH wrote in the turn's folder. */
async function recorded(env: Environment, scope: Scope, folder: string, definitions: readonly string[]): Promise<Recorded[]> {
  const found = await env.files.find(scope, { by: "list", path: `${folder}${TRANSCRIPTS}`, limit: Number.POSITIVE_INFINITY });
  if (found.status === "refused") return [];
  const out: Recorded[] = [];
  for (const hit of found.hits) {
    if (hit.type !== "file" || !hit.path.endsWith(".jsonl")) continue;
    const read = await env.files.read(scope, hit.path);
    if (read.status !== "read") continue;
    const lines: JsonObject[] = [];
    for (const line of read.text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) lines.push(parsed as JsonObject);
      } catch {
        // A line cut short by a crash is no record.
      }
    }
    const base = hit.path.slice(hit.path.lastIndexOf("/") + 1, -".jsonl".length);
    out.push({ agent: agentOf(base, definitions), lines });
  }
  return out;
}

/** What a firing would have done, as the runner does it (§5.4 table). */
function actionOf(rule: Rule, moment: RuleMoment): RuleAction {
  if (moment === "stream") return rule.when.trigger === "pattern" && rule.when.interrupt ? "cut" : "remind";
  if (moment === "tool-call") return rule.when.trigger === "pattern" && rule.when.hold ? "hold" : "remind";
  if (moment === "tool-result" || moment === "after-message") return "remind";
  if (moment === "run-end") return "follow-up";
  if (moment === "before-compaction") return "call";
  return "briefing";
}

/** Runs one rule, as it reads now, against a past turn's record; writes nothing. */
export async function testRule(d: RuleTestDeps, scope: Scope, name: string, turn: string): Promise<RuleTest> {
  const { env } = d;
  const at: Scope = { ...scope, turn };
  const guidance = loadGuidance(env.files, at);
  const [rule, settings, places, definitions] = await Promise.all([guidance.rule(name), readSettings(guidance, env, at), env.files.places(at), guidance.definitions()]);
  if (rule === undefined) throw new Error(`No rule named ${name} reads whole: see it on the Rules page.`);
  const folder = places.turn;
  if (folder === undefined) throw new Error(`The turn ${turn} has no folder to read.`);
  const lead = await d.book.with(at, (file) => file.log.turn(turn)?.lead);
  if (lead === undefined) throw new Error(`The turn ${turn} is not in the session ${scope.session}.`);
  const agents = (await recorded(env, at, folder, definitions.map((v) => v.name))).filter((r) => rule.agents === "all" || rule.agents.includes(r.agent.definition));
  const leadRef = agents.find((r) => r.agent.definition === lead)?.agent ?? { id: lead, definition: lead };
  const firings: RuleFiring[] = [];
  const fire = (agent: AgentRef, moment: RuleMoment, extra: Partial<RuleFiring>): void => {
    firings.push({ rule: rule.name, path: rule.path, level: rule.level, moment, agent, action: actionOf(rule, moment), ...extra });
  };
  const terms = { patternTime: settings.patternTime, ...(settings.ruleWindow !== undefined ? { window: settings.ruleWindow } : {}) };
  const when = rule.when;

  if (when.trigger === "pattern") {
    const check = (agent: AgentRef, moment: RuleMoment, looked: Looked, extra: Partial<RuleFiring>): void => {
      const checked = checkRule(rule, looked, terms);
      if ("holds" in checked && checked.holds) fire(agent, moment, { ...("watch" in looked ? { watched: looked.watch } : {}), ...(checked.matched !== undefined ? { matched: checked.matched } : {}), ...extra });
    };
    for (const { agent, lines } of agents) {
      for (const line of lines) {
        if (line.type === "message") {
          if (typeof line.text === "string" && line.text !== "") check(agent, "stream", { watch: "text", text: line.text }, {});
          if (typeof line.thinking === "string" && line.thinking !== "") check(agent, "stream", { watch: "thinking", text: line.thinking }, {});
        } else if (line.type === "call" && typeof line.tool === "string") {
          check(agent, "tool-call", { watch: "arguments", tool: line.tool, args: line.args ?? null }, { tool: line.tool, ...(typeof line.callId === "string" ? { callId: line.callId } : {}) });
        } else if (line.type === "result" && typeof line.tool === "string" && typeof line.result === "object" && line.result !== null) {
          check(agent, "tool-result", { watch: "result", tool: line.tool, result: line.result as unknown as ToolResult }, { tool: line.tool, ...(typeof line.callId === "string" ? { callId: line.callId } : {}) });
        }
      }
    }
    const reply = await env.files.read(at, `${folder}${RELEASED_FILE}`);
    if (reply.status === "read" && reply.text.trim() !== "" && (rule.agents === "all" || rule.agents.includes(lead))) check(leadRef, "stream", { watch: "reply", text: reply.text }, {});
  } else if (when.trigger === "moment" || when.trigger === "interval") {
    let due = true;
    if (when.trigger === "interval") {
      const count = await d.book.with(at, (file) => {
        const tip = file.log.tip(turn);
        return tip === undefined ? 0 : file.log.path(tip).filter((entry) => entry.type === "turn").length;
      });
      due = count > 0 && count % when.every === 0;
    }
    const command = when.trigger === "moment" ? when.command : undefined;
    const allFacts = createFacts(env.facts, () => ({}));
    let facts: Record<string, FactValue> = {};
    // A rule's command is told every fact of the moment, as the run tells it.
    if (due && (when.fact !== undefined || command !== undefined)) facts = await allFacts.read(at, leadRef, command !== undefined ? allFacts.defs().map((def) => def.name) : [when.fact?.name ?? ""]);
    const checked = checkRule(rule, { facts }, terms);
    let said: string | undefined;
    if (due && "holds" in checked && checked.holds && command !== undefined && when.trigger === "moment") {
      const input = { moment: when.at, agent: { id: leadRef.id, definition: leadRef.definition }, place: { chat: at.chat, session: at.session, turn }, facts } as unknown as JsonValue;
      const answer = await askRuleCommand({ rule: rule.name, command, user: at.user, input, timeoutMs: settings.ruleCommandTimeout, readMost: settings.answerMax, switches: env.switches });
      // A command that waits, is off or could not answer did not fire it; the last is said as unable to work, never as a no.
      if (typeof answer === "object") throw new Error(`The rule's command could not answer (${answer.failed}).`);
      said = answer;
    }
    if (due && "holds" in checked && checked.holds && (command === undefined || said === "yes")) {
      const value = when.fact === undefined ? undefined : facts[when.fact.name];
      fire(leadRef, when.trigger === "interval" ? "interval" : when.at, { ...(value !== undefined && when.fact !== undefined ? { fact: { name: when.fact.name, value } } : {}), ...(said !== undefined ? { matched: said } : {}) });
    }
  } else if (when.trigger === "question") {
    // A run of its own, shown in the live view, in which the judging model is asked about each recorded message as the run asked it then.
    const run = d.ids();
    const trace = new RunTrace(d.hub.tee(env.trace, at, () => settings.liveBacklog), at, run, env.clock, d.hub.hold(run));
    const rules = createRuleRun({ scope: at, rules: [rule], read: async () => [rule], facts: createFacts(env.facts, () => ({})), patternTime: settings.patternTime });
    const judges = new Judges({
      env,
      trace,
      guidance,
      rules,
      ids: d.ids,
      models: d.models,
      connections: d.connections,
      settings,
      budget: new Budget("turn", {}),
      // The Author's connection: the past turn's lead's, else the asking agent's own.
      author: async (agent) => connectionOf(d.connections, at, (await guidance.definition(leadRef.definition)) ?? (await guidance.definition(agent.definition)) ?? {}, env.log, settings),
      track: () => () => undefined,
      late: () => undefined,
    });
    d.hub.started({ run, scope: at, what: "turn", agents: [], started: env.clock.now() });
    try {
      const asked: Promise<{ agent: AgentRef; judged: Judged | undefined }>[] = [];
      for (const { agent, lines } of agents) {
        let call = 0;
        for (const line of lines) {
          if (line.type !== "message") continue;
          call += 1;
          for (const judgment of judges.ask({ agent, call, text: typeof line.text === "string" ? line.text : "", thinking: typeof line.thinking === "string" ? line.thinking : "" })) asked.push(judgment.answer.then((judged) => ({ agent, judged })));
        }
      }
      const reply = await env.files.read(at, `${folder}${RELEASED_FILE}`);
      if (reply.status === "read" && reply.text.trim() !== "" && (rule.agents === "all" || rule.agents.includes(lead))) for (const answer of judges.released(leadRef, reply.text)) asked.push(answer.then((judged) => ({ agent: leadRef, judged })));
      for (const { agent, judged } of await Promise.all(asked)) if (judged !== undefined) firings.push({ ...judged.fired.firing, agent, action: judged.deliver === "briefing" ? "briefing" : "remind" });
      await judges.settled();
    } finally {
      d.hub.ended(run);
      await env.trace.flush();
    }
  } else {
    // An always-on rule is in the stack of every turn of the agents it names: it would have been there.
    fire(leadRef, "turn-start", {});
  }
  return { rule: rule.name, turn, fired: firings.length > 0, firings };
}
