// The members of the harness's API that only the owner's own presses may call (C-5, C-19, C-24):
// every one that acts on a run, a job or a session on his word. His presses are a host's route, or
// the folder host's command line; no agent's tool, rule, hook or job reaches one, and no code starts
// a job or acts for him (§13.5: "Nothing starts a job but an agent's `job_start` or you. Code does
// not"). The list is exported from the helpers module, and both repositories' tests read it: RPH's
// own checks that no source of it but the folder host's command line calls a member of it, and that
// each is a member of the harness; RPE's checks the same of its sources. It is typed against the
// contract, so a member renamed there fails the typecheck here, and a member of the list that is
// gone fails the tests. Each member joins the list in the package that makes it.
import type { JobsApi, LiveApi, SessionsApi } from "./contract";

/** The owner-only members, by the member of the harness they are on. */
const MEMBERS = {
  live: ["pause", "letGo", "say"],
  jobs: ["start", "cancel", "setSwitches", "hold", "letGo", "again", "answer"],
  sessions: ["compact"],
} as const satisfies { live: readonly (keyof LiveApi)[]; jobs: readonly (keyof JobsApi)[]; sessions: readonly (keyof SessionsApi)[] };

/** Each owner-only member as `<harness member>.<name>` (`jobs.start`): the one list both repositories' call-site tests read. */
export const OWNER_ONLY: readonly string[] = Object.freeze(Object.entries(MEMBERS).flatMap(([api, names]) => names.map((name) => `${api}.${name}`)));
