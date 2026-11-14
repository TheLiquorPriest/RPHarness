// What RPH tells the folder host (Appendix A `TurnEvents`), kept as lines of
// `host/chats/<chat>/events.jsonl`. The folder host has no views of its own to attach, so it
// resolves no attachment and only keeps the list. Dropping an agent's writes puts back each file
// that agent wrote this turn, as it was before the agent's first write, unless someone changed the
// file after the agent's last write; such a file is kept, and the record says so.

import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Clock, Scope, TurnEvents } from "../../contract/index";
import type { Serial } from "./disk";
import { readLines, sha256, writeWhole } from "./disk";
import { journalPath } from "./files";
import { journalLine } from "./shape";
import type { Site } from "./site";
import { locate } from "./view";

/** Where a chat's events are kept. */
export function eventsPath(site: Site, chat: string): string {
  return join(site.chatRecords(chat), "events.jsonl");
}

export function folderEvents(site: Site, clock: Clock, fileSerial: Serial): TurnEvents {
  async function keep(scope: Scope, kind: string, fields: Record<string, unknown>): Promise<void> {
    site.check(scope);
    const path = eventsPath(site, scope.chat);
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
      const restored: string[] = [];
      const kept: string[] = [];
      if (scope.turn !== undefined) {
        const journal = journalPath(site, scope.chat, scope.turn);
        const writes = new Map<string, { before: string | null; after: string | null }>();
        for (const [i, raw] of (await readLines(journal)).entries()) {
          const line = journalLine(`${journal} line ${i + 1}`, raw);
          if (line.agent.id !== agent.id) continue;
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
      }
      await keep(scope, "dropStaged", { agent, restored, kept });
    },

    ruleFired: (scope, firing) => keep(scope, "ruleFired", { firing }),

    suggestion: (scope, agent, suggestion) => keep(scope, "suggestion", { agent, suggestion }),

    released: (scope, release) => keep(scope, "released", { release }),

    ended: (scope, outcome) => keep(scope, "ended", { outcome }),
  };
}
