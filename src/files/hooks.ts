// His hooks' file (§5.4 "Hooks", PlanHarnessCore-2): `hooks.yml` in a level's hooks folder (the
// global `.hooks/`, the chat's `hooks/`), each moment a hook runs at to the hooks it runs, in order:
//
//   before-tool:
//     - name: sourced-writes
//       command: ./check-source.sh
//       timeout: 10
//
// A file that does not parse, a moment that is none, or a hook without its name or its command is a
// problem at its line on the Files page, and that hook is left out; nothing is guessed. The examples
// under `<hooks>/examples/` are never read as hooks.

import type { FileText, HookEvent } from "../contract/index";
import type { HookEntry } from "../external/hooks";
import type { Problem } from "./api";
import { isMapping, normalized, parseYaml, problemAt, WrittenItems } from "./header";

/** The file a level's hooks are written in, inside its hooks folder. */
export const HOOKS_FILE = "hooks.yml";

/** Every moment a hook can run at, as `hooks.yml` writes it. */
export const HOOK_EVENTS: readonly HookEvent[] = ["turn-start", "before-tool", "after-tool", "before-release", "after-release", "run-end", "session-close", "before-compaction", "job-start", "job-end"];

const HOOK_FIELDS = ["name", "command", "timeout"];

/** The hooks of one `hooks.yml`, in the order written, moment by moment; and what of it cannot be read. */
export function parseHooks(file: FileText): { hooks: HookEntry[]; problems: Problem[] } {
  const at = { path: file.path, level: file.level };
  const lines = normalized(file.text).split("\n");
  const problems: Problem[] = [];
  const parsed = parseYaml(lines, 1, at, HOOKS_FILE);
  if ("problem" in parsed) return { hooks: [], problems: [parsed.problem] };
  if (parsed.value === null || parsed.value === undefined) return { hooks: [], problems };
  if (!isMapping(parsed.value)) return { hooks: [], problems: [problemAt(at, 1, `${HOOKS_FILE} names each moment and the hooks it runs: \`before-tool: [{ name: sourced-writes, command: ./check-source.sh }]\`.`)] };
  const hooks: HookEntry[] = [];
  const named = new Set<string>();
  for (const [moment, value] of Object.entries(parsed.value)) {
    const items = new WrittenItems(lines, moment, 1);
    if (!(HOOK_EVENTS as readonly string[]).includes(moment)) {
      problems.push(problemAt(at, items.field, `\`${moment}\` is not a moment a hook runs at, so its hooks are not read. The moments are: ${HOOK_EVENTS.join(", ")}.`));
      continue;
    }
    const on = moment as HookEvent;
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value)) {
      problems.push(problemAt(at, items.field, `\`${moment}:\` is a list of hooks, each with a name and a command: \`- { name: sourced-writes, command: ./check-source.sh }\`.`));
      continue;
    }
    value.forEach((given: unknown, i) => {
      const name = isMapping(given) && typeof given.name === "string" ? given.name.trim() : "";
      const line = (name !== "" ? items.find(name) : undefined) ?? items.field;
      const problem = (message: string) => problems.push(problemAt(at, line, `Hook ${name !== "" ? name : i + 1} of \`${moment}:\`: ${message}`));
      if (!isMapping(given)) return problem("a hook is `{ name, command }`, with a `timeout` in seconds where it needs its own, so it is left out.");
      const command = typeof given.command === "string" ? given.command.trim() : "";
      if (name === "" || command === "") return problem("it needs a `name` and a `command`, so it is left out.");
      if (named.has(name)) return problem("another hook in this file has the name, so this one is left out.");
      const timeout = given.timeout;
      if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1)) return problem("`timeout` is a whole number of seconds, 1 or more, so it is left out.");
      for (const key of Object.keys(given)) if (!HOOK_FIELDS.includes(key)) problem(`\`${key}\` is not a field a hook has, and is not read. Its fields are: ${HOOK_FIELDS.join(", ")}.`);
      named.add(name);
      hooks.push({ name, on, command, ...(typeof timeout === "number" ? { timeout } : {}), path: file.path, level: file.level, line: line ?? 1 });
    });
  }
  return { hooks, problems };
}
