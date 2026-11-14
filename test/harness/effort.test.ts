// The setting `models.effort` (Appendix D.1, per connection): an agent on a connection it names
// thinks at the setting's effort, whatever its definition says; on any other connection, at its
// definition's.
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead on a named connection.\nmodel: Floor\neffort: low\ntools: [todo]\ngiven:\n  - prompt:*\n  - briefing\n---\nFixture lead: answer the player.\n";

async function effortAsked(config?: string): Promise<unknown> {
  const s = (open = await stage({ ...(config !== undefined ? { config } : {}), files: { ".agents/lead.md": LEAD }, answers: [{ pieces: [{ text: "<reply>The lamp turns.</reply>" }] }] }));
  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  const asked = s.model.requests[0]!.options.reasoning;
  await s.close();
  open = undefined;
  return asked;
}

test("an agent on a connection the setting names thinks at the setting's effort; elsewhere, at its definition's", async () => {
  expect(await effortAsked()).toBe("low");
  expect(await effortAsked("models:\n  effort:\n    Floor: high\n")).toBe("high");
  expect(await effortAsked("models:\n  effort:\n    Another: high\n")).toBe("low");
});
