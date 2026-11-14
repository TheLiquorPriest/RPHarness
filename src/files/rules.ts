// Rules (§5.4): one format, two kinds. Always on: a description, who it is for, and the text, which
// joins the stack of the agents it names. Triggered: it adds what makes it fire (a pattern with
// where to look, a question, a moment with or without a fact, or a count of turns), how often it
// may (`repeat:`), and for a pattern whether it stops the call (`interrupt:`) or holds the tool
// (`hold:`), and whether the case of its letters counts (`case: ignore` finds `A testament to` as
// well as `a testament to`; left out, it counts). A rule that cannot be read whole is broken and is
// not in force: guessing at half of one would put words in front of an agent that the user did not
// ask for. So is a pattern that could take time without end on some text (`patternRisk`): every
// user's turns run in one process, and a running pattern cannot be stopped.

import type { FileText, RuleTrigger } from "../contract/index";
import type { Problem, Replaced, Template } from "./api";
import { RULE_FIELDS } from "./api";
import type { FactTest } from "./facts";
import { FACT_FORM, parseFactTest } from "./facts";
import { fieldLine, nameList, problemAt, splitHeader, unknownFields } from "./header";
import { parseTemplate } from "./template";

/**
 * Where a rule looks (`scope:`): the agent's text, its thinking, the reply, a tool's arguments (as
 * JSON text), or a tool's result (its text, then its reports, then a line `marked <mark>` for each
 * mark). For a tool's, `tool` is a tool's name or a glob of names (`*` for any): `result:*`.
 */
export type RuleScope = { watch: "text" | "thinking" | "reply" } | { watch: "arguments" | "result"; tool: Bun.Glob; written: string };

/** How often a rule may fire: once per turn (the default), once per session, again only after so many turns, or always. */
export type Repeat = { per: "turn" } | { per: "session" } | { per: "always" } | { per: "turns"; turns: number };

/** The moments `at:` can name. */
export type RuleMomentName = "turn-start" | "run-end" | "before-compaction";
const MOMENTS: readonly RuleMomentName[] = ["turn-start", "run-end", "before-compaction"];

/** What makes a rule fire. */
export type RuleWhen =
  | { trigger: "always" }
  | { trigger: "pattern"; pattern: RegExp; scope: RuleScope[]; interrupt: boolean; hold: boolean }
  | { trigger: "question"; question: string; scope: RuleScope[] }
  | { trigger: "moment"; at: RuleMomentName; fact?: FactTest }
  | { trigger: "interval"; every: number; fact?: FactTest };

export interface Rule {
  /** Its file's name, without `.md`. */
  name: string;
  description: string;
  /** Who it is for: every agent, or the definitions it names. */
  agents: "all" | string[];
  /** Files it is in force only while they are: a rule's name, or an instruction file's (`TURN`). */
  needs: string[];
  /** For an always-on rule: the situations it is for (`swipe`); it is handed over for those turns' briefings. */
  turns?: string[];
  when: RuleWhen;
  repeat: Repeat;
  /** Its body, a template filled from the facts' fields and, for a pattern, `matched` and `tool`. */
  text: Template;
  path: string;
  level: FileText["level"];
  hash: string;
  replaces: Replaced[];
  /** The file's lines of its `fact:`, its `needs:`, its `question:` and its body's start, for problems found later. */
  lines: { fact?: number; needs?: number; question?: number; body: number };
}

/** A rule file read: the rule, or what the Rules page can still show of a broken one. */
export interface ReadRule {
  rule?: Rule;
  description: string;
  agents: "all" | string[];
  trigger?: RuleTrigger;
  problems: Problem[];
}

const SCOPE_FORM = "`scope:` says where to look: text, thinking, reply, arguments or result, and for a tool's `arguments:<tool>` or `result:<tool>` (`result:*` for any tool)";
const REPEAT_FORM = "`repeat:` is `once per turn` (what it is when left out), `once per session`, `after 6 turns` or `always`";

/**
 * How many repeats with no bound (`*`, `+`, `{2,}`) a pattern may hold. Each one more lets the time
 * a pattern takes on a text grow by the text's length once more. Measured on Bun 1.4.0, over 500
 * characters it cannot match: `.*.*z` 27 ms, `.*.*.*z` 2.6 s.
 */
