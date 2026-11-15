// What fails in a turn before the lead's first word is a code with its data, never a sentence of
// RPH's own (§3.4, Appendix E: code holds no sentence of its own): the host words each from its own
// file. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

test("a lead with no definition in force: the sink's error carries the code and the agent's name, and no sentence", async () => {
  const s = (open = await stage({ answers: [] }));
  const { outcome, sink } = await s.turn(request("t1", { lead: "nobody" }));

  expect(outcome.status).toBe("failed");
  expect(sink.errors).toEqual([{ code: "no-definition", agent: "nobody" }]);
  expect(outcome.error).toEqual({ code: "no-definition", agent: "nobody" });
  expect(s.model.requests).toHaveLength(0);
});

test("a tag form with no tags named by any reply contract in force: the sink's error carries the code and the lead's name, and no sentence", async () => {
  // A contract whose header names no tags.
  const bare = "---\ndescription: Fixture - a contract that names no tags.\nintent_file: scratch/intent.md\n---\nFixture contract.\n";
  const lead = "---\nname: lead\ndescription: Fixture lead.\nmodel: default\ntools: [todo]\n---\nFixture lead.\n";
  const s = (open = await stage({ files: { ".prompts/reply-contract.md": bare, ".agents/lead.md": lead }, answers: [] }));
  const { outcome, sink } = await s.turn(request("t1", { lead: "lead" }));

  expect(outcome.status).toBe("failed");
  expect(sink.errors).toEqual([{ code: "no-tags", agent: "lead" }]);
  expect(s.model.requests).toHaveLength(0);
});
