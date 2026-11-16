// His hooks in a turn (§5.4 "Hooks"): a hook before a tool that blocks with its exit code makes its
// stderr the call's answer, the tool never runs; a run-end hook that blocks gives the lead one more
// call with its reason. Both are switched on by the host and traced. Everything here is invented.
import { expect, test } from "bun:test";
import type { SwitchesPort } from "../../src/contract";
import { request, said, stage, textOf } from "./support";

const LEAD = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [ledger_write]\ngiven: [prompt:*]\n---\nFixture lead: you run the turn.\n";
const HOOKS = "before-tool:\n  - name: sourced\n    command: printf 'No source was given.' >&2; exit 2\nrun-end:\n  - name: epilogue\n    command: echo '{\"decision\":\"block\",\"reason\":\"Write the epilogue.\"}'\n";
/** The host's registry: every hook switched on. */
const ON: SwitchesPort = { state: async (_user, thing) => (thing.kind === "hook" ? "on" : "off") };

test("a hook before a tool blocks it with its reason; a run-end hook gives the lead one more call", async () => {
  const ran: string[] = [];
  const s = await stage({
    files: { ".agents/lead.md": LEAD, ".hooks/hooks.yml": HOOKS },
    switches: ON,
    tools: { ledger_write: { tier: "write", lane: "ledger", description: "Fixture: writes the ledger.", run: async () => (ran.push("ledger_write"), said("written")) } },
    answers: [{ pieces: [{ call: "ledger_write", args: {}, id: "w-1" }] }, { pieces: [{ text: "<reply>The ledger waits.</reply>" }] }, { pieces: [{ text: "The epilogue." }] }],
  });
  const { outcome } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome.status).toBe("released");
  expect(ran).toEqual([]);
  const answered = s.model.requests[1]!.messages.find((message) => message.role === "toolResult");
  expect(answered === undefined ? "" : textOf(answered)).toBe("No source was given.");
  expect(textOf(s.model.requests[2]!.messages.at(-1)!)).toBe("Write the epilogue.");
  expect(s.trace.of("hook").map((record) => [record.event.hook, record.event.on, record.event.outcome])).toEqual([
    ["sourced", "before-tool", "blocked"],
    ["epilogue", "run-end", "blocked"],
  ]);
});

test("a before-release hook keeps back a tag-form reply that breaks his rule: nothing reaches the sink, the lead gets the reason and writes again", async () => {
  const lead = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ngiven: [prompt:*]\n---\nFixture lead: you run the turn.\n";
  const hooks = "before-release:\n  - name: valley-rule\n    command: grep -q wyrm && { printf 'No wyrms in this valley.' >&2; exit 2; }; exit 0\n";
  const s = await stage({
    files: { ".agents/lead.md": lead, ".hooks/hooks.yml": hooks },
    switches: ON,
    answers: [{ pieces: [{ text: "<reply>A wyrm circles the mill.</reply>" }] }, { pieces: [{ text: "<reply>A heron circles the mill.</reply>" }] }],
  });
  const { outcome, sink } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome.status).toBe("released");
  expect(sink.text).toBe("A heron circles the mill.");
  expect(textOf(s.model.requests[1]!.messages.at(-1)!)).toBe("No wyrms in this valley.");
  expect(s.trace.of("hook").map((record) => record.event.outcome)).toEqual(["blocked", "ok"]);
});
