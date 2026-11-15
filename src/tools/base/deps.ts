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

/** The tool answers every tool shares (`.prompts/tool-notices.md`): among them, why a path an agent names is refused. */
const NOTICES_PART = "tool-notices";

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
  /** The hits `gap_check` takes from each place when the agent names no limit (the user's `tools.gapCheck`). */
  gapHits: number;
  /**
   * The most one call takes (the user's `tools.perCall`): the messages `chat_read` gives, the
   * entries `lore_read` reads, and the hits a search asks each place for and keeps. A limit the
   * agent names is held to it before the host is asked, and what comes back past it is not kept.
   */
  perCall: number;
}

/** A lines part's lines as the guidance has them; a line the file does not have is no words. */
async function linesOf(guidance: Pick<Guidance, "part">, name: string): Promise<Words> {
  const part = await guidance.part(name);
  const lines = part?.format === "lines" ? part : undefined;
  return (line, fields) => lines?.line(line, fields);
}

/** The answers' lines as the guidance has them; a line the file does not have is no words. */
export function wordsOf(guidance: Pick<Guidance, "part">): Promise<Words> {
  return linesOf(guidance, BASE_PART);
}

/** The tool answers' lines every tool shares, as the guidance has them. */
export function noticesOf(guidance: Pick<Guidance, "part">): Promise<Words> {
  return linesOf(guidance, NOTICES_PART);
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

/** A limit the agent named, held to the most one call takes. None named stays none, so the host's own cap holds. */
export function heldLimit(named: number | undefined, most: number): number | undefined {
  return named === undefined ? undefined : Math.min(named, most);
}

/** The texts of a list argument; anything else is none. */
export function textsOf(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
