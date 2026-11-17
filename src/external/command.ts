// What a command tool and a rule's command answer (§5.4, P15): the runner's result (run.ts) read as
// a tool's answer, or as a rule's yes or no. A tool's JSON answer is its result, as data; anything
// else is said in the tool answers' file's words. The command line comes whole from his file and the
// arguments go on stdin, so nothing an agent sends, nor any lore or chat text, changes what runs.

import type { JsonValue, SwitchesPort, ToolCtx, ToolResult } from "../contract";
import type { RuleCommandAnswer } from "../files/api";
import { answer, type Words } from "../tools/kit";
import { runCommand } from "./run";

/** Characters of what a command or an address said beside a failure that the model is given: enough to say why. */
export const SAID_MOST = 1_000;

/** A tool's answer from the JSON it gave: the JSON as text, which the model reads as data. */
export function dataAnswer(output: JsonValue, details: JsonValue): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(output) }], details };
}

/** A command tool's call: the tool, its command line as written, the arguments, and its terms. */
export interface CommandToolCall {
  tool: string;
  command: string;
  args: JsonValue;
  ctx: ToolCtx;
  timeoutMs: number;
  readMost: number;
  switches: SwitchesPort | undefined;
  words: Words;
}

/** Runs a command tool, its arguments as JSON on stdin, and gives what it answered: its JSON as data, or why there is none, in the file's words. */
export async function callCommandTool(c: CommandToolCall): Promise<ToolResult> {
  const { tool, words } = c;
  const result = await runCommand({ command: c.command, kind: "command-tool", name: tool, user: c.ctx.scope.user, input: c.args, timeoutMs: c.timeoutMs, readMost: c.readMost, signal: c.ctx.signal }, c.switches);
  // The reason goes to the trace as the failed call's; the model is told it failed.
  if (result.status === "failed") throw new Error(`The command could not be started: ${result.why}`);
  if (result.status !== "ran") return answer(words("not_switched_on", { tool, name: tool, kind: "command-tool", ...(result.status === "waiting" ? { waiting: true } : {}) }), true);
  if (c.ctx.signal.aborted) throw new Error("The command was stopped with its run.");
  const details: JsonValue = { ms: result.ms, exit: result.exit, ...(result.stderr.trim() !== "" ? { stderr: result.stderr.slice(-SAID_MOST) } : {}) };
  const failed = (name: string, fields: Record<string, JsonValue>): ToolResult => ({ ...answer(words(name, { tool, ...fields }), true), details });
  if (result.timedOut) return failed("timed_out", { seconds: c.timeoutMs / 1000 });
  if (result.cut) return failed("answer_cut", { bytes: c.readMost });
  if (result.exit !== 0) return failed("command_exit", { code: result.exit ?? "none", ...(result.stderr.trim() !== "" ? { said: result.stderr.trim().slice(-SAID_MOST) } : {}) });
  if (result.output !== undefined) return dataAnswer(result.output, details);
  if (result.text.trim() === "") return { ...answer(words("empty_answer", { tool })), details };
  return failed("not_json", { said: result.text.trim().slice(0, SAID_MOST) });
}

/** A rule's command as it is asked (C5): the rule's name is its name to the switches. */
export interface RuleCommandCall {
  rule: string;
  command: string;
  user: string;
  input: JsonValue;
  timeoutMs: number;
  readMost: number;
  switches: SwitchesPort | undefined;
}

/**
 * Asks a rule's command about the moment: it answers yes or no, as JSON (`true`, `false`, `"yes"`,
 * `"no"`) or as the word alone. One waiting for its switch, or off, runs nothing. A failure, a
 * timeout or an answer that is neither is said in words, for the rule to show as unable to work.
 */
export async function askRuleCommand(c: RuleCommandCall): Promise<RuleCommandAnswer> {
  const result = await runCommand({ command: c.command, kind: "rule-command", name: c.rule, user: c.user, input: c.input, timeoutMs: c.timeoutMs, readMost: c.readMost }, c.switches);
  if (result.status === "failed") return { failed: `it could not be started: ${result.why}` };
  if (result.status !== "ran") return result.status;
  if (result.timedOut) return { failed: `it did not answer within ${c.timeoutMs / 1000} seconds (the setting "rules.commandTimeoutSeconds")` };
  if (result.cut) return { failed: `its answer was longer than ${c.readMost} bytes (the setting "tools.maxAnswerBytes")` };
  const stderr = result.stderr.trim();
  if (result.exit !== 0) return { failed: `it ended with code ${result.exit ?? "none"}${stderr !== "" ? `: ${stderr.slice(-300)}` : ""}` };
  const said = typeof result.output === "boolean" ? String(result.output) : typeof result.output === "string" ? result.output : result.text;
  const word = said.trim().toLowerCase();
  if (word === "yes" || word === "true") return "yes";
  if (word === "no" || word === "false") return "no";
  return { failed: `it answered ${JSON.stringify(result.text.trim().slice(0, 200))}, which is neither yes nor no` };
}
