// The user's permissions per lane (§6.8 l.765): `host/permissions.json` gives each lane Auto,
// Confirm or Never, by chat, `*` for every chat (and for a job of no chat), a chat's own entry first:
//
//   { "*": { "world": "confirm", "external": "never" }, "<chat>": { "world": "auto" } }
//
// A lane it names nowhere is Auto (Appendix D.1). A Confirm is asked by writing the call to
// `asks/<call>.json` in the chat's records (the host's own folder for a run of no chat); the host's
// own way of asking (its command line, `rph-folder answer`, or a test) writes `answers/<call>.json`
// beside it, `{ "go": true }` or `{ "go": false, "reason": "…" }`, which is read as it comes. A wait
// the run ends takes the question down.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalAnswer, ApprovalsPort, LanePermission, RunScope } from "../../contract/index";
import { isRecord } from "../../contract/json";
import { readJson, safeId, writeJson } from "./disk";
import type { Site } from "./site";

/** How often an answer is looked for. */
const LOOK_MS = 100;

const PERMISSIONS: readonly LanePermission[] = ["auto", "confirm", "never"];

/** The folder a run's questions are asked in: its chat's records, or the host's own for a run of no chat; the scope checked first. */
export function asksBase(site: Site, scope: RunScope): string {
  if (scope.chat === undefined) {
    site.serves(scope);
    return site.host;
  }
  site.check(scope);
  return site.chatRecords(scope.chat);
}

export function folderApprovals(site: Site): ApprovalsPort {
  return {
    async permission(scope, lane) {
      asksBase(site, scope);
      const raw: unknown = await readJson(join(site.host, "permissions.json"));
      if (!isRecord(raw)) return "auto";
      for (const key of scope.chat === undefined ? ["*"] : [scope.chat, "*"]) {
        const lanes = raw[key];
        const set = isRecord(lanes) ? lanes[lane] : undefined;
        const found = PERMISSIONS.find((p) => p === set);
        if (found !== undefined) return found;
      }
      return "auto";
    },

    async ask(scope, ask, signal) {
      const base = asksBase(site, scope);
      const name = `${safeId("call", ask.callId)}.json`;
      const asked = join(base, "asks", name);
      const answered = join(base, "answers", name);
      await mkdir(join(base, "answers"), { recursive: true });
      await writeJson(asked, ask);
      try {
        for (;;) {
          if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The question was taken down.");
          const raw: unknown = await readJson(answered);
          if (isRecord(raw) && typeof raw.go === "boolean") {
            await rm(answered, { force: true });
            const answer: ApprovalAnswer = raw.go ? { go: true } : { go: false, ...(typeof raw.reason === "string" && raw.reason.trim() !== "" ? { reason: raw.reason } : {}) };
            return answer;
          }
          await Bun.sleep(LOOK_MS);
        }
      } finally {
        await rm(asked, { force: true });
      }
    },
  };
}
