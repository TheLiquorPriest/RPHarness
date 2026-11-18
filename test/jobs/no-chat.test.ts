// A job of no chat (C-23: the Build page's model jobs): started for the user alone, on the shipped
// and global levels with a rule and a hook at the global level, it starts, its job-start hook adds to
// its brief, it makes its first model call and ends; such a scope has no rules to run, and a rule's
// test asked for in it is refused in words. Everything here is invented.
import { expect, test } from "bun:test";
import type { Scope, SwitchesPort } from "../../src/contract";
import { request, stage, textOf, USER } from "../harness/support";
import { jobOf } from "./support";

const KEEPER = "---\nname: keeper\ndescription: Fixture keeper of the tower's records.\nmodel: default\ntools: [todo]\n---\nFixture keeper: you count what you are asked to count.\n";
const RULE = "---\ndescription: Fixture - a reminder on counting.\nagents: all\nscope: [text]\ncondition: bells\n---\nFixture rule: count twice.\n";
const HOOKS = "job-start:\n  - name: stamp\n    command: echo '{\"context\":\"Fixture stamp, the tower is shut on Sundays.\"}'\n";
const ON: SwitchesPort = { state: async (_user, thing) => (thing.kind === "hook" ? "on" : "off") };

test("a job of no chat starts, reaches its first model call and ends; a rule's test with no chat is refused in words", async () => {
  const s = await stage({ files: { ".agents/keeper.md": KEEPER, ".rules/fixture-count.md": RULE, ".hooks/hooks.yml": HOOKS }, switches: ON, answers: [{ pieces: [{ text: "Seven bells." }] }] });

  const job = jobOf(await s.harness.jobs.start({ user: USER }, { agent: "keeper", brief: "Count the bells." }));
  expect(job.scope.chat).toBeUndefined();
  await s.trace.seen(() => s.trace.of("job").some((record) => record.event.job.state === "done"));

  expect(await s.harness.jobs.get(USER, job.id)).toMatchObject({ state: "done", report: "Seven bells." });
  expect(s.model.requests).toHaveLength(1);
  expect(s.model.requests[0]!.messages.map(textOf).join("\n")).toContain("Fixture stamp, the tower is shut on Sundays.");
  expect(s.trace.of("hook").map((record) => [record.event.hook, record.event.on, record.event.outcome])).toEqual([["stamp", "job-start", "added"]]);
  // The rule at the global level is in force for a chat, but a scope of no chat has none to run.
  expect((await s.harness.rules.list(request("t1").scope)).find((rule) => rule.name === "fixture-count")?.inForce).toBe(true);
  expect(s.trace.of("rule_fired")).toEqual([]);

  const noChat = { user: USER, session: job.scope.session } as unknown as Scope;
  await expect(s.harness.rules.test(noChat, "fixture-count", "t1")).rejects.toThrow("A rule is tested against a turn of a chat");
});
