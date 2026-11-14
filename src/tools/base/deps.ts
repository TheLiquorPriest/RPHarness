// What RPH's base tools over the host's ports are made with (§6.8, Appendix A), and the words they
// answer in: the lines of the prompt part `base-tools`, read through the turn's guidance when a tool
// is called. Each tool's description and its arguments' are its own file in `.tools/`, read by the
// harness with its other tools' files (`BASE_TOOLS`).
import type { Environment, JsonValue, WebSearchPort } from "../../contract";
import type { Guidance } from "../../files/api";
import type { LoopToolResult } from "../../loop/types";
import { answer, type ToolText, type Words } from "../kit";

/** The prompt part that holds every line these tools answer with (`.prompts/base-tools.md`). */
export const BASE_PART = "base-tools";

/** What the base tools are made with. */
export interface BaseToolsDeps {
  /** The host's ports they work over. */
  env: Pick<Environment, "chat" | "lore" | "searchers" | "stores" | "files" | "events" | "log">;
  /** The guidance of the scope the tools serve: the answers' lines, and the skills `skill_load` gives. */
  guidance: Pick<Guidance, "part" | "skill">;
  /** Each tool's file, by tool name. */
  texts: ReadonlyMap<string, ToolText>;
  /** Makes a gap check's id. */
  ids(): string;
  /** The host's web searcher; without one there is no `web_search`. */
  web?: WebSearchPort;
  /** The hits `gap_check` takes from each place when the agent names no limit; `GAP_HITS` when absent. */
  gapHits?: number;
}

/** The answers' lines as the guidance has them; a line the file does not have is no words. */
export async function wordsOf(guidance: Pick<Guidance, "part">): Promise<Words> {
  const part = await guidance.part(BASE_PART);
  const lines = part?.format === "lines" ? part : undefined;
  return (name, fields) => lines?.line(name, fields);
}

/** Lines in order, those the file does not have (or that came out empty) left out. */
export function shown(lines: readonly (string | undefined)[]): string[] {
  return lines.filter((line): line is string => line !== undefined && line !== "");
}

/** An answer made of lines of the file, in order, those it does not have left out. */
export function linesAnswer(lines: readonly (string | undefined)[], between: string, error = false): LoopToolResult {
  const kept = shown(lines);
  return answer(kept.length === 0 ? undefined : kept.join(between), error);
}

/** The texts of a list argument; anything else is none. */
export function textsOf(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
