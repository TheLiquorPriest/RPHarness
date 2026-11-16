// What RPH tells the folder host (Appendix A `TurnEvents`), kept as lines of
// `host/chats/<chat>/events.jsonl` (a job of no chat's in its user's own records). The folder host has no views of its own to attach, so it
// resolves no attachment and only keeps the list. Dropping an agent's writes puts back each file
// that agent wrote this turn, as it was before the agent's first write, unless someone changed the
// file after the agent's last write; such a file is kept, and the record says so.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Clock, RunScope, Scope, TurnEvents } from "../../contract/index";
import type { Serial } from "./disk";
import { readLines, sha256, writeWhole } from "./disk";
import { journalPath } from "./files";
import type { JournalLine } from "./shape";
import { journalLine } from "./shape";
import type { Site } from "./site";
import { locate } from "./view";

/** Where a run's events are kept: its chat's records, or its user's for a job of no chat. */
export function eventsPath(site: Site, scope: RunScope): string {
  return join(site.recordsOf(scope), "events.jsonl");
}

export function folderEvents(site: Site, clock: Clock, fileSerial: Serial): TurnEvents {
  async function keep(scope: RunScope, kind: string, fields: Record<string, unknown>): Promise<void> {
    const path = eventsPath(site, scope);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ at: clock.now(), scope, kind, ...fields })}\n`, "utf8");
  }

  return {
    intent: (scope, text) => keep(scope, "intent", { text }),

    async attachments(scope, agent, refs) {
      await keep(scope, "attachments", { agent, refs: refs.map((r) => ({ ref: r.ref, from: r.from, own: r.own })) });
      return [];
    },

    consent: (scope, grant) => keep(scope, "consent", { grant }),

    gapCheck: (scope, check) => keep(scope, "gapCheck", { check }),

    async dropStaged(scope, agent) {
      site.check(scope);
      const { restored, kept } = scope.turn === undefined ? { restored: [], kept: [] } : await putBack(site, fileSerial, scope, scope.turn, (line) => line.agent.id === agent.id);
      await keep(scope, "dropStaged", { agent, restored, kept });
    },

    ruleFired: (scope, firing) => keep(scope, "ruleFired", { firing }),

    // A folder keeps every suggestion it is handed: it has no list of open ones to fill.
    suggestion: async (scope, agent, suggestion) => {
      const id = randomUUID();
      await keep(scope, "suggestion", { id, agent, suggestion });
      return { kept: true, id };
    },

    released: (scope, release) => keep(scope, "released", { release }),

    ended: (scope, outcome) => keep(scope, "ended", { outcome }),

    job: (scope, job) => keep(scope, "job", { job }),
  };
}

/**
 * Puts back what the journal of a turn says agents wrote there, of the writes `which` picks: each
 * file as it was before the first of them, unless someone changed it after the last, when it is kept.
 */
export async function putBack(site: Site, fileSerial: Serial, scope: Scope, turn: string, which: (line: JournalLine) => boolean): Promise<{ restored: string[]; kept: string[] }> {
  const restored: string[] = [];
  const kept: string[] = [];
  const journal = journalPath(site, scope.chat, turn);
  const writes = new Map<string, { before: string | null; after: string | null }>();
  for (const [i, raw] of (await readLines(journal)).entries()) {
    const line = journalLine(`${journal} line ${i + 1}`, raw);
    if (!which(line)) continue;
    const seen = writes.get(line.path);
    if (seen === undefined) writes.set(line.path, { before: line.before, after: line.after });
    else seen.after = line.after;
  }
  const loc = await site.location(scope);
  for (const [path, w] of writes) {
    const lookup = await locate(loc, path);
    if (!lookup.ok) {
      kept.push(path);
      continue;
    }
    const at = lookup.at;
    const done = await fileSerial.run(at.disk, async () => {
      const now = at.is === "file" ? sha256(await readFile(at.disk)) : null;
      if (now !== w.after) return false;
      if (w.before === null) await rm(at.disk, { force: true });
      else await writeWhole(at.disk, w.before);
      return true;
    });
    (done ? restored : kept).push(path);
  }
  return { restored, kept };
}
