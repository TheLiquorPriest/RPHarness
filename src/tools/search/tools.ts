// `tool_search` and `tool_use` (§6.8): an agent's way to every tool it may reach beyond its fixed
// list. `tool_search` finds them by words and says what each does and takes; `tool_use` calls one,
// which then runs as itself (`ToolReach.run`). Neither adds anything to the tools an agent's
// requests carry, so the cached front of every prompt holds through a session. Their words are the
// lines of `.prompts/tool-search.md`.
import type { AgentRef, JsonValue, Switchable, SwitchesPort } from "../../contract";
import type { Guidance } from "../../files/api";
import { fit } from "../../loop/fit";
import { answer, argumentsOf, fieldsOf, invalidFields, type OwnTool, text, type ToolText, whole, type Words } from "../kit";
import { plainRank, type Rank } from "./rank";
import { Reach, type ReachableTool, TOOL_SEARCH, TOOL_USE, type ToolReach } from "./reach";
import { takes } from "./takes";

/** The prompt part that holds every line these tools answer with (`.prompts/tool-search.md`). */
export const SEARCH_PART = "tool-search";

/** The family these two tools belong to, as the `.tools/` guides group tools. */
const FAMILY = "tools";

/** What tool search is made with. */
export interface ToolSearchDeps {
  /** What the registry and the gate give it. */
  reach: ToolReach;
  /** The host's switches; without them everything that runs a command or calls out is off. */
  switches?: SwitchesPort;
  /** The guidance of the scope the tools serve: the lines they answer in, and each family's guide (`.tools/<family>.md`). */
  guidance: Pick<Guidance, "part" | "tool">;
  /**
   * The tool answers' lines (`.prompts/tool-notices.md`): a found tool's arguments that do not fit
   * are answered with the same line as a fixed tool's (`invalid`).
   */
  notices: Words;
  /** Characters of a tool's schema that the answer to a call that does not fit it shows whole (`tools.schemaShown`). */
  schemaShown: number;
  /** Each tool's file, by tool name. */
  texts: ReadonlyMap<string, ToolText>;
  /** The most tools one search gives when the agent names no limit (the user's `tools.search`). */
  hits: number;
  /** The most one call takes (the user's `tools.perCall`): a limit the agent names is held to it. */
  perCall: number;
  /** How the tools a search covers are ordered; `plainRank` when absent. */
  rank?: Rank;
  /**
   * The families whose guide a search has given in the calling agent's session, kept where the
   * session is (its cache); absent: kept for as long as these tools are, which is the session of a
   * run that ends with them.
   */
  guidesGiven?: GuidesGiven;
}

/** The families whose guide a search gave in an agent's session: each guide is given once a session. */
export interface GuidesGiven {
  given(agent: AgentRef): Promise<ReadonlySet<string>>;
  add(agent: AgentRef, families: readonly string[]): Promise<void>;
}

/** Guides given, kept in memory by agent for as long as the tools are. */
function guidesInMemory(): GuidesGiven {
  const byAgent = new Map<string, Set<string>>();
  return {
    given: async (agent) => byAgent.get(agent.id) ?? new Set(),
    add: async (agent, families) => {
      const given = byAgent.get(agent.id) ?? new Set();
      for (const family of families) given.add(family);
      byAgent.set(agent.id, given);
    },
  };
}

/** The answers' lines as the guidance has them; a line the file does not have is no words. */
async function wordsOf(guidance: Pick<Guidance, "part">): Promise<Words> {
  const part = await guidance.part(SEARCH_PART);
  const lines = part?.format === "lines" ? part : undefined;
  return (name, fields) => lines?.line(name, fields);
}

export function toolSearch(deps: ToolSearchDeps): OwnTool {
  const own = deps.texts.get(TOOL_SEARCH);
  const guides = deps.guidesGiven ?? guidesInMemory();
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
      const view = new Reach(reach, deps.switches, ctx.scope.user);
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
      const shown = found.slice(0, Math.min(whole(given, "limit") ?? deps.hits, deps.perCall));
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
      // The guide of each family a find is of (R-66), once a session: a family of its fixed list has its guide in the opening; one an earlier search gave is named, not repeated.
      const fixedFamilies = new Set(reach.tools.filter((tool) => reach.fixed.includes(tool.name)).map((tool) => tool.family));
      const guided = await guides.given(ctx.agent);
      const families = [...new Set(shown.map((tool) => tool.family))].filter((family) => !fixedFamilies.has(family) && !reach.tools.some((tool) => tool.name === family));
      const read = await Promise.all(families.filter((family) => !guided.has(family)).map(async (family) => ({ family, part: await deps.guidance.tool(family) })));
      const fresh = read.flatMap(({ family, part }) => (part?.format === "template" ? [{ family, text: part.render().text.trim() }] : [])).filter(({ text }) => text !== "");
      if (fresh.length > 0) await guides.add(ctx.agent, fresh.map(({ family }) => family));
      const guideLines = [...fresh.map(({ family, text }) => words("guide", { family, guide: text })), ...families.filter((family) => guided.has(family)).map((family) => words("guide_given", { family }))].filter((line): line is string => line !== undefined && line !== "");
      const details: JsonValue = { found: shown.map((tool) => tool.name), waiting: [...waiting.values()].map((thing) => thing.name), guides: fresh.map(({ family }) => family) };
      if (shown.length === 0 && waiting.size === 0) return { ...answer(words("none_found", { words: asked })), details };
      const said = [...(lines.length === 0 ? [] : [lines.join("\n")]), ...guideLines];
      return { ...answer(said.length === 0 ? undefined : said.join("\n\n")), details };
    },
  };
}

export function toolUse(deps: ToolSearchDeps): OwnTool {
  const own = deps.texts.get(TOOL_USE);
  return {
    name: TOOL_USE,
    family: FAMILY,
    carrier: true,
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ name: { type: "string" }, args: { type: "object" } }, ["name"], own),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const name = (text(given, "name") ?? "").trim();
      const [words, reach] = await Promise.all([wordsOf(deps.guidance), deps.reach.of(ctx.agent)]);
      const at = await new Reach(reach, deps.switches, ctx.scope.user).named(name);
      if (at.at === "unreached") return answer(words("no_tool", { tool: name }), true);
      if (at.at === "waiting") return { ...answer(words("not_switched_on", { tool: name, name: at.thing.name }), true), refused: { by: "switch", thing: at.thing, state: "waiting" } };
      const sent = given["args"] ?? {};
      const checked = fit(at.tool, sent, ctx.callId);
      if ("misfits" in checked) return answer(deps.notices("invalid", invalidFields({ tool: name, arguments: JSON.stringify(sent), parameters: JSON.stringify(at.tool.parameters), misfits: checked.misfits }, deps.schemaShown)), true);
      return deps.reach.run(at.tool, checked.args, ctx);
    },
  };
}
