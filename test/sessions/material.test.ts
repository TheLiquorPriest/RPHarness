// What the summary call is sent and what the lead carries are laid out by the same part, the carried
// part, from fields that tell the two apart (`compacting`, set for the summary call alone): a user who
// rewords one for its reader leaves the other as it was.
import { afterEach, expect, test } from "bun:test";
import { type Stage, stage } from "../harness/support";
import { carried, material, play, played, S1, said } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CARRIED = `---
description: Fixture - the carried part, worded for each reader.
record: output/record.md
---
{{^compacting}}FIXTURE-FOR-THE-LEAD{{/compacting}}{{#compacting}}FIXTURE-FOR-THE-SUMMARY{{/compacting}}
{{#summary}}{{summary}}{{/summary}}
{{#turns}}{{#items}}{{#intent}}{{intent}}{{/intent}}{{/items}}{{/turns}}
`;

test("the carried part words the summary call's material and the lead's block apart, by the compacting field", async () => {
  const s = (open = await stage({ config: "compaction:\n  keepTurns: 2\n", files: { ".prompts/carried.md": CARRIED }, answers: [played(1), played(2), played(3), said("Fixture summary."), played(4)] }));
  await play(s, ["t1", "t2", "t3"]);
  await s.harness.sessions!.compact(S1);
  await play(s, ["t4"], "t3");

  const [, , , summary, four] = s.model.requests;
  expect(material(summary!)).toContain("FIXTURE-FOR-THE-SUMMARY");
  expect(material(summary!)).not.toContain("FIXTURE-FOR-THE-LEAD");
  expect(carried(four!)).toContain("FIXTURE-FOR-THE-LEAD");
  expect(carried(four!)).not.toContain("FIXTURE-FOR-THE-SUMMARY");
});
