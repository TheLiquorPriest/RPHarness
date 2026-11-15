// Effort is the definition's alone (READINGS N-7): an agent thinks at its definition's `effort:`, or,
// where it names none, at its connection's own. No setting overrides it: a config that still sets
// `effort.connections` is told in the log as a key no setting has. `definitions.list` gives what each
// definition runs on, resolved among the user's connections (C28).
import { afterEach, expect, test } from "bun:test";
import { request, type Stage, stage, USER } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const LEAD = "---\nname: lead\ndescription: Fixture lead on a named connection.\nmodel: Floor\neffort: low\ntools: [todo]\ngiven:\n  - prompt:*\n  - briefing\n---\nFixture lead: answer the player.\n";

test("a config that sets `effort.connections` is logged as a key no setting has, and the agent runs at its definition's effort", async () => {
  const s = (open = await stage({ config: "effort:\n  connections:\n    Floor: high\n", files: { ".agents/lead.md": LEAD }, answers: [{ pieces: [{ text: "<reply>The lamp turns.</reply>" }] }] }));
  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  expect(s.model.requests[0]!.options.reasoning).toBe("low");
  const passed = s.logged.filter((line) => line.fields?.setting === "effort.connections");
  expect(passed.length).toBeGreaterThan(0);
  expect(passed[0]).toEqual({
    level: "warn",
    message: "A key among the harness's settings names none of them; it is passed over.",
    fields: { setting: "effort.connections", value: { Floor: "high" }, file: "@global/config.yml", why: "effort.connections is no setting the harness reads: an agent thinks at the effort its definition gives, or where it gives none at its connection's own." },
  });
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
