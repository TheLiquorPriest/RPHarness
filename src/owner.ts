// The members of the harness's API that only the owner's own presses may call (C-5, C-19, C-24):
// every one that acts on a run, a job or a session on his word: pause or say something to a run,
// start or answer a job, compact a session, close one himself and take that back, make an agent's
// opening block afresh (Apply now). His presses are a host's route, or the folder host's command
// line; no agent's tool, rule, hook or job reaches one, and no code starts a job or acts for him
// (§13.5: "Nothing starts a job but an agent's `job_start` or you. Code does not"). The list is
// exported from the helpers module, and both repositories' tests read it: RPH's own checks that no
// source of it but the folder host's command line calls a member of it, and that each is a member
// of the harness; RPE's checks the same of its sources. It is typed against the contract, so a
// member renamed there fails the typecheck here, and a member of the list that is gone fails the
// tests. Each member joins the list in the package that makes it.
//
// An entry is `<harness member>.<name>`, or, where only one form of a call is the owner's,
// `<harness member>.<name> <field>:<value>`: a call of that member whose last argument gives that
// field that value (`sessions.close by:user`, his own close, S-3; the host's own close and a turn's
// stay the host's turn lane's to call).
import type { DefinitionsApi, JobsApi, LiveApi, ModelsApi, RulesApi, SessionsApi } from "./contract";

/** The owner-only members, by the member of the harness they are on. */
const MEMBERS = {
  live: ["pause", "letGo", "say"],
  definitions: ["apply"],
  jobs: ["start", "cancel", "setSwitches", "hold", "letGo", "again", "carryOn", "resume", "answer"],
  sessions: ["compact", "reopen", "uncompact"],
  models: ["save", "setToolSecret"],
  rules: ["switch"],
} as const satisfies { live: readonly (keyof LiveApi)[]; definitions: readonly (keyof DefinitionsApi)[]; jobs: readonly (keyof JobsApi)[]; sessions: readonly (keyof SessionsApi)[]; models: readonly (keyof ModelsApi)[]; rules: readonly (keyof RulesApi)[] };

/** The calls that are the owner's in one form only: the member, and the field and value of its last argument that make a call of it his. */
const FORMS = [{ api: "sessions", name: "close", field: "by", value: "user" }] as const satisfies readonly { api: "sessions"; name: keyof SessionsApi; field: keyof NonNullable<Parameters<SessionsApi["close"]>[1]>; value: NonNullable<Parameters<SessionsApi["close"]>[1]>["by"] }[];

/** Each owner-only member as `<harness member>.<name>` (`jobs.start`), or with the form of its call that is his (`sessions.close by:user`): the one list both repositories' call-site tests read. */
export const OWNER_ONLY: readonly string[] = Object.freeze([...Object.entries(MEMBERS).flatMap(([api, names]) => names.map((name) => `${api}.${name}`)), ...FORMS.map((form) => `${form.api}.${form.name} ${form.field}:${form.value}`)]);
