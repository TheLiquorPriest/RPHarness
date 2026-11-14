// `tool_search` and `tool_use` (§6.8): an agent's way to every tool it may reach beyond its fixed
// list. `tool_search` finds them by words and says what each does and takes; `tool_use` calls one,
// which then runs as itself (`ToolReach.run`). Neither adds anything to the tools an agent's
// requests carry, so the cached front of every prompt holds through a session. Their words are the
// lines of `.prompts/tool-search.md`.
import type { JsonValue, Switchable, SwitchesPort } from "../../contract";
import type { Guidance } from "../../files/api";
import { fit } from "../../loop/fit";
import { answer, argumentsOf, fieldsOf, invalidFields, type OwnTool, text, type ToolText, whole, type Words } from "../kit";
import { plainRank, type Rank } from "./rank";
import { Reach, type ReachableTool, TOOL_SEARCH, TOOL_USE, type ToolReach } from "./reach";
import { takes } from "./takes";

/** The prompt part that holds every line these tools answer with (`.prompts/tool-search.md`). */
export const SEARCH_PART = "tool-search";

/** The most tools one search gives when the agent names no limit. */
export const SEARCH_HITS = 8;

/** The family these two tools belong to, as the `.tools/` guides group tools. */
const FAMILY = "tools";

/** What tool search is made with. */
export interface ToolSearchDeps {
  /** What the registry and the gate give it. */
  reach: ToolReach;
  /** The host's switches; without them everything that runs a command or calls out is off. */
  switches?: SwitchesPort;
  /** The guidance of the scope the tools serve: the lines they answer in. */
  guidance: Pick<Guidance, "part">;
  /**
   * The tool answers' lines (`.prompts/tool-notices.md`): a found tool's arguments that do not fit
   * are answered with the same line as a fixed tool's (`invalid`).
   */
  notices: Words;
  /** Characters of a tool's schema that the answer to a call that does not fit it shows whole (`tools.schemaShown`). */
  schemaShown: number;
  /** Each tool's file, by tool name. */
  texts: ReadonlyMap<string, ToolText>;
  /** The most tools one search gives when the agent names no limit; `SEARCH_HITS` when absent. */
  hits?: number;
  /** How the tools a search covers are ordered; `plainRank` when absent. */
  rank?: Rank;
}

/** The answers' lines as the guidance has them; a line the file does not have is no words. */
async function wordsOf(guidance: Pick<Guidance, "part">): Promise<Words> {
  const part = await guidance.part(SEARCH_PART);
  const lines = part?.format === "lines" ? part : undefined;
  return (name, fields) => lines?.line(name, fields);
}

export function toolSearch(deps: ToolSearchDeps): OwnTool {
  const own = deps.texts.get(TOOL_SEARCH);
  return {
    name: TOOL_SEARCH,
    family: FAMILY,
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ words: { type: "string" }, limit: { type: "integer", minimum: 1 } }, ["words"], own),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const asked = (text(given, "words") ?? "").trim();
      const [words, reach] = await Promise.all([wordsOf(deps.guidance), deps.reach.of(ctx.agent)]);
      if (asked === "") return answer(words("no_words"), true);
      const view = new Reach(reach, deps.switches);
      const standings = await Promise.all(reach.tools.map((tool) => view.standing(tool)));
      // A tool that waits to be switched on is found by the same words, and named as waiting rather than offered.
      const waitingOn = new Map<ReachableTool, Switchable>();
      const covered: ReachableTool[] = [];
      for (const at of standings) {
        if (at.at === "found") covered.push(at.tool);
        if (at.at === "waiting") {
          covered.push(at.tool);
          waitingOn.set(at.tool, at.thing);
        }
      }
      const ranked = (deps.rank ?? plainRank)(covered, asked);
      const found = ranked.filter((tool) => !waitingOn.has(tool));
      const shown = found.slice(0, whole(given, "limit") ?? deps.hits ?? SEARCH_HITS);
      // Each thing that waits once, with its tools the words found, in the order they were ranked.
      const waiting = new Map<string, { name: string; tools: string[] }>();
      for (const tool of ranked) {
        const thing = waitingOn.get(tool);
        if (thing === undefined) continue;
        const key = `${thing.kind}\n${thing.name}`;
        const entry = waiting.get(key) ?? { name: thing.name, tools: [] };
        entry.tools.push(tool.name);
        waiting.set(key, entry);
      }
      // A value whose schema gives no type is written in the file's word for it.
      const untyped = words("untyped") ?? "";
      const lines = [
        ...shown.map((tool) => words("found", { name: tool.name, family: tool.family, line: tool.description.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "", takes: takes(tool.parameters, untyped) })),
        ...(found.length > shown.length ? [words("more", { count: found.length - shown.length })] : []),
        ...[...waiting.values()].map((thing) => words("waiting", thing)),
      ].filter((line): line is string => line !== undefined && line !== "");
      const details: JsonValue = { found: shown.map((tool) => tool.name), waiting: [...waiting.values()].map((thing) => thing.name) };
      if (shown.length === 0 && waiting.size === 0) return { ...answer(words("none_found", { words: asked })), details };
      return { ...answer(lines.length === 0 ? undefined : lines.join("\n")), details };
    },
  };
}

export function toolUse(deps: ToolSearchDeps): OwnTool {
  const own = deps.texts.get(TOOL_USE);
  return {
    name: TOOL_USE,
    family: FAMILY,
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ name: { type: "string" }, args: { type: "object" } }, ["name"], own),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const name = (text(given, "name") ?? "").trim();
      const [words, reach] = await Promise.all([wordsOf(deps.guidance), deps.reach.of(ctx.agent)]);
      const at = await new Reach(reach, deps.switches).named(name);
      if (at.at === "unreached") return answer(words("no_tool", { tool: name }), true);
      if (at.at === "waiting") return answer(words("not_switched_on", { tool: name, name: at.thing.name }), true);
      const sent = given["args"] ?? {};
      const checked = fit(at.tool, sent, ctx.callId);
      if ("misfits" in checked) return answer(deps.notices("invalid", invalidFields({ tool: name, arguments: JSON.stringify(sent), parameters: JSON.stringify(at.tool.parameters), misfits: checked.misfits }, deps.schemaShown)), true);
      return deps.reach.run(at.tool, checked.args, ctx);
    },
  };
}
