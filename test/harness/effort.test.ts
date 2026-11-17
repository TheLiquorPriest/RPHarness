// An agent thinks at its definition's `effort:`, or, where it names none, at its connection's own;
// the settings stand over both: `effort.connections.<connection>` over the definition's, and
// `agents.<definition>.effort` over that. `definitions.list` gives what each definition runs on,
// resolved among the user's connections (C28).
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage, USER } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead on a named connection.\nmodel: Floor\neffort: low\ntools: [todo]\ngiven:\n  - prompt:*\n  - briefing\n---\nFixture lead: answer the player.\n";

test("a config that sets `effort.connections` for the agent's connection: the agent runs at it over its definition's effort, and nothing is logged", async () => {
  const s = (open = await stage({ config: "effort:\n  connections:\n    Floor: high\n", files: { ".agents/lead.md": LEAD }, answers: [{ pieces: [{ text: "<reply>The lamp turns.</reply>" }] }] }));
  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  expect(s.model.requests[0]!.options.reasoning).toBe("high");
  expect(s.logged.filter((line) => line.fields?.setting === "effort.connections")).toEqual([]);
});

test("definitions.list gives each definition's resolved connection, model and effort: its own, the default's where it names none, the connection's own effort where it says inherit", async () => {
  const definition = (name: string, header: string): string => `---\nname: ${name}\ndescription: Fixture ${name}.\n${header}---\nFixture ${name}: keep the harbour.\n`;
  const s = (open = await stage({
    files: {
      ".agents/lead.md": LEAD,
      ".agents/scribe.md": definition("scribe", ""),
      ".agents/keeper.md": definition("keeper", "model: Floor\n"),
      ".agents/drifter.md": definition("drifter", "model: Gone\neffort: high\n"),
    },
    answers: [],
  }));
  // The first connection saved is the default.
  const harbour = await s.harness.models.save(USER, { name: "Harbour", provider: "deepseek", auth: "key", model: "harbour-model", effort: "high" }, "sk-harbour-0123456789");
  const floor = await s.harness.models.save(USER, { name: "Floor", provider: "deepseek", auth: "key", model: "floor-model", effort: "medium" }, "sk-floor-0123456789");
  const listed = await s.harness.definitions.list(request("t1").scope);
  const runsOn = Object.fromEntries(listed.filter((d) => ["lead", "scribe", "keeper", "drifter"].includes(d.name)).map((d) => [d.name, d.runsOn]));
  expect(runsOn).toEqual({
    lead: { connection: { id: floor.id, name: "Floor" }, model: "floor-model", effort: "low" },
    scribe: { connection: { id: harbour.id, name: "Harbour" }, model: "harbour-model", effort: "high" },
    keeper: { connection: { id: floor.id, name: "Floor" }, model: "floor-model", effort: "medium" },
    drifter: { connection: null, model: null, effort: "high" },
  });
  // Every definition listed says what it runs on.
  for (const d of listed) expect({ name: d.name, runsOn: d.runsOn !== undefined }).toEqual({ name: d.name, runsOn: true });
});