const MOST_OPEN_REPEATS = 2;

/** The repeat that starts at `at` in a pattern, if one does: its length (a lazy `?` after it included), whether it may match more than once, and whether it has no bound. */
function repeatAt(source: string, at: number): { length: number; many: boolean; open: boolean } | undefined {
  const c = source[at];
  let length: number;
  let max: number;
  if (c === "*" || c === "+") {
    length = 1;
    max = Number.POSITIVE_INFINITY;
  } else if (c === "?") {
    length = 1;
    max = 1;
  } else if (c === "{") {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
    if (m === null) return undefined;
    length = m[0].length;
    max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Number.POSITIVE_INFINITY : Number(m[3]);
  } else return undefined;
  if (source[at + length] === "?") length += 1;
  return { length, many: max > 1, open: max === Number.POSITIVE_INFINITY };
}

/**
 * Why a pattern could take time without end on some text, or undefined when it cannot: it refers
 * back to a group it matched; it repeats a group that holds a repeat or alternatives of its own
 * (`(a+)+`, `(a|ab)*`), which takes twice as long for each character more; or it holds more than
 * `MOST_OPEN_REPEATS` repeats with no bound.
 */
export function patternRisk(source: string): string | undefined {
  /** Each group open at this point, innermost last: whether it holds a repeat, and alternatives. */
  const groups: { repeats: boolean; alternatives: boolean }[] = [];
  let open = 0;
  let inClass = false;
  /** The group that closed just before this character, which a repeat here would repeat. */
  let closed: { repeats: boolean; alternatives: boolean } | undefined;
  for (let at = 0; at < source.length; at += 1) {
    const c = source[at];
    const before = closed;
    closed = undefined;
    if (c === "\\") {
      const next = source[at + 1] ?? "";
      if (!inClass && (/[1-9]/.test(next) || (next === "k" && source[at + 2] === "<"))) return "The pattern refers back to a group it matched (`\\1`, `\\k<name>`). Such a pattern can take time without end on some text, so the rule is not in force.";
      at += 1;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") {
      groups.push({ repeats: false, alternatives: false });
      // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!` and `(?<name>` say what kind of group it is; none of it is a repeat.
      if (source[at + 1] === "?") at = source[at + 2] !== "<" ? at + 2 : source[at + 3] === "=" || source[at + 3] === "!" ? at + 3 : Math.max(at, source.indexOf(">", at));
    } else if (c === ")") {
      const group = groups.pop();
      const outer = groups.at(-1);
      if (group !== undefined && outer !== undefined) {
        outer.repeats ||= group.repeats;
        outer.alternatives ||= group.alternatives;
      }
      closed = group;
    } else if (c === "|") {
      const group = groups.at(-1);
      if (group !== undefined) group.alternatives = true;
    } else {
      const repeat = repeatAt(source, at);
      if (repeat === undefined) continue;
      at += repeat.length - 1;
      if (!repeat.many) continue;
      if (before !== undefined && (before.repeats || before.alternatives))
        return "The pattern repeats a group that holds a repeat or alternatives of its own, as `(a+)+` and `(a|ab)*` do. Such a pattern can take time without end on some text, so the rule is not in force. Repeat what is inside the group instead: `a+`, `(a|ab)`.";
      if (repeat.open && (open += 1) > MOST_OPEN_REPEATS)
        return `The pattern repeats things with no bound more than ${MOST_OPEN_REPEATS} times (\`*\`, \`+\`, \`{2,}\`). Each such repeat makes the time it can take on a long text grow by the text's length again, so the rule is not in force. Give the others a bound: \`.{0,40}\` in place of \`.*\`.`;
      const group = groups.at(-1);
      if (group !== undefined) group.repeats = true;
    }
  }
  return undefined;
}

function parseScope(value: unknown, allowed: readonly RuleScope["watch"][]): RuleScope[] | undefined {
  const items = nameList(value);
  if (items === undefined || items.length === 0) return undefined;
  const out: RuleScope[] = [];
  for (const item of items) {
    const m = /^(text|thinking|reply|arguments|result)(?::(.*))?$/.exec(item);
    const watch = m?.[1] as RuleScope["watch"] | undefined;
    if (m === null || watch === undefined || !allowed.includes(watch)) return undefined;
    if (watch === "arguments" || watch === "result") {
      const written = m[2]?.trim() || "*";
      out.push({ watch, tool: new Bun.Glob(written), written });
    } else if (m[2] !== undefined) return undefined;
    else out.push({ watch });
  }
  return out;
}

