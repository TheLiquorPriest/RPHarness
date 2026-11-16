// The folder host's own limits (Appendix D's rule: every limit a setting), from `host/config.json`
// as it stands each time one is used, today's numbers where it sets none:
//
//   { "files": { "findLimit": 200, "grepBytes": 1048576, "grepLine": 1000, "listDepth": 1 },
//     "search": { "hits": 20, "snippet": 80 },
//     "tools": { "commandTimeout": 30, "answerMax": 1048576 } }
//
// A value that is not a whole number above 0 is passed over for the default. A file that does not
// read is the defaults whole.

import { join } from "node:path";
import { isRecord } from "../../contract/json";
import { readJson } from "./disk";
import type { Site } from "./site";

export interface HostLimits {
  /** The most hits a find gives when its query names no limit. */
  findLimit: number;
  /** Files larger than this many bytes are passed over by grep. */
  grepBytes: number;
  /** A grep hit's line is cut to this many UTF-16 code units. */
  grepLine: number;
  /** How many folders deep a list goes when its query names no depth. */
  listDepth: number;
  /** The most hits a chat or lore search gives when its query names no limit. */
  searchHits: number;
  /** How much text a snippet shows on each side of the first word it matched. */
  snippet: number;
  /** Seconds one of the manifest's command tools may run. */
  commandTimeout: number;
  /** The most bytes read of a command tool's answer. */
  answerMax: number;
}

/** Today's numbers. */
export const HOST_LIMITS: Readonly<HostLimits> = Object.freeze({ findLimit: 200, grepBytes: 1024 * 1024, grepLine: 1000, listDepth: 1, searchHits: 20, snippet: 80, commandTimeout: 30, answerMax: 1024 * 1024 });

function whole(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** The limits as `host/config.json` sets them now. */
export async function hostLimits(site: Site): Promise<HostLimits> {
  const raw: unknown = await readJson(join(site.host, "config.json")).catch(() => undefined);
  const group = (name: string): Record<string, unknown> => (isRecord(raw) && isRecord(raw[name]) ? raw[name] : {});
  const files = group("files");
  const search = group("search");
  const tools = group("tools");
  return {
    findLimit: whole(files.findLimit, HOST_LIMITS.findLimit),
    grepBytes: whole(files.grepBytes, HOST_LIMITS.grepBytes),
    grepLine: whole(files.grepLine, HOST_LIMITS.grepLine),
    listDepth: whole(files.listDepth, HOST_LIMITS.listDepth),
    searchHits: whole(search.hits, HOST_LIMITS.searchHits),
    snippet: whole(search.snippet, HOST_LIMITS.snippet),
    commandTimeout: whole(tools.commandTimeout, HOST_LIMITS.commandTimeout),
    answerMax: whole(tools.answerMax, HOST_LIMITS.answerMax),
  };
}