function parseRepeat(value: unknown): Repeat | undefined {
  if (value === undefined || value === null) return { per: "turn" };
  if (typeof value !== "string") return undefined;
  const s = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "once per turn") return { per: "turn" };
  if (s === "once per session") return { per: "session" };
  if (s === "always") return { per: "always" };
  const m = /^after (\d+) turns?$/.exec(s);
  const turns = Number(m?.[1]);
  return m !== null && turns >= 1 ? { per: "turns", turns } : undefined;
}

export function parseRule(file: FileText, name: string, replaces: Replaced[]): ReadRule {
  const at = { path: file.path, level: file.level };
  const split = splitHeader(file.text, at);
  const read: ReadRule = { description: "", agents: [], problems: [...split.problems] };
  const problem = (key: string | undefined, message: string) => read.problems.push(problemAt(at, key === undefined ? undefined : (fieldLine(split.lines, key) ?? 2), message));
  if (!split.has) {
    read.problems.push(problemAt(at, 1, "A rule starts with a header between two `---` lines: a description, who it is for (`agents:`), and what makes it fire if it is not always on. Its text follows the header."));
    return read;
  }
  const h = split.header;
  if (h === undefined) return read;
  read.problems.push(...unknownFields(split, RULE_FIELDS, at, "a rule"));
  let broken = false;
  const fail = (key: string | undefined, message: string) => {
    broken = true;
    problem(key, message);
  };

  if (typeof h.description === "string") read.description = h.description.trim();
  else if (h.description !== undefined) problem("description", "`description:` is one line of text.");

  const listed = h.agents === "all" ? "all" : nameList(h.agents);
  const agents = Array.isArray(listed) && listed.includes("all") ? "all" : listed;
  if (agents === undefined || (agents !== "all" && agents.length === 0)) fail("agents", "It needs `agents:`, who it is for: `agents: all`, or a list of agents by name, `agents: [author, gm]`.");
  else read.agents = agents;

  const needs = nameList(h.needs);
  if (needs === undefined) fail("needs", "`needs:` names the files the rule is in force only while they are: a rule's name or an instruction file's, `needs: TURN`.");

  const triggers = (["condition", "question", "at", "every"] as const).filter((key) => Object.hasOwn(h, key));
  if (triggers.length > 1) fail(triggers[1], `A rule fires on one thing: a pattern (\`condition:\`), a question, a moment (\`at:\`) or a count of turns (\`every:\`). This one has ${triggers.map((t) => `\`${t}:\``).join(" and ")}.`);

  let fact: FactTest | undefined;
  if (Object.hasOwn(h, "fact")) {
    const parsed = typeof h.fact === "string" ? parseFactTest(h.fact) : { error: FACT_FORM };
    if ("error" in parsed) fail("fact", parsed.error);
    else fact = parsed;
  }

  let when: RuleWhen = { trigger: "always" };
  const trigger = triggers[0];
  if (trigger === "condition") {
    read.trigger = "pattern";
    let pattern: RegExp | undefined;
    const ignoreCase = h.case === undefined || h.case === null || h.case === "exact" ? false : h.case === "ignore" ? true : undefined;
    if (ignoreCase === undefined) fail("case", "`case:` is `ignore` to find the pattern whatever the case of its letters, so that `a testament to` finds `A testament to` too; left out, the case counts.");
    if (typeof h.condition !== "string" || h.condition === "") fail("condition", "`condition:` is a pattern to look for, in quotes: `condition: 'a testament to'`.");
    else {
      const risk = patternRisk(h.condition);
      if (risk !== undefined) fail("condition", risk);
      else {
        try {
          pattern = new RegExp(h.condition, ignoreCase === true ? "i" : "");
        } catch (error) {
          fail("condition", `The pattern cannot be read (${error instanceof Error ? error.message : String(error)}). It is a JavaScript regular expression; to look for a character such as ( or ? itself, put \\ before it.`);
        }
      }
    }
    const scope = parseScope(h.scope, ["text", "thinking", "reply", "arguments", "result"]);
    if (scope === undefined) fail(h.scope === undefined ? "condition" : "scope", `${SCOPE_FORM}.`);
    const interrupt = h.interrupt === undefined || h.interrupt === null || h.interrupt === "always" ? true : h.interrupt === "never" ? false : undefined;
    if (interrupt === undefined) fail("interrupt", "`interrupt:` is `never` to let the agent finish what it is writing and be reminded after it; left out, the call is stopped at the match.");
    const hold = h.hold === undefined || h.hold === null ? false : typeof h.hold === "boolean" ? h.hold : undefined;
    if (hold === undefined) fail("hold", "`hold:` is `true` or `false`.");
    if (hold === true && scope !== undefined && !scope.some((s) => s.watch === "arguments")) problem("hold", "`hold:` acts only on a tool's arguments, and this rule does not look at any.");
    if (pattern !== undefined && scope !== undefined && interrupt !== undefined && hold !== undefined) when = { trigger: "pattern", pattern, scope, interrupt, hold };
  } else if (trigger === "question") {
    read.trigger = "question";
    const scope = parseScope(h.scope, ["text", "thinking", "reply"]);
    if (typeof h.question !== "string" || h.question.trim() === "") fail("question", "`question:` is a question the judging model answers yes or no.");
    if (scope === undefined) fail(h.scope === undefined ? "question" : "scope", "`scope:` says what the question is about: text, thinking or reply.");
    if (typeof h.question === "string" && scope !== undefined) when = { trigger: "question", question: h.question.trim(), scope };
  } else if (trigger === "at") {
    read.trigger = "moment";
    const moment = MOMENTS.find((m) => m === h.at);
    if (moment === undefined) fail("at", `\`at:\` is one of ${MOMENTS.join(", ")}.`);
    else when = { trigger: "moment", at: moment, ...(fact !== undefined ? { fact } : {}) };
  } else if (trigger === "every") {
    read.trigger = "interval";
    if (typeof h.every !== "number" || !Number.isInteger(h.every) || h.every < 1) fail("every", "`every:` is a whole number of turns: `every: 10`.");
    else when = { trigger: "interval", every: h.every, ...(fact !== undefined ? { fact } : {}) };
  } else read.trigger = "always";

  if (Object.hasOwn(h, "fact") && trigger !== "at" && trigger !== "every") fail("fact", "`fact:` is tested at a moment: give the rule `at:` (turn-start, run-end or before-compaction) or `every:`.");
  if (trigger !== "condition" && trigger !== "question" && h.scope !== undefined) problem("scope", "`scope:` goes with `condition:` or `question:`, and is not read here.");
  if (trigger !== "condition" && (h.interrupt !== undefined || h.hold !== undefined)) problem(h.interrupt !== undefined ? "interrupt" : "hold", "`interrupt:` and `hold:` go with `condition:`, and are not read here.");
  if (trigger !== "condition" && h.case !== undefined) problem("case", "`case:` goes with `condition:`, and is not read here.");

  const turns = nameList(h.turns);
  if (turns === undefined) fail("turns", "`turns:` names the kinds of turn an always-on rule is for: `turns: [swipe, regenerate]`.");
  else if (turns.length > 0 && trigger !== undefined) problem("turns", "`turns:` is for always-on rules, and is not read on a rule that fires.");

  const repeat = parseRepeat(h.repeat);
  if (repeat === undefined) fail("repeat", `${REPEAT_FORM}.`);

  const text = parseTemplate(split.body, { ...at, firstLine: split.bodyLine });
  read.problems.push(...text.problems);
  if (broken || text.template === undefined || agents === undefined || needs === undefined || repeat === undefined) return read;
  read.rule = {
    name,
    description: read.description,
    agents,
    needs,
    ...(trigger === undefined && turns !== undefined && turns.length > 0 ? { turns } : {}),
    when,
    repeat,
    text: text.template,
    path: file.path,
    level: file.level,
    hash: file.hash,
    replaces,
    lines: {
      ...(fact !== undefined ? { fact: fieldLine(split.lines, "fact") ?? 2 } : {}),
      ...(needs.length > 0 ? { needs: fieldLine(split.lines, "needs") ?? 2 } : {}),
      ...(trigger === "question" ? { question: fieldLine(split.lines, "question") ?? 2 } : {}),
      body: split.bodyLine,
    },
  };
  return read;
}
